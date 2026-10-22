# Anime Knowledge Service integration

Bangumi Archive, generated indexes, Ollama configuration, filename resolution, and legacy Bangumi identity compatibility moved to `packages/anime-knowledge-service`.

Resolution Agent communicates only through:

```http
GET  /v1/knowledge/status
POST /v1/resolve/event
```

See:

- [Knowledge Service requirements](../../anime-knowledge-service/docs/requirements.md)
- [Knowledge Service setup](../../anime-knowledge-service/docs/setup.md)
- [Knowledge Service API](../../anime-knowledge-service/docs/api.md)

This separation lets KitaCon and unrelated local applications share one active Bangumi snapshot and one validated model layer without giving the knowledge service access to KitaCon's database or crawler object storage.

Before `POST /v1/resolve/event`, Resolution Agent compacts crawler evidence to an adaptive budget capped by `AGENT_EVIDENCE_TOKEN_BUDGET` (15k estimated tokens by default). It reduces that cap using the projected V2 baseline size while still sends the complete deterministic bundle for safe server-side merging. Anime Knowledge Service builds a balanced prompt projection, derives entity queries deterministically, and adds only as many Bangumi candidates as fit within `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET` (24k by default). One structured-output model call returns only the semantic enrichment patch.
