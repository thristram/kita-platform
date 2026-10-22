import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../src/config.js";
import { resolveEvent } from "../src/pipelines/event.js";

const documentId = "11111111-1111-4111-8111-111111111111";
const config: AgentConfig = {
  apiBaseUrl: "http://localhost:3009", token: "", agentId: "test", pollIntervalMs: 1_000,
  leaseSeconds: 600, maxDocumentBytes: 1_000_000, maxContextChars: 10_000, evidenceTokenBudget: 8_000,
  knowledgePromptTokenBudget: 24_000,
  knowledgeServiceBaseUrl: "", knowledgeServiceToken: "", knowledgeServiceTimeoutMs: 1_000,
};

test("deterministic fallback preserves structured schedule and exhibitor records", async () => {
  const result = await resolveEvent(
    config,
    {} as never,
    { enabled: false } as never,
    { id: "22222222-2222-4222-8222-222222222222", type: "EVENT_RESOLUTION", attempt: 1, maxAttempts: 3, leaseToken: "x".repeat(20), leaseExpiresAt: new Date().toISOString(), input: { crawlRunId: "33333333-3333-4333-8333-333333333333", sourceId: "44444444-4444-4444-8444-444444444444", documentIds: [documentId], knownEventId: null, resolutionMode: "AUTO" } },
    {
      contractVersion: "1.0", jobId: "22222222-2222-4222-8222-222222222222",
      crawlRun: { id: "33333333-3333-4333-8333-333333333333", sourceId: "44444444-4444-4444-8444-444444444444", sourceName: "Anime Expo Official", rootUrl: "https://www.anime-expo.org/", rootEventId: null },
      documents: [{
        id: documentId, canonicalUrl: "https://www.anime-expo.org/schedule", title: "Schedule", pageType: "SCHEDULE",
        mimeType: "text/html", fetchedAt: new Date().toISOString(), textPreview: "", contentUrl: `http://localhost/content/${documentId}`,
        assertions: [
          { id: "55555555-5555-4555-8555-555555555555", fieldPath: "title", value: "Anime Expo 2027", normalizedValue: "Anime Expo 2027", confidence: 0.9, locator: "h1", excerpt: "Anime Expo 2027" },
          { id: "66666666-6666-4666-8666-666666666666", fieldPath: "content.sessions", value: [{ externalKey: "session:frieren", title: "Frieren Symphony Showcase", startDate: "2027-07-02T10:30:00-07:00", room: "Petree Hall" }], normalizedValue: [{ externalKey: "session:frieren", title: "Frieren Symphony Showcase", startDate: "2027-07-02T10:30:00-07:00", room: "Petree Hall" }], confidence: 0.85, locator: "structured:sessions", excerpt: "Frieren Symphony Showcase" },
          { id: "77777777-7777-4777-8777-777777777777", fieldPath: "content.exhibitors", value: [{ externalKey: "exhibitor:gsc", name: "Good Smile Company", booth: "E-301", categories: ["Figures"] }], normalizedValue: [{ externalKey: "exhibitor:gsc", name: "Good Smile Company", booth: "E-301", categories: ["Figures"] }], confidence: 0.8, locator: "structured:exhibitors", excerpt: "Good Smile Company" },
        ],
        chunks: [], media: [],
      }],
    },
  );

  assert.equal(result.result.schemaVersion, "event-content-bundle/v2");
  assert.equal(result.result.sessions[0]?.sessionType, "CONCERT");
  assert.equal(result.result.sessions[0]?.sourceDocumentIds[0], documentId);
  assert.equal(result.result.exhibitors[0]?.booth, "E-301");
  assert.deepEqual(result.result.activities.map((item) => item.activityType), ["CONCERT", "OFFICIAL_BOOTH"]);
});

test("LLM-required jobs fail instead of silently using deterministic output", async () => {
  await assert.rejects(() => resolveEvent(
    config,
    {} as never,
    { enabled: false } as never,
    { id: "22222222-2222-4222-8222-222222222223", type: "EVENT_RESOLUTION", attempt: 1, maxAttempts: 3, leaseToken: "x".repeat(20), leaseExpiresAt: new Date().toISOString(), input: { crawlRunId: "33333333-3333-4333-8333-333333333333", sourceId: "44444444-4444-4444-8444-444444444444", documentIds: [documentId], knownEventId: null, resolutionMode: "LLM_REQUIRED" } },
    {
      contractVersion: "1.0", jobId: "22222222-2222-4222-8222-222222222223",
      crawlRun: { id: "33333333-3333-4333-8333-333333333333", sourceId: "44444444-4444-4444-8444-444444444444", sourceName: "Anime Expo Official", rootUrl: "https://www.anime-expo.org/", rootEventId: null },
      documents: [{ id: documentId, canonicalUrl: "https://www.anime-expo.org/", title: "Anime Expo", pageType: "EVENT", mimeType: "text/html", fetchedAt: new Date().toISOString(), textPreview: "", contentUrl: `http://localhost/content/${documentId}`, assertions: [], chunks: [], media: [] }],
    },
  ), /LLM_REQUIRED/);
});
