# API and data contracts

## General rules

- Internal prefix: `/api/internal/v1/resolution`
- Authentication: `Authorization: Bearer <KITACON_AGENT_TOKEN>`
- JSON content type for requests and responses
- Contract version: `1.0`
- Dates/times: ISO-8601 strings
- IDs: UUID unless explicitly documented as a Bangumi numeric ID
- Unknown request fields are rejected by shared Zod schemas
- Outside localhost, use HTTPS

The canonical executable schemas are in `packages/contracts/src/resolution-agent.ts`. Examples below are explanatory and must remain compatible with those schemas.

## 1. Health

```http
GET /api/internal/v1/resolution/health
```

No authentication is required. It proves the HTTP service is running; it does not query the database.

```json
{
  "service": "kita-resolution-control",
  "status": "ok",
  "contractVersion": "1.0"
}
```

## 2. Lease one job

```http
POST /api/internal/v1/resolution/jobs/lease
Authorization: Bearer <token>
Content-Type: application/json
```

Request:

```json
{
  "agentId": "fangchen-macbook",
  "agentVersion": "0.1.0",
  "capabilities": [
    "EVENT_RESOLUTION_V1",
    "BANGUMI_LINKING_V1"
  ],
  "leaseSeconds": 600
}
```

No work:

```json
{
  "contractVersion": "1.0",
  "job": null,
  "retryAfterMs": 10000
}
```

Work available:

```json
{
  "contractVersion": "1.0",
  "job": {
    "id": "90779fa9-0a8a-4662-8d14-5e4d722fb6ab",
    "type": "EVENT_RESOLUTION",
    "attempt": 1,
    "maxAttempts": 4,
    "leaseToken": "opaque-one-time-lease-token",
    "leaseExpiresAt": "2026-10-07T06:20:00.000Z",
    "input": {
      "crawlRunId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "sourceId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "documentIds": ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
      "knownEventId": null,
      "resolutionMode": "AUTO"
    }
  }
}
```

Leasing is atomic and uses `FOR UPDATE SKIP LOCKED`. An expired `RUNNING` job may be leased again. The plaintext lease token is returned once; only its SHA-256 digest is stored.

`resolutionMode` is `AUTO` for normal post-crawl work. A manual Candidate retry uses `LLM_REQUIRED`; in that mode the Agent must report a job failure when the Knowledge Service or LLM cannot return a valid bundle and must not submit the deterministic baseline as a successful Candidate.

## 3. Read job input

```http
GET /api/internal/v1/resolution/jobs/{jobId}/input
Authorization: Bearer <token>
X-Lease-Token: <lease-token>
```

Response:

```json
{
  "contractVersion": "1.0",
  "jobId": "90779fa9-0a8a-4662-8d14-5e4d722fb6ab",
  "crawlRun": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "sourceId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "sourceName": "Anime Expo Official",
    "rootUrl": "https://www.anime-expo.org/",
    "rootEventId": null
  },
  "documents": [
    {
      "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "canonicalUrl": "https://www.anime-expo.org/",
      "title": "Anime Expo",
      "pageType": "EVENT",
      "mimeType": "text/html",
      "fetchedAt": "2026-10-06T23:03:44.000Z",
      "textPreview": "...",
      "contentUrl": "http://localhost:3009/api/internal/v1/resolution/jobs/.../content",
      "assertions": [],
      "chunks": [],
      "media": []
    }
  ]
}
```

The response includes every document in the crawl run. Raw bytes are not embedded; `contentUrl` is lease-scoped.

## 4. Read document content

```http
GET /api/internal/v1/resolution/jobs/{jobId}/documents/{documentId}/content
Authorization: Bearer <token>
X-Lease-Token: <lease-token>
```

The API verifies that `documentId` belongs to the leased crawl run. In production it redirects to a short-lived signed R2 URL. In local artifact mode it streams the validated file. Cross-run IDs return `404`.

## 5. Heartbeat

```http
POST /api/internal/v1/resolution/jobs/{jobId}/heartbeat
```

```json
{
  "leaseToken": "opaque-one-time-lease-token",
  "extendBySeconds": 300
}
```

Response:

```json
{
  "leaseExpiresAt": "2026-10-07T06:25:00.000Z"
}
```

An expired or invalid lease returns `409`.

## 6. Complete a job

```http
POST /api/internal/v1/resolution/jobs/{jobId}/complete
```

```json
{
  "contractVersion": "1.0",
  "leaseToken": "opaque-one-time-lease-token",
  "result": {
    "schemaVersion": "event-content-bundle/v2",
    "event": {
      "name": "Anime Expo 2026",
      "alternateNames": [],
      "eventType": "CONVENTION",
      "description": "...",
      "startDate": "2026-07-02",
      "endDate": "2026-07-05",
      "timezone": "America/Los_Angeles",
      "venue": {
        "name": "Los Angeles Convention Center",
        "addressLine1": "1201 S Figueroa St",
        "city": "Los Angeles",
        "region": "CA",
        "postalCode": "90015",
        "countryCode": "US"
      },
      "officialUrl": "https://www.anime-expo.org/",
      "organizerNames": ["SPJA"]
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
    "relations": [
      {
        "type": "FEATURES_SUBJECT",
        "target": {
          "provider": "bangumi",
          "entityType": "subject",
          "rawId": 123,
          "encodedId": 402970710,
          "canonicalKey": "bangumi:subject:123"
        },
        "label": "Example subject",
        "confidence": 0.93,
        "evidenceDocumentIds": ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]
      }
    ],
    "media": [],
    "evidence": [
      {
        "field": "event.startDate",
        "sourceDocumentId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "method": "json-ld",
        "quote": "Jul 2–5, 2026",
        "confidence": 0.98
      }
    ],
    "conflicts": [],
    "warnings": [],
    "confidence": 0.91
  },
  "model": {
    "provider": "ollama-local",
    "name": "kita-qwen3.5:9b-q4",
    "promptVersion": "event-enrichment-patch-v6"
  },
  "metrics": {
    "durationMs": 42310,
    "inputTokens": 22100,
    "outputTokens": 1900
  }
}
```

Response:

```json
{
  "candidateId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "reused": false
}
```

Completion behavior:

1. validate the schema;
2. validate every evidence document against the leased crawl run;
3. create one `EVENT_RESOLUTION` Candidate;
4. attach every raw document in the run through `candidate_evidence`;
5. mark pending page-level Candidates from the run `SUPERSEDED`;
6. store model metadata and metrics in the Candidate payload;
7. mark the job `SUCCEEDED`.

The executable V2 schema additionally defines every nested field for `links`, `facts`, `ticketOffers`, `exhibitors`, `sessions`, `guests`, `updates`, `activities`, and `relatedSubjects`. Each row has `sourceDocumentIds` and `confidence`; completion rejects document IDs or media-candidate IDs outside the leased crawl run. Approval/linking writes these collections to the normalized `event.*` content tables. See [`../../../docs/event-content-population.md`](../../../docs/event-content-population.md) for the UI-to-storage mapping.

`EVENT_RESOLUTION` jobs are created for the official Website connector. AnimeCons directory runs are excluded because one directory crawl may contain many independent events and that connector already materializes them deterministically.

The operation is idempotent by `job_id`. A repeated completion returns the existing Candidate with `reused: true`.

## 7. Report failure

```http
POST /api/internal/v1/resolution/jobs/{jobId}/fail
```

```json
{
  "leaseToken": "opaque-one-time-lease-token",
  "errorCode": "MODEL_TIMEOUT",
  "message": "Local model exceeded 600000 ms",
  "retryable": true
}
```

Retryable jobs become `RETRY_WAIT` with exponential backoff. Non-retryable or exhausted jobs become `DEAD`.

## Anime Knowledge Service boundary

Resolution Agent no longer exposes a local utility API or filename endpoint. It calls Anime Knowledge Service `POST /v1/resolve/event`. Filename resolution, subject search, imports, and KB/model readiness are documented in [Anime Knowledge Service API](../../anime-knowledge-service/docs/api.md).

## Error status codes

| Status | Meaning |
| --- | --- |
| `400` | malformed request or schema failure |
| `401` | missing/invalid service token |
| `404` | job-scoped document not found |
| `409` | lease missing, invalid, or expired |
| `422` | valid JSON references evidence outside the job |
| `500` | unexpected trusted API failure |
| `503` | KitaCon control API is not configured or ready |
