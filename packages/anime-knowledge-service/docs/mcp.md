# Codex MCP: read-only Bangumi queries

## Purpose and boundary

The local stdio MCP adapter lets Codex query the **same active Bangumi snapshot** as Anime Knowledge Service while writing an `event-content-bundle/v2` from a Candidate evidence ZIP. It does not invoke Ollama, resolve an event, read KitaCon's database, edit a Candidate, or publish anything. It is deliberately a retrieval surface, not a second resolution pipeline.

The adapter lives at `src/mcp.ts` and forwards four bounded read-only tools to the running service on loopback. Search results establish possible canonical identity; **event participation still requires a crawler document ID and a factual claim in that document**. A Bangumi relation between two subjects is not evidence that either appears at a convention.

## Requirements

- Node.js >=22.13, the monorepo dependencies, and `npm run knowledge:build`.
- Anime Knowledge Service running on `http://127.0.0.1:4320` with an active Bangumi snapshot. Ollama is **not required** for these KB queries; `/ready` may be 503 if the model is down while `kbReady` is true in `/v1/knowledge/status`.
- A **local** Codex environment on the same Mac. A remote/cloud Codex environment cannot reach this Mac's loopback address. Do not make this endpoint public simply to work around that.
- When the Knowledge Service requires a bearer token, configure `KNOWLEDGE_SERVICE_TOKEN` in the service and the MCP process environment. Never paste it into a prompt or Candidate ZIP.

## Install and connect

From the repository root:

```bash
cd /Users/thristram/Developer/kita-platform
npm install
npm run knowledge:build
npm run knowledge:dev
```

In another terminal, verify the KB rather than model readiness:

```bash
curl http://127.0.0.1:4320/v1/knowledge/status
```

Look for `"kbReady":true` and a non-null `activeVersion`. If a token is configured, add the bearer authorization header to this check.

Register the local stdio process with Codex once:

```bash
codex mcp add kitaAnimeKb -- node /Users/thristram/Developer/kita-platform/packages/anime-knowledge-service/dist/mcp.js
codex mcp list
```

The MCP process loads `.env.local` from the repository root first, then from `packages/anime-knowledge-service/`. It also accepts `KNOWLEDGE_SERVICE_BASE_URL` and `KNOWLEDGE_SERVICE_TOKEN` from its environment. The URL is restricted to an HTTP loopback origin. Keep the token in a local, ignored env file; do not put its literal value in `codex mcp add --env` or a committed configuration file. After adding the MCP, start a **new Codex conversation/session** so its tool list is refreshed. The Knowledge Service must keep running while Codex queries it.

If the Knowledge Service is already running, do not start another copy on port 4320. `npm run knowledge:mcp` runs the adapter directly for another MCP client; it is a protocol process, so it waits silently on stdin and is not an interactive test command.

## Tool contract

All tools are read-only, bounded, and return structured JSON. The service's active `knowledgeVersion` accompanies every successful result. `canonicalKey` is the durable identity; `encodedId` is the existing legacy compatibility transform and can collide.

| Tool | Input | Output | Meaning |
| --- | --- | --- | --- |
| `search_subjects` | `{ "queries": ["葬送的芙莉莲"], "limit": 5 }` | `knowledgeVersion`, `matches[]` with query, subject reference, names, score | Find anime/manga/other Bangumi subject candidates. |
| `get_subject` | `{ "rawId": 400602 }` | version, exact subject reference, `type`, names, aliases, `relatedSubjects[]`, `people[]` | Verify one ID and inspect archived subject/person edges. `relationType` and `position` are raw Archive numeric codes. |
| `search_people` | `{ "queries": ["person name"], "limit": 5 }` | version, `matches[]` with query, person reference, name, career, score | Find Bangumi person candidates; exact/partial name matching. |
| `get_person` | `{ "rawId": 1234 }` | version, exact person reference, name, career | Verify one person ID. |

Search accepts 1–10 non-empty queries of up to 500 characters, with 1–20 matches per query; default limit is 5. Exact lookup accepts a positive safe integer `rawId`. Missing IDs return a tool error backed by HTTP 404. A missing active KB returns HTTP 503. The tools do not expose import scans or `/v1/resolve/*`.

The current Archive index does **not** provide an MCP character search or a canonical company/organization search. Do not fabricate their Bangumi IDs; retain source-backed names and put unresolved canonical links in `warnings` or leave their targets null.

## A/B workflow and quality rules

1. Export the Candidate evidence ZIP and open its `PROMPT.md`.
2. In a local Codex session with `kitaAnimeKb` available, upload the ZIP and follow the prompt. Ask Codex to use `search_subjects`/`search_people`, then exact lookup for any proposed Bangumi IDs.
3. Require crawler evidence (`sourceDocumentIds`) for each event-to-entity relation. Do not use the KB alone as event evidence.
4. Save the returned JSON and import it into the Candidate editor. Note the MCP `knowledgeVersion` next to the A/B run so local-agent and Codex results can be compared against the same snapshot.

If the MCP is unavailable, Codex may still format the crawl evidence, but should leave unverified Bangumi targets unresolved rather than guess IDs. Neither branch calls the local Qwen event-resolution endpoint through MCP, preserving the model comparison.

## Security and operations

- The adapter accepts no arbitrary URL, file path, SQL, or write operation from the model.
- `KNOWLEDGE_SERVICE_BASE_URL` must be a loopback `http://` origin; the bearer token stays inside the local process and is never returned as a tool result.
- The underlying service still enforces its own `/v1/*` authentication.
- The MCP protocol uses stdout; startup errors use stderr. Do not add `console.log` calls to `src/mcp.ts`.
- To update tool definitions, rebuild and restart the Codex session. To change the active KB, import a new `READY` snapshot through the existing service and verify `knowledgeVersion` on subsequent calls.
