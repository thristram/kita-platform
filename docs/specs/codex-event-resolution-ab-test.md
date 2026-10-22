# Codex Event Resolution A/B Workflow

Status: implemented first release
Last updated: 2026-10-08

## Purpose

This workflow compares the local Resolution Agent with a human-operated Codex run over the same immutable crawl evidence. It is an editorial experiment, not a second crawler and not an automatic publishing path.

The experiment answers two questions:

1. Can a larger model recover a substantially more complete schedule, exhibitor/guest/ticket/update set, and relationship graph than the local model?
2. Can that result be reviewed and materialized without losing crawler provenance or overwriting the original automated result?

## End-to-end flow

```text
completed crawl run
  -> evidence-preparation/v1
  -> aggregate EVENT_RESOLUTION Candidate
  -> Export lossless Bundle v2 (ZIP)
  -> upload ZIP to local Codex + use PROMPT.md + read-only Bangumi MCP
  -> Codex returns one event-content-bundle/v2 JSON object
  -> Import JSON into the Candidate editor
  -> edit/review the Candidate tabs
  -> create a REVIEW Event or link an existing Event
```

The imported JSON is stored as a new review-draft revision. The crawler documents, assertions, media candidates, and original deterministic/LLM result remain immutable.

## Operator workflow

### Existing Candidate

1. Open `/candidates/:candidateId/overview`.
2. Choose **Export raw bundle**.
3. Upload the downloaded ZIP to Codex.
4. Paste the included `PROMPT.md` into Codex. A repository copy is also available at [`../prompts/codex-event-resolution.md`](../prompts/codex-event-resolution.md).
   For verified Bangumi identities, connect the [read-only local MCP](../../packages/anime-knowledge-service/docs/mcp.md) first. It uses the Knowledge Service's active snapshot, not the local event-resolution model.
5. Save Codex's JSON-only response as `event-bundle.json`.
6. Choose **Import JSON** in the Candidate toolbar and upload the file or paste its contents.
7. Review Overview, Schedule, Exhibitors, Related Fandoms, and Updates. Make any section-level edits.
8. Choose **Create Review Event** or **Choose existing event**.

For a fair comparison, record the MCP `knowledgeVersion` and compare both branches against the same Archive snapshot. The MCP provides possible subject/person identities only. It cannot establish that they participate in this Event; crawler source documents must support that claim. Character and company canonical search are not currently provided, so their IDs must not be guessed.

### New manual Event linked to an existing Source

1. Open `/events` and choose **Create event**, or open `/events/new` directly.
2. Select an existing Source with a completed or partial crawl.
3. Enter the Event name.
4. Optionally upload/paste a complete Event Content Bundle immediately.
5. Continue to the same Candidate-style staged editor used by crawler-generated Candidates.
6. Review and create/link the canonical Event.

A manual draft is deliberately represented as a `PENDING EVENT_RESOLUTION` Candidate. This keeps one editor, one validation contract, one audit trail, and one materialization path.

## Export package contract

`GET /api/candidates/:id/export` returns a private, non-cacheable ZIP named `<event>-candidate-evidence.zip`.

| File | Contents |
| --- | --- |
| `README.md` | Operator instructions and lossless/prepared-data boundary |
| `PROMPT.md` | Ready-to-use Codex task prompt |
| `manifest.json` | Candidate, Source, crawl-run, document metadata, and document-file mapping |
| `event-bundle.schema.json` | Machine-readable JSON Schema generated from the runtime Zod contract |
| `prepared/summary.json` | Deduplicated documents, assertions, chunks, media, provenance, statistics, and warnings |
| `prepared/collections.json` | Merged schedule, exhibitor, guest, update, link, fact, and ticket records keyed by assertion field |
| `prepared/conflicts.json` | Competing scalar values with every supporting RawDocument ID |
| `structured/assertions.json` | Every assertion associated with Candidate evidence documents |
| `structured/chunks.json` | Every stored structural text chunk in the Candidate scope |
| `structured/media.json` | Every media candidate, URL, category, dimensions, hashes, classification signals, and storage status |
| `resolution/original-result.json` | Original model/deterministic payload, metrics, warnings, and any existing review metadata |
| `documents/*` | Byte-for-byte raw HTML/JSON/PDF/text artifacts from the Candidate's evidence set |

The ZIP is intentionally lossless while its recommended reading path is selective. Codex starts with `prepared/*`; it opens `documents/*` only for missing fields, reported conflicts, or exact provenance checks. This reduces input tokens without trusting a lossy model summary.

Media binary objects are not duplicated into the first-release ZIP. `structured/media.json` contains their crawler IDs, source URLs, object status, dimensions, hashes, and classification metadata. This keeps a large crawl upload practical while still allowing the returned JSON to reference only valid `mediaCandidateId` values. A later opt-in media-binary export can be added without changing the Event Bundle contract.

The server reads private artifacts with its configured local/R2 credentials and streams only the resulting download to the authenticated operator. Bucket keys and storage credentials are not exposed in `manifest.json`. Artifact reads run with bounded concurrency; an unavailable object produces a matching `.unavailable.txt` entry instead of invalidating the whole export.

## Output JSON contract

Codex must return exactly one JSON object conforming to `event-content-bundle/v2`.

The bundle contains:

- `event`: name, aliases, type, description, exact dates/timezone, venue, official URL, and organizers.
- `links`, `facts`, and `ticketOffers`: public utility and sourced quick facts.
- `sessions`: one record per schedule item, including time, room, organizations, anime/person targets, tags, and image selection.
- `exhibitors`: company/creator/vendor identity, booth, categories, description, site, organization names, and logo.
- `guests`: people, roles, company affiliations, anime relationships, and images.
- `updates`: official announcements with time, category, source, and image.
- `activities`: cross-cutting public cards such as booths, panels, cosplay gatherings, screenings, merch drops, meetups, guest appearances, concerts, signings, and workshops.
- `relatedSubjects`: Bangumi-backed anime/manga/fandom records.
- `relations`: evidence-backed event-to-Bangumi relationships.
- `media`, `evidence`, `conflicts`, `warnings`, and bundle-level `confidence`.

Company relationships are represented by `event.organizerNames`, exhibitor records, and the `organizationNames` fields on sessions, guests, and activities. Person relationships are represented by guests and `personTarget(s)`. Anime/manga/character relationships use Bangumi canonical references in `relatedSubjects`, `subjectTargets`, `personTargets`, and `relations`.

Engagement values such as going/interested/saved/follower counts are never generated from crawler evidence or by Codex.

## Import and override semantics

`POST /api/candidates/:id/import` accepts:

```json
{
  "filename": "event-bundle.json",
  "bundle": {
    "schemaVersion": "event-content-bundle/v2"
  }
}
```

Before writing, the API:

1. validates the complete runtime schema;
2. verifies the legacy Bangumi encoded-ID transform;
3. rejects malformed URLs and unsupported enums;
4. rejects every `sourceDocumentId` not in this Candidate's evidence scope;
5. rejects materialized, rejected, or otherwise non-pending Candidates.

Success stores:

```json
{
  "review": {
    "draftBundle": "validated bundle",
    "draftRevision": 2,
    "draftSavedAt": "ISO timestamp",
    "importedAt": "ISO timestamp",
    "importFilename": "event-bundle.json",
    "importFormat": "event-content-bundle/v2"
  }
}
```

The effective Candidate switches to the `Manual JSON override` processing badge. Materialization prefers this draft over `payload.result`; the original result remains available in the export and More info/provenance surfaces.

## Manual Candidate API

`POST /api/candidates/manual`

Input without an initial bundle:

```json
{
  "sourceId": "source-uuid",
  "name": "WasabiCon 2026"
}
```

Input with a Codex result:

```json
{
  "sourceId": "source-uuid",
  "name": "WasabiCon 2026",
  "bundle": { "schemaVersion": "event-content-bundle/v2" }
}
```

The Source must exist and have a completed or partial crawl containing at least one RawDocument. The new Candidate receives every RawDocument from the latest eligible run as evidence and opens at `/candidates/:candidateId/overview`.

Success:

```json
{ "candidateId": "candidate-uuid" }
```

## Failure behavior

| Status | Meaning |
| --- | --- |
| `400` | Invalid Candidate ID, request JSON, or Event Bundle schema |
| `404` | Candidate or Source does not exist |
| `409` | Candidate is no longer pending/editable |
| `422` | Source has no eligible crawl or JSON references evidence outside the allowed scope |
| `500` | Unexpected database or artifact-export failure |

An export does not mutate data. A failed import does not partially update the Candidate.

## Acceptance criteria

- WasabiCon-sized Candidates can export all scoped raw documents and structured evidence as one valid ZIP.
- Export identifies itself as `candidate-evidence-bundle/v2` and includes the `evidence-preparation/v1` input hash and statistics.
- The ZIP contains its own prompt and exact runtime JSON Schema.
- Imported JSON never changes `payload.result` and increments `review.draftRevision` atomically.
- Unknown document IDs and invalid Bangumi encoded IDs are rejected.
- Manual Event creation requires an existing Source and reuses the Candidate editor and review materialization path.
- Both top-level and Events-page **Create event** actions open `/events/new`.
- No crawler recrawl or local Resolution Agent run is required for the Codex branch of the A/B test.
