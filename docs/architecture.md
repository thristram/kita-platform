# KitaCon P0/P1 architecture

KitaCon separates source evidence, editorial truth, and public serving state.

```text
Connectors -> rendered/raw RawDocument + captured APIs -> Assertions (including content.* records)
          -> Evidence Pipeline (dedupe + provenance + conflicts)
          -> Resolution Agent + Anime Knowledge Service -> Event Content Candidate + Review
          -> Canonical Event/Fandom/Session/Exhibitor/Activity Graph -> transactional outbox
          -> deterministic projector -> serving read model -> consumer APIs
```

The repository uses provider-neutral UUIDs. Bangumi, TMDB, Ticketmaster, AnimeCons, and social identifiers live only in external-reference or source-evidence records. A crawler observation cannot overwrite a pinned manual decision. AI output is validated into a candidate and never writes canonical tables directly. The Event Content Bundle v2 mapping and the boundary between crawler-owned content and platform-owned engagement metrics are documented in [`event-content-population.md`](./event-content-population.md).

Media has three explicit publication states: `INTERNAL_ONLY`, `EVIDENCE_ONLY`, and `PUBLIC_READY`. Crawled images default to internal use. Only explicitly approved media can enter public projections.

The Console surface in this milestone exercises the operating model: event/editorial review, per-field provenance, source health, durable job visibility, candidate decisions, media classification, event-scoped media selection, internal-default selection, and public-readiness controls. The `/discover` route demonstrates the P1 serving experience and only represents projected, public-eligible content. The Console keeps one Radix/shadcn + TanStack + KitaCon design system instead of introducing Bootstrap; the decision and media-picker evaluation are recorded in [`adr/0002-console-ui-primitives-and-media-picker.md`](./adr/0002-console-ui-primitives-and-media-picker.md).

## Candidate review observability

An event-level Candidate records whether it was produced by validated `LLM + KB`, a `Deterministic fallback` after an attempted model call, or `Deterministic only`. The Candidate detail API projects model, prompt, token, duration, warning, crawl-run, and evidence-document metadata from the immutable resolution payload; the Console keeps this information in a default-collapsed **More info** panel so the normal review path remains compact.

Review mutations are auditable without introducing a separate credential-bearing service. An unexpected create/link/reject failure is assigned an `errorCode` and UUID `errorId`; a redacted copy is stored under the Candidate payload's `review.lastFailure` and is returned in the HTTP response. A successful create/link removes the stale failure. `published_event_id IS NULL` means the Candidate has not been materialized and therefore remains eligible to create a new non-public `REVIEW` Event while its status is `PENDING`.

Candidate review is view-first and mirrors the consumer Event information architecture. Human edits are schema-validated as a versioned `review.draftBundle`; the immutable resolution result stays available for audit, while Event creation and linking prefer the saved draft. Field evidence is presented as grouped provenance in a drawer, with raw chunks and media collapsed. An operator can export the same immutable evidence scope as a lossless Bundle v2 containing prepared indexes, run a Codex A/B resolution, and import the returned Event Bundle as another versioned draft. `/events/new` creates a Source-backed manual Candidate and deliberately rejoins the same editor/materialization path. The complete UI/state contract is specified in [`specs/candidate-editor-and-resolution-jobs.md`](./specs/candidate-editor-and-resolution-jobs.md); the offline model-comparison contract is in [`specs/codex-event-resolution-ab-test.md`](./specs/codex-event-resolution-ab-test.md).

Adaptive rendering and evidence preparation are described in [`adr/0003-adaptive-rendering-and-evidence-preparation.md`](./adr/0003-adaptive-rendering-and-evidence-preparation.md). The shared implementation contract is in [`../packages/evidence-pipeline/README.md`](../packages/evidence-pipeline/README.md).

Crawler jobs and semantic-resolution jobs share PostgreSQL durability but not an operator workspace. `/crawl-jobs` excludes `EVENT_RESOLUTION` jobs and `RESOLUTION_AGENT` workers. `/resolution-jobs` projects only that resolution workload, including LLM-required retry mode, model/prompt identity, token metrics, warnings, and Candidate links.

## Console routes and operator preferences

Every Console workspace has a stable route so it can be linked, refreshed, and restored by browser navigation: `/overview`, `/events`, `/events/new`, `/candidates`, `/candidates/:id/:tab`, `/media`, `/sources`, `/crawl-jobs`, `/resolution-jobs`, and `/settings/:section`. Event details remain under `/events/:id`; `/` redirects to `/overview`, and `/settings` redirects to `/settings/general`. Settings subpages use the expandable Settings group in the fixed primary sidebar. Crawl and Resolution are separate subroutes under the expandable Workers group.

The current theme preference is browser-local. On a first visit the Console follows the operating-system color scheme, then stores an explicit operator choice in `localStorage` under `kitacon-theme` and mirrors it to a same-site cookie so server rendering can paint the correct background before hydration. When `thristram-auth` is connected to the Console, the authenticated admin preference should become the cross-device source of truth, with browser storage retained as the startup and offline fallback. The current UI must not claim account synchronization before that integration exists.

## Deployment boundaries

- Console and consumer web: Cloudflare-compatible React deployment.
- Management/Public API: scale-to-zero Node service with separate admin and `/v1` route boundaries.
- PostgreSQL/Neon: canonical, ingestion, serving, consumer, and outbox schemas.
- R2: separate raw-evidence and approved-media buckets.
- Intelligence worker: stateless, independently deployable image leasing jobs through the API; no database credentials.
- `thristram-auth`: external service accessed only through `AuthVerifier`.

## Current milestone

This repository contains the polished Console/consumer product surfaces, foundational contracts, auth boundary, deterministic resolution logic, and PostgreSQL foundation migration. Live provider connectors, storage credentials, and production auth configuration remain environment-dependent integration work and are intentionally not faked in the UI.
# Console identity and authorization

The private Console authenticates through a configurable standards-based OIDC provider (initially `thristram-auth`). KitaCon owns authorization in `admin.principal_identity`, `admin.permission_group`, and `admin.principal_group`. Every Console page and private API checks its required permission server-side; `/discover` remains public and the Resolution Agent retains its independent Bearer-token contract. See [ADR 0004](adr/0004-console-oidc-and-access-control.md) and the [setup/runbook](runbooks/console-auth.md).
