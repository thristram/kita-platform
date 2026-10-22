# ADR 0001: Independent Anime Knowledge Service

- Status: Accepted
- Date: 2026-10-07

## Context

KitaCon event resolution and AnimeReactDownloadHelper filename resolution need the same Bangumi Archive version, alias behavior, model prompts, canonical identity rules, and legacy ID compatibility. Keeping those responsibilities inside the KitaCon-specific Resolution Agent would duplicate logic in other applications and couple KB updates to one worker deployment.

## Decision

Create `packages/anime-knowledge-service` as an independently runnable service in the existing monorepo.

The service owns:

- drop-folder Bangumi imports;
- immutable generated snapshots and active-version selection;
- retrieval and bounded graph expansion;
- model-provider access;
- filename and event resolution APIs;
- model-output and identity validation.

Ollama remains a separate runtime. Resolution Agent remains a separate KitaCon job worker and calls Anime Knowledge Service over HTTP. Repository co-location provides shared contracts and coordinated development but does not merge runtime authority.

## Import protocol decision

Use `imports/<version>/READY` rather than indexing on first file appearance. Finder and other copy tools expose partially written files. `READY` is an explicit completion barrier that is understandable without an administration UI.

Build into a hidden staging snapshot and activate only through same-filesystem renames. A failure never mutates the current snapshot.

## Consequences

Positive:

- one KB and identity implementation for multiple applications;
- independent weekly Archive updates;
- model/runtime changes do not affect consumers;
- consumers receive stable, validated domain JSON rather than raw model text;
- KitaCon database credentials stay outside the knowledge/model boundary.

Costs:

- one additional local process and HTTP dependency;
- explicit startup order and health checks;
- API and snapshot versions require operational discipline;
- large JSON Lines imports require disk space for source, staging, current, and previous snapshots.

## Rejected alternatives

- **Keep KB inside Resolution Agent:** simplest for one consumer, but duplicates logic for other projects.
- **Let every application call Ollama directly:** spreads prompts, validation, and hallucinated-ID risk.
- **Load GGUF inside the Node service:** couples domain logic to model runtime and weakens Metal/runtime replaceability.
- **Index immediately on file appearance:** can consume partial Finder copies.
- **Modify one live index in place:** risks partial or corrupt reads during weekly updates.
- **Split retrieval and model orchestration into separate services now:** adds another failure boundary without a current scaling need.
