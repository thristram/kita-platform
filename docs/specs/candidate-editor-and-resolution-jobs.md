# Candidate Event Editor and Resolution Jobs specification

Status: implemented first release
Last updated: 2026-10-08

## Problem

Crawler output is evidence, not a page-shaped Event. A single crawl can produce many documents and hundreds of assertions, but an editor must review one aggregate Event candidate that resembles the public Event experience. The operator also needs to know whether resolution used the local LLM and Bangumi knowledge base, and must be able to retry a deterministic result without crawling again.

Crawler execution and semantic resolution have different workers, failure modes, metrics, and operational owners. They must not share one queue screen.

## Goals

- Present each aggregate `EVENT_RESOLUTION` Candidate as an editable Event preview.
- Reuse the public Event information architecture: Overview, Schedule, Exhibitors, Related Fandoms, and Updates.
- Use view-first, section-level editing: fields read like the final page until a pencil action opens an editor.
- Persist human edits before materialization and never overwrite the immutable model result.
- Keep field provenance human-readable and available on demand.
- Make deterministic, fallback, and LLM+KB processing visibly distinct.
- Allow a pending deterministic Candidate to enqueue an LLM-required re-resolution from the same crawl evidence.
- Allow an operator to export the complete crawl-evidence scope for a Codex A/B run and import a schema-validated JSON result as a review draft.
- Allow a Source-backed manual Event draft to reuse this editor and materialization pipeline.
- Manage crawler work and resolution work on separate stable routes.

## Non-goals

- Candidate edits do not directly publish consumer content.
- The editor does not mutate raw documents, assertions, or the original `payload.result`.
- This release does not merge two crawl runs into one Candidate.
- Theme preference is still browser-local until `thristram-auth` is connected.

## Routes

| Route | Purpose |
| --- | --- |
| `/candidates` | Searchable aggregate Candidate queue |
| `/candidates/:id/overview` | Core Event, venue, organizer, facts, links, tickets |
| `/candidates/:id/schedule` | Sessions and schedule editing |
| `/candidates/:id/exhibitors` | Exhibitor editing |
| `/candidates/:id/fandoms` | Bangumi-backed related subjects |
| `/candidates/:id/updates` | Source updates and announcements |
| `/events/new` | Create a Source-backed manual Candidate and continue in the staged Event editor |
| `/crawl-jobs` | URL fetch, extraction, and media-fetch operations only |
| `/resolution-jobs` | `EVENT_RESOLUTION` agent work only |

`/candidates/:id` redirects to the Overview tab. Every tab is refreshable, linkable, and browser-history-safe.

## Candidate state model

```text
Crawl complete -> Evidence prepared -> Processed -> Editorial review -> Published
                                         |             |
                                         |             +-> rejected
                                         +-> deterministic result -> LLM-required retry -> new resolution Candidate
```

The progress component is a projection, not a new database enum. Durable state remains in `crawl_run`, `job`, and `candidate`.

- `Crawl complete`: the referenced crawl run has stored rendered/raw documents and captured APIs.
- `Evidence prepared`: deterministic `evidence-preparation/v1` grouped duplicates, merged collections, retained provenance, and reported conflicts before resolution.
- `Processed`: Candidate contains a schema-valid Event Content Bundle v2. Its sublabel is `LLM + KB`, `Deterministic fallback`, or `Deterministic only`.
- `Editorial review`: Candidate is `PENDING` and has no `published_event_id`.
- `Published`: Candidate is `APPROVED` and references a canonical Event; the current editorial action first creates it in `REVIEW` status.

Completed steps use bold colored text and a filled step icon. Step labels never receive a background fill; warning color is reserved for deterministic fallback/only processing.

## Processing modes

| Badge | Meaning |
| --- | --- |
| `LLM + KB` | Anime Knowledge Service returned a validated bundle |
| `Deterministic fallback` | An LLM/knowledge request failed and the deterministic baseline was retained |
| `Deterministic only` | No knowledge service was used |
| `Manual draft` | Operator started a Source-backed Event draft without a model result |
| `Manual JSON override` | A complete external/Codex bundle is the effective review draft |

The default-collapsed **More info** section includes model provider/name, prompt version, input/output tokens, duration, crawl run, source-document count, warnings, current draft revision, and last review failure where present.

## Editing and storage

The original completion remains under:

```json
{
  "result": "immutable Event Content Bundle v2",
  "model": {},
  "metrics": {}
}
```

Human edits are written to:

```json
{
  "review": {
    "draftBundle": "validated Event Content Bundle v2",
    "draftRevision": 3,
    "draftSavedAt": "2026-10-08T00:00:00.000Z",
    "lastFailure": null
  }
}
```

Every save validates the complete bundle with `eventBundleSchema`. Materialization and linking read `review.draftBundle` first and fall back to the original `result`. The original output and raw evidence remain unchanged for audit and comparison.

An imported Codex bundle uses the same storage location and increments the same draft revision, while adding `importedAt`, `importFilename`, and `importFormat`. It is an override of the effective resolution, not a destructive replacement of `payload.result`.

Editable sections cover:

- Event name, aliases, type, description, dates, timezone, official URL, organizers, and venue fields.
- Official/schedule/ticket links, sourced facts, and ticket offers.
- Session title/type/description/time/venue/room/rating/organizations/tags.
- Exhibitor name/description/booth/categories/featured state/website/organizations.
- Related-subject label/description/featured state/Bangumi entity type and raw ID. Encoded IDs use the legacy `uniqueIdHelper` compatibility transform.
- Update title/summary/date/category/source name/source URL.
- Event hero, session image, exhibitor logo/image, and update image selected from crawl-scoped media evidence. Clearing a selection uses automatic default artwork.

The Candidate queue exposes separate sortable **Stage** and **Method** columns. The Stage cell shows the projected five-step progress; Method carries the provenance badge. Every header is keyboard-accessible and sortable, and the final arrow button is the only row navigation action.

## Media selection

The image picker is event scoped: it reads `media[]` returned by `GET /api/candidates/:id`, supports search and classification-tag filters, shows dimensions and previews, and writes only valid `media_candidate` UUIDs into the draft. Hero assignment is represented by one `bundle.media` row with role `EVENT_HERO`; session, exhibitor, and update assignments use their typed media-candidate fields.

The automatic-default tile clears the explicit ID so the consumer layer can apply its default art. Persisted custom editorial tags and a global default-art catalog are a later media-schema/API feature; the Console does not store fake UUIDs or browser-only tag state.

## Evidence UX

The main editor never exposes raw JSON. **Source evidence** opens a drawer grouped by human-readable field name. Each group shows confidence, locator, and excerpt. Source chunks and media remain available in collapsed technical sections. Evidence records are not modified by editorial changes.

## APIs

### Read Candidate

`GET /api/candidates/:id`

Returns summary, processing metadata, effective `bundle`, draft revision/timestamp, source evidence, media, and searchable existing Events.

### Save Candidate draft

`PUT /api/candidates/:id/draft`

The editor waits for this request to succeed before closing. If validation or persistence fails, the modal stays open and shows a persistent error; validation messages include the failing bundle field path. Successful saves return an incremented revision and timestamp, which the editor displays. Array-valued fields such as organizations, tags, and categories are populated when an item is reopened. PostgreSQL parameters inside `jsonb_build_object` are explicitly typed so draft/import timestamps can be persisted through the Neon driver.

Only pending, unlinked Candidates are editable. Approved or superseded Candidates are visibly read-only; an approved Candidate links to its canonical Event, where subsequent edits belong.

Input:

```json
{ "bundle": { "schemaVersion": "event-content-bundle/v2" } }
```

Output:

```json
{
  "bundle": { "schemaVersion": "event-content-bundle/v2" },
  "revision": 2,
  "savedAt": "2026-10-08T00:00:00.000Z"
}
```

Only an unmaterialized `PENDING` Candidate can be saved.

### Retry with LLM

`POST /api/candidates/:id/retry-resolution`

Creates a fresh high-priority `EVENT_RESOLUTION` job over the same crawl run with `resolutionMode: "LLM_REQUIRED"`. It does not recrawl. The Agent must fail the job if Anime Knowledge Service is missing or inference fails; it must not silently create another deterministic fallback. A successful new completion supersedes the older pending Candidate for that crawl run.

### Export crawl evidence for Codex

`GET /api/candidates/:id/export`

Returns a lossless `candidate-evidence-bundle/v2` ZIP containing every scoped raw document plus original structured data and deterministic `prepared/` indexes. Codex reads the prepared summary/collections/conflicts first and opens raw documents only for gaps or verification. The server strips object-store bucket/key fields from the public manifest and reads artifacts with bounded concurrency.

### Import a JSON override

`POST /api/candidates/:id/import`

Input: `{ "filename": "event-bundle.json", "bundle": { ... } }`. The complete `event-content-bundle/v2` contract and all evidence-document IDs are validated before one atomic draft update. Unknown document IDs return `422`; a non-pending Candidate returns `409`.

### Create a manual Source-backed Candidate

`POST /api/candidates/manual`

Input: `{ "sourceId": "uuid", "name": "Event name", "bundle"?: { ... } }`. The Source must have a completed or partial run. All documents from its latest eligible run become Candidate evidence. Success returns a Candidate ID for `/candidates/:id/overview`.

The complete A/B workflow and package contract are specified in [`codex-event-resolution-ab-test.md`](./codex-event-resolution-ab-test.md).

### Resolution dashboard

`GET /api/resolution/status`

Returns resolution-agent heartbeats and resolution-only jobs with mode, source, worker, attempt, model, prompt, tokens, duration, warnings, Candidate link, and bounded error information.

## Materialization

Creating a Review Event:

1. validates core event fields;
2. creates or reuses a matching venue;
3. inserts an Event with `status=REVIEW` and `enrichment_state=NEEDS_REVIEW`;
4. attaches every Candidate evidence document and source;
5. materializes links, facts, tickets, exhibitors, sessions, guests, updates, activities, and related subjects from the effective draft bundle;
6. marks the Candidate approved and assigns `published_event_id`.

## Acceptance criteria

- Candidate queue shows one aggregate entry per current resolution result and opens a full-width preview.
- Each tab has its own URL and can be refreshed without losing context.
- Pencil actions open typed editors; a successful save increments the draft revision.
- Creating/linking an Event uses saved edits.
- Source evidence is readable without inspecting JSON.
- Deterministic Candidates expose an LLM-required retry that does not run the crawler.
- Raw-evidence export and Codex JSON import preserve the immutable original result and provenance boundary.
- `/events/new` creates a Source-backed Candidate and then uses the same staged editor.
- Crawl Jobs contains no `EVENT_RESOLUTION` jobs or resolution agents. It shows paginated/filterable/sortable Crawl Runs and Crawl Workers side by side; new crawls are started from Sources.
- Resolution Jobs contains no crawler jobs or crawler workers. It shows paginated/filterable/sortable Resolution Jobs and Resolution Agents side by side.
- Build and lint succeed.
