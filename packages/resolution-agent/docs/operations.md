# Operations and troubleshooting

## Health surfaces

- KitaCon control API: `GET /api/internal/v1/resolution/health`
- Anime Knowledge Service: `GET http://127.0.0.1:4320/ready`
- Resolution Agent: structured worker logs and `npm run doctor`

## Common problems

### `401 Unauthorized` from KitaCon

`KITACON_AGENT_TOKEN` does not match the main site's `RESOLUTION_AGENT_TOKEN`.

### `401 Unauthorized` from Knowledge Service

`KNOWLEDGE_SERVICE_TOKEN` does not match the token configured by Anime Knowledge Service.

### Candidate says deterministic fallback was used

The warning contains a bounded cause. Check Knowledge Service `/ready`, active snapshot, Ollama status, service URL, token, request-body limit, and timeout. The fallback is intentionally review-required.

If the warning reports a context budget, inspect the `Compacted event context` log. In its nested sections, `baseline.estimatedTokens` and `evidence.estimatedTokens` must not exceed their respective `tokenBudget`. `baseline.sourceTokens` may be much larger: the complete deterministic bundle is restored after inference and is intentionally not sent verbatim. A direct client can still receive `413` when crawler evidence alone consumes the complete prompt budget.

Use the Candidate editor's **Re-run with LLM** action after correcting the dependency. The resulting `LLM_REQUIRED` job is visible at `/resolution-jobs` and does not trigger another crawl. A repeated knowledge/model failure leaves the original pending Candidate intact and records the new job as retrying or failed.

### Compaction drops too much or still produces large prompts

- Keep `AGENT_EVIDENCE_TOKEN_BUDGET` below `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET`; defaults are 15k and 24k. Runtime budgeting reserves 7k for instructions/knowledge and at most 8k for a bounded baseline projection.
- Do not raise either above the Ollama model's `num_ctx` without reserving output space.
- Compare `source`, `unique`, `selected`, and `dropped` under `evidence`, plus `selected`/`dropped` under `baseline`. Many dropped media/chunks and redundant activities are expected; disappearance of conflicting core assertions is not.
- A log showing a small evidence estimate followed by a much larger service-side prompt estimate indicates an outdated Agent or Knowledge Service process. Restart both services so they share the baseline-projection contract.
- Increasing Ollama context is a safety margin, not a substitute for deduplication.

### No job appears after crawling

Verify migrations `0005_resolution_agent.sql`, `0006_resolution_job_scope.sql`, and `0007_event_content_graph.sql`, completed/partial crawl status, at least one raw document, and an `EVENT_RESOLUTION` job in the dashboard.

### Raw content is unavailable locally

KitaCon must use the same `CRAWLER_ARTIFACT_ROOT` as the crawler. The Agent cannot read arbitrary local paths; content remains lease-scoped through the control API.

### Docker cannot reach dependencies

Inside Docker, `localhost` is the container. Use:

```dotenv
KITACON_API_BASE_URL=http://host.docker.internal:3009
KNOWLEDGE_SERVICE_BASE_URL=http://host.docker.internal:4320
```

## Recovery

- Worker crash: restart; lease expiry makes work available again.
- Knowledge Service outage: event jobs produce deterministic review Candidates with warnings.
- Poison job: inspect after it reaches `DEAD`, correct the evidence/service condition, then explicitly requeue.
- Duplicate completion: safe; KitaCon returns the existing Candidate for that job.

## Sensitive data

Logs may contain job IDs, Candidate IDs, durations, and bounded errors. They must not contain bearer tokens, lease tokens, presigned URLs, raw HTML, full prompts, database credentials, or object-storage credentials.
