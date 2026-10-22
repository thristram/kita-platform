# Kita Evidence Pipeline

Status: implemented (`evidence-preparation/v1`)
Bundle contract: `candidate-evidence-bundle/v2`

## Purpose and requirements

This standalone TypeScript package prepares one crawl run before deterministic resolution, local LLM inference, or a manual Codex A/B run. It reduces repeated context without deleting the original crawler artifacts.

Functional requirements:

- group equivalent RawDocuments;
- merge duplicate assertions while retaining every supporting `sourceDocumentId`;
- deduplicate repeated navigation/boilerplate chunks;
- canonicalize media URLs and retain aliases and provenance;
- merge repeated `content.sessions`, `content.exhibitors`, and other structured collections;
- report competing scalar values as conflicts;
- generate stable preparation statistics and an input hash;
- let downstream consumers use the prepared view while raw HTML/JSON/PDF stays immutable.

Non-functional requirements:

- TypeScript/JavaScript and no model dependency;
- deterministic for the same input (except caller-supplied `preparedAt`);
- usable by the Console export route and Resolution Agent;
- never fabricate event facts or canonical identities;
- bounded work: normalization is performed per record and exact/shape keys avoid all-pairs comparisons.

## State and ownership

```text
Crawl complete
  -> Evidence prepared (this package)
  -> Processed (deterministic and/or LLM + KB)
  -> Editorial review
  -> Published
```

The package is stateless. PostgreSQL/R2 remain the source of truth. The caller supplies one `ResolutionInput`; the package returns a prepared index. Raw artifacts are neither fetched nor modified here.

## API

### `prepareResolutionEvidence(input, preparedAt?)`

Input: `ResolutionInput` from `@kita/contracts`, including documents and their assertions, chunks, and media.

Output: `PreparedEvidence`:

- `schemaVersion`: `candidate-evidence-bundle/v2`;
- `pipelineVersion`: `evidence-preparation/v1`;
- `inputHash`, `preparedAt`, and input/prepared/removed counts;
- `documentGroups` with canonical and equivalent document IDs;
- deduplicated `assertions`, `chunks`, and `media` with occurrence counts and provenance;
- merged `collections` keyed by assertion path;
- scalar `conflicts` and non-fatal `warnings`.

### `applyPreparedEvidence(input, prepared)`

Returns a smaller `ResolutionInput` for deterministic parsing and model compaction. Collection assertions use the merged records and every retained item still references a valid raw document.

### `canonicalMediaUrl(url)`

Removes tracking/resizing variants used only for delivery and returns a stable media identity. Original URLs remain in `aliases`.

## Setup and commands

From the repository root:

```bash
npm install
npm run evidence:build
npm run evidence:test
```

The package has no service port, credentials, database, model, or environment variables. It is deliberately a reusable library rather than a network service because preparation is pure and must run beside both the export path and the agent.

## Failure behavior

- Invalid `ResolutionInput` must be rejected by `@kita/contracts` before calling this package.
- Unknown/opaque values are preserved in assertions; they are not coerced into facts.
- Conflicting scalar values are emitted in `conflicts`, not silently selected.
- Raw files in a Bundle v2 export remain available even if a preparation heuristic groups them.

## Versioning

Changing normalization, merge keys, provenance shape, or bundle file layout requires a new `pipelineVersion`. Removing or renaming exported files requires a new bundle schema version.
