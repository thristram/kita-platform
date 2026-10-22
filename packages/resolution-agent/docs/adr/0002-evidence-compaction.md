# ADR 0002: compact crawler evidence before model inference

## Status

Accepted, 2026-10-07.

## Context

One official event crawl may contain dozens of pages that repeat the same site-wide description, JSON-LD assertions, navigation chunks, and responsive image variants. Sending every record made the Anime Expo prompt 37,895 tokens while the configured Ollama context was 32,768. Raising model context alone increases memory and latency and does not bound future crawls or Bangumi graph expansion.

## Decision

The shared `@kita/evidence-pipeline` first creates a lossless, provenance-preserving prepared view for the complete run. Resolution Agent then deterministically compacts that prepared evidence before calling Anime Knowledge Service. It ranks assertions, chunks, media, and fallback text under an adaptive budget capped at 15k estimated tokens. The actual V2 baseline is measured first and can lower the evidence cap. Different normalized values for the same field are retained as potential conflicts. No LLM is used for either step.

Anime Knowledge Service independently enforces a 24k complete-prompt budget after adding instructions, a balanced baseline projection, and Bangumi candidates. It derives lookup queries without another model call, skips lower-ranked knowledge candidates that do not fit, and asks Ollama only for a JSON-Schema-constrained enrichment patch.

The shared estimator is conservative and tokenizer-independent. Actual provider token counts remain authoritative and are returned when available.

## Consequences

- Repeated site boilerplate no longer consumes most of the context window.
- Model memory and latency stay predictable on the 24 GB M4 target.
- Full raw evidence remains in KitaCon and can still be reviewed/exported; preparation creates indexes, while compaction changes only model input.
- The model may not see low-ranked evidence, so compaction counts and budgets are observable and configurable.
- Exact tokenizer parity is not guaranteed; a safety margin remains mandatory.
