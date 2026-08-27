# KitaCon P0/P1 architecture

KitaCon separates source evidence, editorial truth, and public serving state.

```text
Connectors -> RawDocument/R2 -> Assertions/Candidates -> Resolver + Review
          -> Canonical Event/Fandom Graph -> transactional outbox
          -> deterministic projector -> serving read model -> consumer APIs
```

The repository uses provider-neutral UUIDs. Bangumi, TMDB, Ticketmaster, AnimeCons, and social identifiers live only in external-reference or source-evidence records. A crawler observation cannot overwrite a pinned manual decision. AI output is validated into a candidate and never writes canonical tables directly.

Media has three explicit publication states: `INTERNAL_ONLY`, `EVIDENCE_ONLY`, and `PUBLIC_READY`. Crawled images default to internal use. Only explicitly approved media can enter public projections.

The Console surface in this milestone exercises the operating model: event/editorial review, per-field provenance, source health, durable job visibility, candidate decisions, media classification, internal-default selection, and public-readiness controls. The `/discover` route demonstrates the P1 serving experience and only represents projected, public-eligible content.

## Deployment boundaries

- Console and consumer web: Cloudflare-compatible React deployment.
- Management/Public API: scale-to-zero Node service with separate admin and `/v1` route boundaries.
- PostgreSQL/Neon: canonical, ingestion, serving, consumer, and outbox schemas.
- R2: separate raw-evidence and approved-media buckets.
- Intelligence worker: stateless, independently deployable image leasing jobs through the API; no database credentials.
- `thristram-auth`: external service accessed only through `AuthVerifier`.

## Current milestone

This repository contains the polished Console/consumer product surfaces, foundational contracts, auth boundary, deterministic resolution logic, and PostgreSQL foundation migration. Live provider connectors, storage credentials, and production auth configuration remain environment-dependent integration work and are intentionally not faked in the UI.
