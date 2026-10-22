# Setup and usage

## Prerequisites

- macOS or Linux
- Node.js 22.13 or newer
- npm
- Ollama or another supported local JSON-capable model endpoint
- a Bangumi Archive export

The service does not require KitaCon, PostgreSQL, Neon, R2, or crawler credentials.

## 1. Install, build, and test

From the repository root:

```bash
cd /Users/thristram/Developer/kita-platform
npm install
npm run knowledge:build
npm run knowledge:test
```

## 2. Configure

```bash
cp packages/anime-knowledge-service/.env.example \
  packages/anime-knowledge-service/.env.local
```

Recommended local configuration for this Mac:

```dotenv
KNOWLEDGE_SERVICE_HOST=127.0.0.1
KNOWLEDGE_SERVICE_PORT=4320
KNOWLEDGE_SERVICE_TOKEN=
KNOWLEDGE_DATA_ROOT=/Volumes/NVMEData/anime-knowledge
KNOWLEDGE_IMPORT_POLL_MS=5000
KNOWLEDGE_MAX_CANDIDATES=12
KNOWLEDGE_MAX_BODY_BYTES=5000000

LLM_API_STYLE=ollama
LLM_BASE_URL=http://localhost:11434
LLM_API_KEY=ollama
LLM_MODEL=kita-qwen3.5:9b-q4
LLM_TIMEOUT_MS=600000
KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET=24000
```

The service uses native Ollama `/api/chat` with `think: false`, `stream: false`, and JSON output.

### Register the NVMe GGUF with Ollama

The GGUF file existing on disk is not enough; Ollama must register it as the same tag configured in `LLM_MODEL`. To keep Ollama's managed blobs on the external drive, stop any existing `ollama serve`, then start it with an external model store:

```bash
mkdir -p /Volumes/NVMEData/ollama-models
OLLAMA_MODELS=/Volumes/NVMEData/ollama-models ollama serve
```

In another terminal, register the checked-in Modelfile and verify the tag:

```bash
cd /Users/thristram/Developer/kita-platform
ollama create kita-qwen3.5:9b-q4 \
  -f packages/anime-knowledge-service/ollama/Qwen3.5-9B.Modelfile
ollama list
```

`ollama list` must contain `kita-qwen3.5:9b-q4`. `OLLAMA_MODELS` affects the server process, so setting it only on the `ollama create` client does not relocate the model store.

## 3. Create the data root

```bash
mkdir -p /Volumes/NVMEData/anime-knowledge/imports
mkdir -p /Volumes/NVMEData/anime-knowledge/snapshots
```

The NVMe volume must be mounted before starting the service.

## 4. Drop a Bangumi export

Create a unique version directory, for example:

```text
/Volumes/NVMEData/anime-knowledge/imports/bangumi-2026-10-07/
```

Drag the JSON Lines into it. `subject.jsonlines` is required. Optional recognized data includes people, characters, episodes, subject relations, subject-person relations, and subject-character relations.

Do not add `READY` while Finder is still copying. When every file is complete:

```bash
touch /Volumes/NVMEData/anime-knowledge/imports/bangumi-2026-10-07/READY
```

The service will discover it on the next polling interval. You can also request a scan with the API or run:

```bash
cd /Users/thristram/Developer/kita-platform/packages/anime-knowledge-service
npm run import:scan
```

## 5. Start the service

From the repository root:

```bash
npm run knowledge:dev
```

Production-style local start:

```bash
npm run knowledge:build
npm run knowledge:start
```

Verify:

```bash
curl http://127.0.0.1:4320/health
curl http://127.0.0.1:4320/ready
curl http://127.0.0.1:4320/v1/knowledge/status
```

## 6. Connect Resolution Agent

In `packages/resolution-agent/.env.local`:

```dotenv
KNOWLEDGE_SERVICE_BASE_URL=http://127.0.0.1:4320
KNOWLEDGE_SERVICE_TOKEN=
KNOWLEDGE_SERVICE_TIMEOUT_MS=600000
```

Start order:

```text
1. Mount NVMe
2. Start Ollama
3. Start Anime Knowledge Service
4. Start KitaCon
5. Start Resolution Agent
```

## 6a. Connect local Codex for the event-resolution A/B test

Build once, keep the Knowledge Service running, and register the read-only stdio MCP adapter. See [Codex MCP setup and tool contract](mcp.md) for the exact command, four tools, security boundary, and test workflow. This path does not call Ollama from Codex.

## 7. Docker

Docker on macOS does not provide Apple GPU passthrough for Ollama, so keep Ollama on the host. The Node service may run in Docker and call `host.docker.internal:11434`.

Because the container binds `0.0.0.0` internally, configure a token of at least 32 characters even though the published port is restricted to host loopback:

```dotenv
KNOWLEDGE_SERVICE_TOKEN=<32-or-more-random-characters>
```

Then (the explicit env file is also used for Compose variable interpolation):

```bash
cd packages/anime-knowledge-service
docker compose --env-file .env.local up --build
```

## Environment reference

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KNOWLEDGE_SERVICE_HOST` | no | `127.0.0.1` | HTTP bind host |
| `KNOWLEDGE_SERVICE_PORT` | no | `4320` | HTTP port |
| `KNOWLEDGE_SERVICE_TOKEN` | non-loopback | empty | bearer token; minimum 32 chars outside loopback |
| `KNOWLEDGE_DATA_ROOT` | yes for persistence | `./data` | imports, snapshots, and active pointer |
| `KNOWLEDGE_IMPORT_POLL_MS` | no | `5000` | drop-folder scan interval |
| `KNOWLEDGE_MAX_CANDIDATES` | no | `12` | maximum filename KB candidates |
| `KNOWLEDGE_MAX_BODY_BYTES` | no | `5000000` | maximum request body size |
| `LLM_API_STYLE` | no | `ollama` | `ollama` or `openai-compatible` |
| `LLM_BASE_URL` | resolution APIs | none | model service origin |
| `LLM_API_KEY` | provider-specific | `ollama` | model endpoint credential |
| `LLM_MODEL` | resolution APIs | none | model identifier |
| `LLM_TIMEOUT_MS` | no | `600000` | per model request timeout; sized for local Apple Silicon prompt evaluation |
| `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET` | no | `24000` | maximum estimated tokens for each complete event prompt, including baseline, evidence, and retrieved knowledge |

The default checked-in Ollama Modelfile uses `num_ctx 32768`. Keep the prompt budget below that value to reserve output capacity. Resolution Agent defaults to a baseline-aware evidence budget capped at 15k; do not configure it higher than this service's complete-prompt budget.
