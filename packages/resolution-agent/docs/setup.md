# Setup and usage

## Prerequisites

- Node.js 22.13 or newer
- npm
- KitaCon development environment and migrations
- optional but recommended: a ready Anime Knowledge Service on port 4320

The Agent does not need PostgreSQL, Neon, R2, Bangumi Archive, Ollama, or model-file credentials.

## Install and test

```bash
cd /Users/thristram/Developer/kita-platform
npm install
npm run evidence:test
npm run agent:build
npm run agent:test
```

## Configure KitaCon

Generate a shared Resolution Agent control-plane secret:

```bash
openssl rand -hex 32
```

Main-site `.env.local`:

```dotenv
RESOLUTION_AGENT_TOKEN=<generated-secret>
```

Apply migrations and start KitaCon:

```bash
npm run db:migrate
npm run dev
```

## Configure Resolution Agent

```bash
cp packages/resolution-agent/.env.example packages/resolution-agent/.env.local
```

```dotenv
KITACON_API_BASE_URL=http://localhost:3009
KITACON_AGENT_TOKEN=<same generated secret>
AGENT_ID=fangchen-macbook

KNOWLEDGE_SERVICE_BASE_URL=http://127.0.0.1:4320
KNOWLEDGE_SERVICE_TOKEN=
KNOWLEDGE_SERVICE_TIMEOUT_MS=600000
AGENT_EVIDENCE_TOKEN_BUDGET=15000
```

If Knowledge Service uses a token, put the same value in both services. Remove `KNOWLEDGE_SERVICE_BASE_URL` only when deterministic fallback is intentionally desired.

## Verify

```bash
cd packages/resolution-agent
npm run doctor
```

The report checks KitaCon control-plane health and Anime Knowledge Service status. It never prints either token.

## Run

```bash
cd /Users/thristram/Developer/kita-platform
npm run agent:dev
```

Process at most one job and exit:

```bash
node packages/resolution-agent/dist/cli.js worker --once
```

## Docker

Build from the repository root:

```bash
docker build -f packages/resolution-agent/Dockerfile -t kita-resolution-agent .
```

When KitaCon and Knowledge Service run on the Docker host:

```dotenv
KITACON_API_BASE_URL=http://host.docker.internal:3009
KNOWLEDGE_SERVICE_BASE_URL=http://host.docker.internal:4320
```

## Environment reference

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KITACON_API_BASE_URL` | worker | `http://localhost:3009` | KitaCon control API |
| `KITACON_AGENT_TOKEN` | worker | none | KitaCon-scoped service credential |
| `AGENT_ID` | no | generated | stable worker identity |
| `AGENT_POLL_INTERVAL_MS` | no | `10000` | no-job polling delay |
| `AGENT_LEASE_SECONDS` | no | `600` | initial lease duration |
| `AGENT_MAX_DOCUMENT_BYTES` | no | `2000000` | maximum fetched artifact bytes per document |
| `AGENT_MAX_CONTEXT_CHARS` | no | `180000` | total raw-text context budget |
| `AGENT_EVIDENCE_TOKEN_BUDGET` | no | `15000` | maximum estimated evidence tokens; the runtime may lower this using the actual V2 baseline size |
| `KNOWLEDGE_SERVICE_BASE_URL` | no | none | Anime Knowledge Service origin |
| `KNOWLEDGE_SERVICE_TOKEN` | provider-specific | empty | bearer token for Knowledge Service |
| `KNOWLEDGE_SERVICE_TIMEOUT_MS` | no | `600000` | end-to-end local event enrichment timeout |

`AGENT_MAX_CONTEXT_CHARS` limits how much raw HTML may be hydrated before selection. It is not the model prompt limit. The shared Evidence Pipeline first prepares the complete run without a token budget. `AGENT_EVIDENCE_TOKEN_BUDGET` applies to the later lossy model-selection step and is the operative evidence limit sent across the Knowledge Service boundary.
