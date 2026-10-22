# Service specification

## Scope

Anime Knowledge Service is a domain service, not a generic LLM proxy. Its stable product is canonical, schema-validated anime knowledge resolution. Ollama and Bangumi Archive are replaceable implementation dependencies behind that contract.

## Data layout

```text
<KNOWLEDGE_DATA_ROOT>/
├── active.json
├── imports/
│   └── <version>/
│       ├── subject.jsonlines       # required
│       ├── person.jsonlines        # optional
│       ├── character.jsonlines     # optional
│       ├── episode.jsonlines       # optional
│       ├── subject_relation.jsonlines
│       ├── subject_person.jsonlines
│       ├── subject_character.jsonlines
│       └── READY
└── snapshots/
    ├── <previous-version>/
    └── <active-version>/
        ├── manifest.json
        ├── subjects.jsonl
        ├── persons.jsonl
        ├── characters.jsonl
        ├── episodes.jsonl
        ├── subject-relations.jsonl
        ├── subject-persons.jsonl
        └── subject-characters.jsonl
```

Version names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,99}`.

## Import state machine

```text
DISCOVERED --READY--> INDEXING --success--> ACTIVE
                          │                    │
                          └--failure--> FAILED │
                                               └--new activation--> AVAILABLE
```

`DISCOVERED` means the directory exists but is not ready. `AVAILABLE` is a valid immutable snapshot that is not current. A failed import never changes `active.json`.
Failed versions are not retried automatically because version directories are immutable; correct the export under a new version name.

## Activation transaction

1. Read source files only after `READY` exists.
2. Write normalized output under `snapshots/.<version>.staging-*`.
3. Validate all records and ensure at least one subject.
4. Load the generated index into a candidate in-memory store.
5. Rename staging to `snapshots/<version>`.
6. Write `active.json.tmp-*` and rename it to `active.json`.
7. Swap the service's in-memory store.

Steps 5 and 6 use same-filesystem renames. `imports`, `snapshots`, and `active.json` must therefore remain under one `KNOWLEDGE_DATA_ROOT`.

## Resolution behavior

### Filename

1. Strip release group, extension, and technical tags to create a retrieval hint.
2. Search the active subject index and cap candidates at `KNOWLEDGE_MAX_CANDIDATES`.
3. Send the original filename, hint, and candidates to the LLM.
4. Validate title, season, episode, selected canonical key, and confidence.
5. Resolve the selected key back to the server-owned candidate object.
6. Reject candidate-set escape instead of accepting an invented ID.

### Event

1. Receive bounded evidence and a deterministic baseline from Resolution Agent.
2. Build a valid 2k–8k working projection of the baseline. Add collection rows round-robin by semantic priority so links cannot consume the whole baseline budget before sessions, exhibitors, guests, or updates are represented.
3. Deterministically collect bounded entity queries from event aliases/organizers, exhibitors, sessions, guests, updates, tags, and structured assertion values.
4. Retrieve subjects, discard weak matches, deduplicate by canonical key, sort by retrieval score, and bound each relationship neighborhood.
5. Add candidates one at a time while the complete resolution prompt remains within the configured budget.
6. Make one LLM call for `knowledgeEventEnrichmentSchema`: event text corrections, related subjects/relations, and subject/person target patches keyed by `externalKey`.
7. Pass the JSON Schema to Ollama/OpenAI-compatible structured-output mode, parse and validate the patch, then merge it into the complete deterministic baseline.
8. Remove the deterministic-fallback-only warning after a successful model result; retain substantive conflict/data-quality warnings and return budget/provider metrics.

### Prompt budget semantics

- Default complete-prompt budget: 24,000 estimated tokens.
- The budget includes system instructions, the bounded deterministic baseline projection, compacted evidence, selected Bangumi candidates, and chat framing.
- Resolution Agent's default evidence cap is 15,000. It subtracts the projected baseline plus a 7,000-token instruction/knowledge reserve and never masks an exhausted budget with an artificial minimum.
- The estimator is deliberately conservative for JSON punctuation and mixed English/CJK content. Provider-reported counts are recorded separately and remain authoritative.
- Output tokens share Ollama's context window but are not part of the input estimate; the default 24k budget leaves about 8k tokens when `num_ctx=32768`.
- Event enrichment output is capped at 4,096 tokens. With a 32,768-token model context and a 24k input budget, this leaves headroom and avoids asking the model to repeat crawler-owned arrays.
- If evidence alone cannot fit, the service returns `413`; it does not silently drop crawler evidence because only Resolution Agent understands crawler ranking semantics.

## Identity

```text
canonicalKey = bangumi:<entityType>:<rawId>
```

The exact legacy numeric transform from `uniqueIdHelper.js` is preserved as `encodedId`. It is not a primary key because it has a known collision and crosses entity namespaces.

## Codex MCP adapter

`src/mcp.ts` starts a separate stdio process and forwards only bounded read-only queries over loopback HTTP to this service. Its tool surface is `search_subjects`, `get_subject`, `search_people`, and `get_person`. The adapter contains no model client and does not call `/v1/resolve/event`; an A/B test using it compares Codex parsing against the local agent while allowing both to use the same Bangumi snapshot. Tool results carry `knowledgeVersion`, and event-to-entity links still need crawler document provenance. See [MCP setup and contract](mcp.md).

## Consistency

- Each response uses one in-memory active snapshot.
- `knowledgeVersion` identifies the snapshot used.
- In-flight requests may finish on the previous snapshot during activation; new requests use the new snapshot.
- Snapshots are immutable after creation.

## Failure model

- Invalid/missing input: `400`.
- Unknown exact Bangumi ID: `404`.
- Missing/invalid bearer token: `401`.
- Prompt exceeds the configured model-input budget: `413`.
- KB or model not ready: `503`.
- Model, index, or trusted internal failure: `500`.
- Resolution Agent treats service failure as a deterministic event fallback and records a warning.
