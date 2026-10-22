# Kita Resolution Agent

`@kita/resolution-agent` is KitaCon's standalone pull worker. It leases completed crawler runs from the KitaCon control API, prepares scoped evidence through `@kita/evidence-pipeline`, builds a deterministic baseline, optionally asks Anime Knowledge Service for semantic resolution, validates the result, and submits one review Candidate.

The Agent has no PostgreSQL, R2, Bangumi Archive, or Ollama credentials. Bangumi ingestion, retrieval, model prompts, filename resolution, and model lifecycle belong to [`@kita/anime-knowledge-service`](../anime-knowledge-service/README.md).

Run-level deduplication, collection merging, provenance, conflict reporting, and the manual Bundle v2 index are shared with [`@kita/evidence-pipeline`](../evidence-pipeline/README.md). The Agent's later evidence compactor is a separate lossy/token-budgeted boundary used only for the local model request.

## Documentation

- [Requirements](docs/requirements.md)
- [Service specification](docs/spec.md)
- [Architecture](docs/architecture.md)
- [Setup and usage](docs/setup.md)
- [KitaCon control API contracts](docs/contracts.md)
- [Knowledge-service integration](docs/knowledge-base.md)
- [Operations](docs/operations.md)
- [ADR 0001: standalone pull worker](docs/adr/0001-standalone-pull-worker.md)
- [ADR 0002: evidence compaction](docs/adr/0002-evidence-compaction.md)

## Quick start

```bash
cd /Users/thristram/Developer/kita-platform
npm install
npm run agent:build
npm run agent:test
```

Configure `packages/resolution-agent/.env.local`:

```dotenv
KITACON_API_BASE_URL=http://localhost:3009
KITACON_AGENT_TOKEN=<same secret as RESOLUTION_AGENT_TOKEN in the main site>
AGENT_ID=fangchen-macbook

KNOWLEDGE_SERVICE_BASE_URL=http://127.0.0.1:4320
KNOWLEDGE_SERVICE_TOKEN=
KNOWLEDGE_SERVICE_TIMEOUT_MS=600000

# Evidence sent to the model is deterministically compacted to this budget.
AGENT_EVIDENCE_TOKEN_BUDGET=15000
```

Start Anime Knowledge Service first, then:

```bash
npm run agent:dev
```

If Knowledge Service is absent, ordinary `AUTO` event jobs still create a deterministic review Candidate with a warning. An editor can request an `LLM_REQUIRED` retry from the Candidate page; that job reuses stored crawl evidence and fails visibly rather than falling back when the Knowledge Service or model is unavailable. Crawler work is monitored at `/crawl-jobs`; agent work is monitored at `/resolution-jobs`. Reusable filename resolution is exposed only by Anime Knowledge Service.
