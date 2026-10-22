# ADR 0001: Standalone pull-based Resolution Agent

- Status: Accepted
- Date: 2026-10-06

## Context

Crawler output is document-oriented. A convention website can repeat one Event JSON-LD object across dozens of pages, producing dozens of page-level Candidates even though KitaCon needs one Event. Semantic grouping and knowledge-base linking benefit from a local model, but the crawler is already a high-risk runtime and should not gain more database authority.

The worker must run locally on an M4 MacBook Pro with 24 GB memory and remain mostly JavaScript. Bangumi/model capabilities also need reuse by projects that do not participate in KitaCon's job protocol.

## Decision

Create `packages/resolution-agent` as a separate TypeScript package and runtime inside the existing Git repository.

The Agent pulls lease-based jobs from an internal KitaCon API. KitaCon stores jobs and source evidence; the Agent holds only a scoped service token. The Agent submits a schema-validated EventBundle, which KitaCon stores as one review Candidate. It never directly writes canonical Event tables.

Use a hybrid pipeline across two services:

- deterministic parsing, voting, validation, and media signals first;
- call Anime Knowledge Service for Bangumi retrieval and model-backed interpretation;
- human review before publication.

Resolution Agent does not own Bangumi files, indexes, model configuration, prompts, filename APIs, or legacy identity transforms. Those responsibilities belong to `packages/anime-knowledge-service` and its own ADR.

## Why a pull worker

- A laptop behind NAT does not need an inbound port.
- Offline workers leave durable jobs in KitaCon.
- Lease expiry recovers from crashes.
- Multiple workers can advertise capabilities.
- The token grants a narrow protocol instead of arbitrary SQL access.

## Why not direct database access

A database proxy still exposes a database credential and SQL-shaped authority to a runtime that processes untrusted HTML and model output. An application control API can enforce job scope, document scope, schemas, idempotency, and audit rules.

## Why not an additional durable agent framework

KitaCon's existing `ingestion.job` table is already the durable coordinator. Adding another session/job store would create two retry and ownership models. The Agent is intentionally stateless between jobs; durable workflow state remains in KitaCon.

## Consequences

Positive:

- clear security and deployment boundary;
- knowledge/model runtime can change independently;
- one event-level Candidate replaces many document-level Candidates;
- contracts are shared and versioned;
- other applications reuse the separate Anime Knowledge Service without joining KitaCon's job protocol.

Costs:

- KitaCon must operate an authenticated internal API;
- at-least-once delivery requires idempotent completion;
- raw evidence retrieval adds network calls;
- semantic resolution adds a local service dependency;
- contract evolution must be coordinated by version.

## Rejected alternatives

- **Agent connects directly to Neon:** smaller initial implementation, unacceptable credential blast radius.
- **Main site pushes to the local Agent:** requires inbound reachability and complicates offline handling.
- **LLM-only extraction:** costly, less reproducible, and weak on evidence guarantees.
- **Deterministic-only extraction:** cannot reliably resolve aliases, implicit relationships, or ambiguous multi-page evidence.
- **Separate repository immediately:** creates versioning friction before contracts and release cadence stabilize. The runtime remains independently deployable and can be split later.
