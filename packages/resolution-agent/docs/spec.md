# Service specification

## Event-resolution pipeline

```text
leased job
  -> scoped input and artifacts
  -> deterministic evidence preparation (lossless index)
  -> deterministic Event Content Bundle v2 baseline
  -> HTML hydration cap
  -> deterministic evidence compaction
  -> Anime Knowledge Service
  -> schema validation
  -> one review Candidate
```

The lease also carries `resolutionMode`. `AUTO` preserves the resilient deterministic fallback. `LLM_REQUIRED` is used for an explicit editorial retry over already-stored evidence and turns missing/failed knowledge inference into a visible resolution-job failure.

Before baseline creation, the Agent calls `prepareResolutionEvidence` and `applyPreparedEvidence` from `@kita/evidence-pipeline`. The `Prepared run evidence` log contains the version, stable input hash, input/prepared/removed counts, and conflict count. This stage does not consume model tokens. The later compactor remains intentionally lossy and prompt-budgeted; it is not the source of the downloadable archive.

## Evidence-compaction input

The compactor receives every lease-authorized `ResolutionDocument`, including document metadata, assertions, chunks, crawler media signals, and hydrated HTML text. It does not fetch URLs itself and cannot access another crawl run.

## Normalization and deduplication

### Assertions

- Global key: normalized `fieldPath + (normalizedValue ?? value)`.
- Unicode, case, whitespace, punctuation, and tracking URL noise are normalized for comparison.
- For equivalent assertions, retain the copy with the highest combined field/page/confidence score.
- Different normalized values for the same field are distinct candidates and remain eligible, preserving date/location/title conflicts.
- Long untrusted strings, arrays, and objects are structurally bounded before prompt construction.

### Chunks

- Collapse whitespace and normalize Unicode/case/punctuation for the deduplication key.
- Keep at most 6,000 source characters per selected chunk.
- Prefer official event/overview/about/schedule/guest pages and text containing date, location, guest, panel, anime, manga, sponsor, or exhibitor signals.

### Media

- Canonicalize URLs by removing fragments, tracking/resize query parameters, and common responsive-image filename dimensions.
- Drop obvious icon, navigation, search, arrow, favicon, and social assets.
- For equivalent media, prefer higher crawler score and then larger known pixel area.
- Rank hero/banner/poster/logo categories above generic media and pre-cap the unique candidate set at 40.

### Raw HTML text

- Strip scripts, styles, tags, and repeated whitespace during hydration.
- Never include full text when the document already has assertions or chunks.
- For a document with no structured evidence, admit at most 4,000 fallback characters.

## Ranking and packing

Items use deterministic numeric scores; no model call is permitted. Assertions rank above chunks, which rank above media and fallback raw text. Within a category, core event fields, crawler confidence, page type, content signals, media role, and media quality determine order.

Starting with crawl metadata, add ranked items one by one. Array-valued structured assertions are first split into independently ranked records, so a large schedule/exhibitor assertion cannot crowd out every structured item. After each addition, use the shared conservative estimator against the serialized evidence object. Reject an item that would exceed the adaptive evidence budget and continue considering smaller/lower-ranked items.

The complete deterministic V2 bundle is retained by the Agent, while a valid bounded baseline projection is prepared for inference. The projection keeps core event data and greedily admits shortened structured records into at most 35% of the complete prompt budget, capped at 8,000 estimated tokens. The Agent subtracts the projected baseline and a 7,000-token instruction/knowledge reserve from the Knowledge Service's 24k budget. It fails explicitly if less than 1,000 tokens remain instead of applying a misleading minimum evidence budget. The default evidence maximum remains 15,000 tokens.

The estimator charges JSON punctuation, mixed English/CJK characters, and chat framing conservatively. It is deterministic but not a replacement for the provider's tokenizer.

## Output and observability

The Knowledge Service receives only:

```json
{
  "baseline": "event-content-bundle/v2",
  "evidence": {
    "crawlRun": {},
    "documents": [
      {
        "id": "source document UUID",
        "url": "canonical source URL",
        "title": "source title",
        "pageType": "EVENT",
        "assertions": [],
        "chunks": [],
        "rawText": "fallback only",
        "media": []
      }
    ]
  }
}
```

The `Compacted event context` log includes separate `baseline` and `evidence` sections:

- complete prompt budget, reserved tokens, source baseline tokens, projected baseline tokens, and evidence token counts;
- source counts;
- globally unique counts;
- selected counts;
- dropped counts;
- document, assertion, chunk, media, and fallback-text breakdowns.

Full source evidence remains stored in KitaCon and is still attached to the review Candidate. Compaction affects inference input only.

## Structured content baseline

The crawler emits arrays under `content.links`, `content.facts`, `content.ticket_offers`, `content.exhibitors`, `content.sessions`, `content.guests`, and `content.updates`. The Agent validates, deduplicates by stable external key, maps page text to bounded enums, and derives `activities` from sessions and exhibitors. Every record receives its source document ID and crawler confidence before any model call.

After knowledge resolution, every deterministic collection is merged with the returned collection by external key (or canonical URL/key). Records excluded from the prompt projection are therefore restored without asking the model to reproduce them. This makes the model an enrichment and relationship layer rather than the sole record generator.

## Invariants

- Selected document IDs always came from the leased run.
- Source quotes and values are never LLM-summarized during compaction.
- Equivalent duplication may be removed; materially different field values are not merged.
- Compacted evidence never exceeds the configured Agent budget according to the shared estimator.
- The prompt baseline never exceeds its derived 2k–8k projection budget; the full baseline remains available for post-inference restoration.
- Knowledge Service performs a second complete-prompt budget check after adding baseline and Bangumi data.
