# ADR 0001: Python crawler with Scrapling and PostgreSQL queue

## Status

Accepted

## Decision

KitaCon runs crawling in a dedicated Python worker under `workers/crawler`. Scrapling is wrapped by KitaCon-owned engine and connector interfaces. PostgreSQL is the durable source of truth for source policy, crawl runs, fetch attempts, raw-document metadata, extraction candidates, assertions, media candidates, jobs, and worker leases.

HTTP is the default fetch mode. A source may opt into Dynamic browser rendering. Stealth is available only when the registered source policy explicitly permits it. The crawler does not solve CAPTCHAs or authenticate unless a future reviewed source contract adds that capability.

Raw bodies are persisted before extraction. A content-addressed artifact key and database record make extraction replayable without fetching the remote URL again.

## Consequences

- Web deployments do not execute long-running crawls in request handlers.
- Multiple workers can lease jobs safely with `FOR UPDATE SKIP LOCKED`.
- Every source needs an explicit legal/policy review before it can run.
- Local development can use filesystem artifacts; production should provide an S3-compatible R2 bucket.
- Connector code emits evidence and candidates, not canonical truth.
