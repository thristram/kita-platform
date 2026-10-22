# Requirements

## Goal

Convert every document in one official Website crawler run into one evidence-backed Event Content Bundle and submit it to KitaCon as a review Candidate. Resolution Agent owns job orchestration and evidence scoping; Anime Knowledge Service owns Bangumi/model intelligence.

## Functional requirements

### Job protocol

- Lease one `EVENT_RESOLUTION` job through KitaCon's authenticated control API.
- Read only input and raw content covered by the active lease.
- Renew long-running leases.
- Submit one schema-valid EventBundle or report failure.
- Tolerate retry, lease expiry, and duplicate completion.
- Never write directly to KitaCon's database.

### Deterministic baseline

- Run the shared deterministic evidence-preparation stage before baseline construction.
- Group equivalent documents/assertions/chunks/media, merge structured collections, retain all source-document provenance, and expose conflicts/statistics without using a model.
- Vote crawler assertions for title, dates, description, venue, and official URL.
- Preserve structured links, sourced facts, ticket offers, exhibitors, sessions, guests and updates emitted as `content.*` crawler assertions.
- Derive normalized booth/session activities deterministically and assign stable external keys.
- Infer a conservative timezone when supported by normalized location.
- Rank media through crawler metadata without model vision by default.
- Preserve field-level evidence, conflicts, warnings, and confidence.

### Knowledge-service integration

- Send only bounded, lease-scoped evidence plus the deterministic baseline to Anime Knowledge Service.
- Consume prepared evidence, then rank and compact the remaining descriptions, assertions, text chunks, and media before they cross the service boundary.
- Preserve materially conflicting values even when equivalent evidence from other pages is removed.
- Rank evidence deterministically using field importance, crawler confidence, page type, semantic signals, and media quality; model calls must not be used for compaction.
- Keep compacted evidence at or below `AGENT_EVIDENCE_TOKEN_BUDGET`, default `15,000` estimated tokens, and reduce it further based on the actual V2 baseline size so the complete prompt remains below 24k.
- Treat full-page HTML as a fallback only when a document has no assertions or chunks; never send redundant full HTML alongside usable structured evidence.
- Accept only the shared `event-content-bundle/v2` response contract.
- Merge model output over the deterministic content baseline so model omission cannot delete evidenced crawler records.
- Use Bangumi candidates to link only explicit subjects/people; never invent popularity, attendance, engagement or recommendation data.
- Store returned model and prompt metadata with the Candidate.
- On service absence, timeout, non-2xx response, or invalid JSON, submit the deterministic baseline with a bounded warning.

## Non-functional requirements

- TypeScript/JavaScript on Node.js 22.13 or newer.
- Standalone package, process, Docker image, configuration, tests, and documentation.
- No database, R2, Bangumi file, model-file, or Ollama credentials.
- Service credentials are scoped, rotatable, omitted from logs, and use HTTPS outside localhost.
- Raw HTML and remote model output remain untrusted.
- Contracts and prompt/model metadata are versioned and auditable.
- Compaction must be deterministic, tokenizer-independent, observable through count/token statistics, and conservative for mixed English/CJK content.

## Acceptance criteria

- A completed official Website crawl enqueues one event-resolution job.
- AnimeCons directory runs remain excluded because their connector materializes multiple independent events deterministically.
- Successful completion creates one Candidate and preserves every source document link.
- Candidate approval or linking materializes V2 content into normalized event tables idempotently.
- Cross-job evidence access is rejected.
- Knowledge-service success records its knowledge/model result.
- Knowledge-service failure never persists invalid output and instead records the deterministic fallback warning.
- Duplicate Anime Expo-style evidence is reduced before inference, conflicting dates remain available to the model, and the compacted payload does not exceed its configured budget.
- An over-budget direct request is rejected before Ollama is invoked.
- The Agent contains no KB indexer, filename endpoint, or local model client.
