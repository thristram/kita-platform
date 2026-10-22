# API, inputs, and outputs

## General rules

- Default origin: `http://127.0.0.1:4320`
- Content type: `application/json`
- `/health` and `/ready` are unauthenticated.
- When `KNOWLEDGE_SERVICE_TOKEN` is configured, every `/v1/*` request requires `Authorization: Bearer <token>`.
- Unknown routes return `404`.
- Model reasoning/thinking is neither returned nor included in response schemas.

## 1. Health

```http
GET /health
```

```json
{
  "status": "ok",
  "service": "anime-knowledge-service"
}
```

This proves the HTTP process is running. It does not prove KB/model readiness.

## 2. Readiness

```http
GET /ready
```

Ready response (`200`):

```json
{
  "ready": true,
  "kbReady": true,
  "modelConfigured": true,
  "modelReady": true,
  "activeVersion": "bangumi-2026-10-07"
}
```

The same shape is returned with `503` when either KB or the configured model tag is unavailable. `modelConfigured` means the endpoint and tag are present in configuration; `modelReady` means the runtime currently lists that exact tag.

## 3. Knowledge status

```http
GET /v1/knowledge/status
```

```json
{
  "service": "anime-knowledge-service",
  "ready": true,
  "kbReady": true,
  "modelConfigured": true,
  "modelReady": true,
  "activeVersion": "bangumi-2026-10-07",
  "counts": {
    "subjects": 540123,
    "persons.jsonl": 78124,
    "characters.jsonl": 166201,
    "episodes.jsonl": 1829043
  },
  "model": {
    "provider": "ollama-local",
    "name": "kita-qwen3.5:9b-q4"
  }
}
```

## 4. Import status

```http
GET /v1/knowledge/imports
```

```json
{
  "activeVersion": "bangumi-2026-10-07",
  "imports": [
    {
      "version": "bangumi-2026-10-07",
      "status": "ACTIVE",
      "discoveredAt": "2026-10-07T20:00:00.000Z",
      "completedAt": "2026-10-07T20:04:15.000Z",
      "error": null,
      "counts": {
        "subjects": 540123
      }
    }
  ]
}
```

Statuses: `DISCOVERED`, `INDEXING`, `ACTIVE`, `FAILED`, `AVAILABLE`.

## 5. Trigger import scan

```http
POST /v1/knowledge/imports/scan
```

No request body. The response has the same shape as `GET /v1/knowledge/imports`. It waits for newly ready imports discovered by that scan to finish indexing.

## 6. Search subjects

```http
POST /v1/search/subjects
Content-Type: application/json
```

Input:

```json
{
  "queries": ["芙莉莲", "Sousou no Frieren"],
  "limit": 10
}
```

Constraints:

- `queries`: 1–50 non-empty strings, maximum 500 characters each;
- `limit`: integer 1–50, default 10, applied per query.

Output:

```json
{
  "knowledgeVersion": "bangumi-2026-10-07",
  "matches": [
    {
      "query": "芙莉莲",
      "subject": {
        "provider": "bangumi",
        "entityType": "subject",
        "rawId": 400602,
        "encodedId": 123456789,
        "canonicalKey": "bangumi:subject:400602"
      },
      "name": "葬送のフリーレン",
      "nameCn": "葬送的芙莉莲",
      "score": 1
    }
  ]
}
```

The `encodedId` above is illustrative; consumers must treat `canonicalKey` as identity.

## 6a. Search people

```http
POST /v1/search/people
Content-Type: application/json
```

Input has the same `queries` and `limit` constraints as subject search. Output is `{ "knowledgeVersion": "...", "matches": [{ "query": "...", "person": { "provider": "bangumi", "entityType": "person", "rawId": 1234, "encodedId": 5678, "canonicalKey": "bangumi:person:1234" }, "name": "...", "career": [], "score": 1 }] }`. The `encodedId` example is illustrative. The current person index searches exact or partial names; it does not claim event attendance.

## 6b. Exact subject and person lookup

```http
GET /v1/subjects/:rawId
GET /v1/people/:rawId
```

`rawId` must be a positive safe integer. Both responses include `knowledgeVersion` and the canonical Bangumi reference. Subject lookup also returns `type`, `name`, `nameCn`, `aliases`, `relatedSubjects[]`, and `people[]` from the indexed Archive. The subject relation `relationType` and person `position` are raw Archive numeric values, not event relationships. Person lookup returns `name` and `career`. Unknown IDs return 404; an unavailable active KB returns 503.

The read-only [Codex MCP adapter](mcp.md) forwards only these endpoints and subject search; it never exposes the model-backed resolution endpoints.

## 7. Resolve release filename

```http
POST /v1/resolve/filename
Content-Type: application/json
```

Input:

```json
{
  "value": "[SweetSub&LoliHouse] Koori no Jouheki - 15 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv"
}
```

Output:

```json
{
  "input": "[SweetSub&LoliHouse] Koori no Jouheki - 15 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv",
  "normalizedTitle": "Koori no Jouheki",
  "season": null,
  "episode": 15,
  "selectedMatch": {
    "subject": {
      "provider": "bangumi",
      "entityType": "subject",
      "rawId": 425911,
      "encodedId": 285562728,
      "canonicalKey": "bangumi:subject:425911"
    },
    "name": "Koori no Jouheki",
    "nameCn": "冰之城墙",
    "score": 1
  },
  "matches": [
    {
      "subject": {
        "provider": "bangumi",
        "entityType": "subject",
        "rawId": 425911,
        "encodedId": 285562728,
        "canonicalKey": "bangumi:subject:425911"
      },
      "name": "Koori no Jouheki",
      "nameCn": "冰之城墙",
      "score": 1
    }
  ],
  "resolutionMethod": "llm-kb",
  "confidence": 0.98
}
```

`selectedMatch` is `null` when no supplied candidate is supported. The service rejects an ID invented outside `matches`.

## 8. Resolve event

```http
POST /v1/resolve/event
Content-Type: application/json
```

Input:

```json
{
  "baseline": {
    "schemaVersion": "event-content-bundle/v2",
    "event": {
      "name": "Anime Expo 2026",
      "alternateNames": [],
      "eventType": "CONVENTION",
      "description": "",
      "startDate": "2026-07-02",
      "endDate": "2026-07-05",
      "timezone": "America/Los_Angeles",
      "venue": {
        "name": "Los Angeles Convention Center",
        "addressLine1": "",
        "city": "Los Angeles",
        "region": "CA",
        "postalCode": "",
        "countryCode": "US"
      },
      "officialUrl": "https://www.anime-expo.org/",
      "organizerNames": []
    },
    "links": [],
    "facts": [],
    "ticketOffers": [],
    "exhibitors": [],
    "sessions": [],
    "guests": [],
    "updates": [],
    "activities": [],
    "relatedSubjects": [],
    "relations": [],
    "media": [],
    "evidence": [
      {
        "field": "event.name",
        "sourceDocumentId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "method": "crawler-assertion",
        "quote": "Anime Expo 2026",
        "confidence": 0.9
      }
    ],
    "conflicts": [],
    "warnings": [],
    "confidence": 0.8
  },
  "evidence": {
    "crawlRun": {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "sourceName": "Anime Expo Official"
    },
    "documents": [
      {
        "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "url": "https://www.anime-expo.org/",
        "title": "Anime Expo",
        "assertions": [],
        "chunks": [],
        "rawText": "bounded text selected by Resolution Agent",
        "media": []
      }
    ]
  }
}
```

Output:

```json
{
  "result": {
    "schemaVersion": "event-content-bundle/v2",
    "event": {},
    "links": [],
    "facts": [],
    "ticketOffers": [],
    "exhibitors": [],
    "sessions": [],
    "guests": [],
    "updates": [],
    "activities": [],
    "relatedSubjects": [],
    "relations": [],
    "media": [],
    "evidence": [],
    "conflicts": [],
    "warnings": [],
    "confidence": 0.91
  },
  "knowledgeVersion": "bangumi-2026-10-07",
  "model": {
    "provider": "ollama-local",
    "name": "kita-qwen3.5:9b-q4",
    "promptVersion": "event-enrichment-patch-v6"
  },
  "metrics": {
    "inputTokens": 22000,
    "outputTokens": 1800,
    "estimatedInputTokens": 23840,
    "evidenceTokens": 17920,
    "baselineTokens": 6120,
    "baselineSourceTokens": 52927,
    "knowledgeCandidates": 14
  }
}
```

The abbreviated `result` above must contain the full `event-content-bundle/v2` fields in an actual response, including content collections and their source document IDs. The executable schema is in `packages/contracts/src/resolution-agent.ts`; the UI/storage mapping is in `docs/event-content-population.md`.

Resolution Agent supplies compacted evidence and the complete deterministic baseline. The service creates a balanced prompt projection, deterministically derives Bangumi queries, admits ranked knowledge candidates only while the final prompt fits, and makes one structured-output model call. The model returns `knowledgeEventEnrichmentSchema`, not the complete bundle; the service merges that patch into the complete baseline before returning `result`. `inputTokens` is provider-reported when available; `estimatedInputTokens`, `evidenceTokens`, `baselineTokens`, and `baselineSourceTokens` use the shared conservative estimator. `mentionInputTokens` is retained as an optional backwards-compatible metrics field but is not emitted by the v6 event pipeline.

Event enrichment output is capped at 4,096 tokens. Ollama receives the patch JSON Schema directly, so non-JSON, truncated, empty, or schema-invalid output fails rather than being persisted.

## Error status codes

| Status | Meaning |
| --- | --- |
| `400` | malformed JSON or contract validation failure |
| `401` | missing or invalid configured bearer token |
| `404` | route not found |
| `413` | compacted crawler evidence or the irreducible complete prompt exceeds `KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET`; a large baseline alone is projected and does not cause this response |
| `500` | import/model/internal processing failure |
| `503` | required active KB or model is unavailable |
