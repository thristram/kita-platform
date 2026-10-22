# Crawler specification audit

This audit maps the authoritative `kitacon_crawler_spec` to the current KitaCon implementation. A milestone is complete only when its implementation and tests are present.

| Milestone | Existing foundation | Required gap closure | Status |
| --- | --- | --- | --- |
| C1 Scrapling scaffold | KitaCon fetch contracts over preserved Scrapling HTTP, Dynamic, and Stealth modes; normalized URL taxonomy/scoring; depth/page/byte/runtime stop checks | None | Complete |
| C2 PostgreSQL persistence | `source`, `crawl_run`, `fetch_attempt`, immutable `raw_document`, queue, assertions, candidates, source graph, chunks, and run configuration/errors | None; migrations `0003` and `0004` are applied to the linked Neon database | Complete |
| C3 R2 | Complete object-store contract, boto3 R2 adapter, separate raw/media buckets, stable keys, signed GETs, doctor round-trip, and targeted write-intent reconciliation without bucket listing | Live R2 acceptance requires credentials and two provisioned buckets; the current local environment is intentionally in local mode | Implemented; external verification pending |
| C4 AnimeCons | Deterministic listing fan-out and event parser, live canonical event linkage, event evidence/candidate, official-site discovery, Website Source creation, and explicit policy-inherited follow-on crawl | Live AnimeCons currently returns Cloudflare verification/403 from tested automated networks; this is recorded as blocked and direct official-site seeding remains available | Complete with source-access caveat |
| C5 Official website spider | Taxonomy, ranking, exclusions, persisted graph, depth/page/byte/runtime budgets, source candidates, PDF/image/JSON handling, and multi-page Scrapling fixture | None | Complete |
| C6 Text/retrieval | Structural HTML chunks, native PDF text, JSON/text chunks, FTS/trigram indexes, bounded event search/list/metadata/chunk/source graph/artifact contracts | None | Complete |
| C7 Media/logo | Semantic discovery, media download to the media store, exact/perceptual hashes, dimensions, asset/assignment persistence, explicit logo outcome, and pinned-safe internal cover resolution | None | Complete |
| C8 Evidence/candidate | Event-scoped assertions/provenance and candidates; canonical fields are not directly mutated; bounded retrieval prevents bucket enumeration | None | Complete |
| C9 Console | Source creation/policy/budgets, enqueue, worker/run/job status, run retry/detail, graph, RawDocument detail/download, event crawler tab, and media download | None | Complete |
| C10 integration | AnimeCons fixture, multi-page convention Scrapling crawl, repeat unchanged-version test, object-store contract, graph/chunk/media/pinned-cover tests, build and browser verification | A real R2 round-trip cannot run until credentials are supplied; `crawler doctor` is the executable acceptance check | Local complete; R2 pending |

## Architectural invariants

- Scrapling remains behind KitaCon-owned fetch and crawl contracts.
- Raw evidence bytes live in the object store, never PostgreSQL.
- PostgreSQL stores evidence metadata, source graph, chunks, workflow, candidates, and canonical records.
- Crawler/parser output creates evidence and candidates; it does not directly overwrite canonical fields.
- Manual pinned fields, relations, and media defaults remain authoritative.
- Intelligence workers receive bounded retrieval results and short-lived artifact URLs, never bucket-list credentials.
