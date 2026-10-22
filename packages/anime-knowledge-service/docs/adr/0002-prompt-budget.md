# ADR 0002: enforce a complete event-prompt budget

## Status

Accepted, 2026-10-07.

## Context

Resolution Agent can bound crawler evidence, but it cannot know how much space Anime Knowledge Service will add for instructions, deterministic baseline, Bangumi search matches, and relationship neighborhoods. The first Anime Expo test sent 37,895 tokens into a 32,768-token Ollama context and failed before generation.

## Decision

The single event-enrichment LLM call is checked against `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET`, default 24,000 estimated input tokens. The service rejects oversized evidence before inference. Before building the prompt it converts the deterministic Event Bundle to a valid working projection whose budget is 35% of the complete prompt budget, bounded to 2,000–8,000 tokens. Collections are admitted round-robin so one large link list cannot starve schedules, exhibitors, guests, or updates. Retrieved subjects are deduplicated by canonical key and ranked; relationship neighborhoods are bounded and candidates are added only while the final prompt fits.

Entity queries are derived deterministically from typed baseline/evidence fields. This removes the former 9k-input mention-extraction model call that reached the five-minute local timeout. The model returns only a JSON-Schema-constrained enrichment patch instead of repeating `event-content-bundle/v2`; the service merges that patch into the complete input baseline by stable key. Resolution Agent performs the same protective merge against its locally retained full baseline.

Event enrichment is capped at 4,096 output tokens. Ollama receives the patch JSON Schema as `format`, `think: false`, and `stream: false`. Empty output and invalid schema output fail explicitly and are never persisted.

The service returns both conservative estimates and provider-reported token counts. The single-pass prompt version is `event-enrichment-patch-v6`.

## Consequences

- A 32k Ollama context retains at least 4k tokens for the bounded enrichment patch.
- Knowledge graph growth cannot unexpectedly consume the whole context window.
- Direct API consumers receive actionable `413` failures instead of opaque Ollama errors.
- A large deterministic baseline is projected and restored; only irreducibly oversized crawler evidence receives `413`.
- Resolution Agent must keep its evidence-only budget below this complete-prompt budget.
