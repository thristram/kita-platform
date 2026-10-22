# Anime Knowledge Service

`@kita/anime-knowledge-service` is a standalone TypeScript service in the KitaCon monorepo. It owns local Bangumi Archive ingestion, immutable knowledge snapshots, subject retrieval, Ollama access, and schema-validated anime/event resolution APIs.

Consumers such as KitaCon's Resolution Agent and AnimeReactDownloadHelper call this service over HTTP. They do not read Bangumi JSON Lines, construct prompts, connect to Ollama, or implement the legacy Bangumi ID transform themselves.

## Documentation

- [Requirements](docs/requirements.md)
- [Service specification](docs/spec.md)
- [Architecture](docs/architecture.md)
- [Setup and usage](docs/setup.md)
- [API, inputs, and outputs](docs/api.md)
- [Codex MCP setup and tool contract](docs/mcp.md)
- [Operations and troubleshooting](docs/operations.md)
- [ADR 0001: service and snapshot boundary](docs/adr/0001-service-boundary.md)
- [ADR 0002: complete-prompt budgeting](docs/adr/0002-prompt-budget.md)
- [Proposed anime-work user stories](docs/anime-work-graph-user-stories.md)
- [Proposed anime-work graph requirements and implementation spec](docs/anime-work-graph-requirements.md)

## Quick start

```bash
cd /Users/thristram/Developer/kita-platform
npm install
npm run knowledge:build
npm run knowledge:test

cp packages/anime-knowledge-service/.env.example \
  packages/anime-knowledge-service/.env.local
```

Create an import directory inside the configured `KNOWLEDGE_DATA_ROOT`, drag the Bangumi JSON Lines into it, and add `READY` only after every copy finishes:

```text
/Volumes/NVMEData/anime-knowledge/imports/bangumi-2026-10-07/
├── subject.jsonlines
├── person.jsonlines
├── character.jsonlines
├── episode.jsonlines
├── subject_relation.jsonlines
├── subject_person.jsonlines
└── READY
```

Start the service:

```bash
npm run knowledge:dev
```

The service validates and indexes the import in the background, then atomically activates it. Check readiness at `http://127.0.0.1:4320/ready`.

For the NVMe-hosted GGUF/Ollama registration commands, see [Setup and usage](docs/setup.md#register-the-nvme-gguf-with-ollama).

## Ownership boundary

The service owns:

- Bangumi import and snapshot directories;
- normalized local indexes and active-version selection;
- knowledge retrieval and relationship expansion;
- local model configuration and prompts;
- JSON schema validation and identity enforcement;
- the exact legacy `uniqueIdHelper` compatibility transform.

It does not own KitaCon jobs, crawler evidence, Events, Candidates, PostgreSQL, R2, or publication decisions.

For event resolution, the service independently caps each complete model prompt at `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET` (24k estimated tokens by default). Resolution Agent performs crawler-aware evidence compaction first; this service budgets the baseline, instructions, and retrieved Bangumi graph added afterward.
