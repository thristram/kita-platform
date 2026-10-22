# Operations and troubleshooting

## Health model

- `/health`: process is listening.
- `/ready`: active KB and model configuration are both present.
- `/v1/knowledge/status`: active snapshot counts and model identity.
- `/v1/knowledge/imports`: import state and validation errors.

## Common problems

### Import remains `DISCOVERED`

The directory has no `READY` marker. Wait for every Finder copy to finish, then add `READY`.

### Import becomes `FAILED`

Read `error` from `/v1/knowledge/imports`. Common causes are missing `subject.jsonlines`, invalid JSON at a reported line, invalid subject IDs, or empty names. Fix the source under a new version name; immutable snapshot version names should not be reused.

### `/ready` returns `503`

Inspect `kbReady`, `modelConfigured`, and `modelReady`. If KB is false, import a snapshot. If configuration is false, set `LLM_BASE_URL` and `LLM_MODEL`. If `modelConfigured` is true but `modelReady` is false, start Ollama and register the exact configured model tag.

### NVMe is not mounted

Stop the service, mount `/Volumes/NVMEData`, and restart. Do not let the service silently create a same-named local directory on the system disk; verify the mount before startup.

### Ollama is slow or stuck

Run `ollama ps`. The intended model should be loaded on GPU. Avoid multiple long-running interactive `ollama run` sessions because the configured single runner may queue service requests. The service timeout defaults to five minutes.

### Thinking text appears

Confirm:

```dotenv
LLM_API_STYLE=ollama
LLM_BASE_URL=http://localhost:11434
```

The service uses native `/api/chat` with `think: false`. Do not point the Ollama configuration at `/v1`.

### Resolution Agent falls back deterministically

Run Knowledge Service `/ready`, then Resolution Agent `npm run doctor`. The Candidate warning contains a bounded service error. Verify base URL, bearer token, body-size limit, and model timeout.

### `/v1/resolve/event` returns `413`

The request exceeded `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET` before final resolution. A large deterministic baseline is automatically projected to at most 8k and restored after inference, so `413` should now mean crawler evidence or another irreducible part of the prompt is oversized. For Resolution Agent traffic, inspect the nested baseline/evidence stats in `Compacted event context`; defaults are 15k maximum evidence and 24k complete prompt. If the old `Compacted event evidence` message appears, restart both Agent and Knowledge Service to load the shared projection contract. For another client, compact its evidence before retrying. Do not solve this only by increasing Ollama context because retrieved graphs and future inputs would remain unbounded.

### Ollama reports `exceed_context_size_error`

Compare the response/logged `estimatedInputTokens` with Ollama's provider-reported `inputTokens`. Keep `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET` below the model's actual `num_ctx`, with output headroom. The checked-in 32k context and 24k prompt budget reserve roughly 8k tokens for JSON output. A larger model context may be used as extra safety but does not replace compaction.

The service makes one structured event-enrichment call with `num_predict=4096`; Bangumi query extraction is deterministic and makes no model call. If a request still reaches `LLM_TIMEOUT_MS`, first confirm Ollama is using Metal/GPU, then lower the evidence budget or increase the timeout within the documented maximum.

## Rollback

Snapshots are retained under `snapshots/<version>`. Automatic rollback is intentionally not exposed in v0.1. To recover safely, create a new import version from the desired Archive export and add `READY`; it will become the new active version after validation. Do not edit an existing snapshot in place.

## Backups

Authoritative data is the upstream Bangumi export. Generated snapshots are rebuildable. Back up `active.json` and import version metadata only if preserving exact operational history matters; do not treat the generated index as the sole copy of upstream data.

## Security checklist

- keep loopback binding for single-machine use;
- require a long bearer token outside loopback;
- use HTTPS behind a trusted proxy for network access;
- do not expose Ollama directly to other machines;
- mount only the knowledge data root, not the whole home directory;
- never put KitaCon database or R2 credentials in this service;
- treat JSON Lines and model output as untrusted.

## Deployment checklist

- NVMe mounted and writable;
- Ollama running and model listed;
- active snapshot present or ready import staged;
- Knowledge Service `/ready` returns 200;
- Resolution Agent can read `/v1/knowledge/status`;
- event prompt budget is lower than Ollama `num_ctx` and higher than the Agent evidence budget;
- token values match when enabled;
- old snapshots retained until the new version is verified.
