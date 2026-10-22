# Requirements

## 1. Goal

Provide one reusable local anime intelligence service for every application that needs Bangumi-backed entity resolution. Updating the knowledge base must require only dropping a complete Bangumi Archive export into a versioned import directory and adding a `READY` marker.

## 2. Functional requirements

### FR-1 Drop-folder imports

- Watch `<KNOWLEDGE_DATA_ROOT>/imports` for version directories.
- Ignore directories without `READY`; files may still be copying.
- Require `subject.jsonlines` or a recognized singular/plural `.jsonl` variant.
- Accept optional person, character, episode, subject-relation, subject-person, and subject-character files.
- Validate every non-empty JSON Lines record before activation.
- Record import state and errors without replacing a working snapshot.

### FR-2 Versioned, atomic snapshots

- Build each version in a private staging directory.
- Never modify the active snapshot in place.
- Load and smoke-test the new subject index before activation.
- Rename a completed staging directory to an immutable snapshot directory.
- Atomically replace `active.json` only after success.
- Keep prior snapshots available for manual rollback and audit.

### FR-3 Knowledge retrieval

- Search subjects by original name, Chinese name, and parsed aliases.
- Normalize Unicode, case, whitespace, punctuation, and symbols.
- Return bounded candidates containing raw ID, encoded compatibility ID, canonical key, names, and retrieval score.
- Expand subject-to-subject and subject-to-person relationships when optional relation files exist.

### FR-4 Model-backed resolution

- Call the configured local model runtime rather than loading GGUF files in the Node.js process.
- For Ollama, disable thinking at the API boundary with `think: false`.
- Request non-streaming JSON output.
- Bound model output by operation: 1,024 tokens for filename decisions and 4,096 tokens for an event-enrichment patch.
- Validate all model output as untrusted data.
- Reject a Bangumi ID not present in the retrieved candidate set.

### FR-5 Filename resolution

Given an anime release filename, return:

- normalized title;
- season or `null`;
- episode or `null`;
- one selected Bangumi subject or `null`;
- bounded candidates;
- confidence and resolution method.

Heuristics may generate a retrieval hint but are not the final response. The LLM makes the final structured decision using the candidate set.

### FR-6 Event resolution

Accept bounded crawler evidence plus a deterministic Event Content Bundle v2 baseline, retrieve explicit Bangumi mentions, and return one schema-valid bundle with semantic enrichments merged into the crawler-owned content.

- Reject evidence that already exceeds the configured complete-prompt budget before invoking the model.
- Deduplicate retrieved subjects by canonical key and rank them by retrieval score.
- Bound each subject's relationship neighborhood and include only knowledge candidates that fit the remaining prompt budget.
- Derive bounded entity queries deterministically from structured baseline/evidence fields before Bangumi retrieval; do not spend a separate model call on query extraction.
- Keep the single event-enrichment prompt within `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET`, default 24,000 estimated tokens.
- Require the model to return the bounded `knowledgeEventEnrichmentSchema` patch through provider JSON Schema mode; the service, not the model, reconstructs the full Event Bundle.
- Return estimated prompt size, selected knowledge count, and provider token counts when available.
- Preserve every evidenced baseline content record and link only explicit subject/person mentions to server-supplied Bangumi candidates.
- Never manufacture user engagement, popularity, recommendations, attendance, booth numbers, dates, organizations, or people.

### FR-7 Operational APIs

Expose health, readiness, active-version status, import history, manual scan, subject/person search, exact subject/person lookup with subject relationship expansion, filename resolution, and event resolution endpoints.

### FR-8 Local Codex KB tool

- Provide a local stdio MCP adapter with read-only subject/person search and exact lookup tools.
- Return active `knowledgeVersion` and server-owned Bangumi references; never expose service credentials or raw filesystem paths.
- Do not expose import, model inference, crawler, Candidate, database, or publication operations through this adapter.
- Limit query counts, string lengths, result counts, and request duration.
- Reject non-loopback Knowledge Service URLs. Treat KB matches as possible identities, not proof of Event participation.

## 3. Non-functional requirements

- Node.js 22.13 or newer and TypeScript/JavaScript business logic.
- Apple Silicon M4/24 GB compatible when paired with a quantized local model.
- No KitaCon database, R2, crawler, or Neon credentials.
- Loopback binding by default.
- A 32-character service token is mandatory when binding outside loopback.
- Request bodies, candidate counts, model timeouts, and polling intervals are bounded.
- Prompt budgets reserve capacity for structured output and must remain below the configured model context window.
- Import failure must not interrupt reads from the current snapshot.
- Contracts and prompts are versioned and documented.
- `encodedId` is compatibility metadata; canonical identity is `(provider, entityType, rawId)` and `canonicalKey`.

## 4. Acceptance criteria

- A directory without `READY` remains `DISCOVERED` and is not indexed.
- A valid ready import creates a snapshot and becomes active.
- Invalid JSON records produce `FAILED` while the previous snapshot remains active.
- Restarting the service reloads `active.json` and the immutable snapshot.
- Ollama requests contain `think: false`, `stream: false`, and the operation's JSON Schema in `format`.
- Filename resolution rejects candidate-set escape.
- Resolution Agent obtains event resolution through HTTP and no longer reads KB files or calls Ollama directly.
- Codex can call the four read-only MCP tools against the running local Knowledge Service and cannot reach its model-backed event resolver through MCP.
- Repeated crawler evidence is compacted upstream, retrieved graph expansion cannot exceed the complete prompt budget, and an over-budget direct request returns `413` without an Ollama call.
- Build, lint, contracts, snapshot rollback, identity compatibility, and resolution tests pass.
