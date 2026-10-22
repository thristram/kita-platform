import assert from "node:assert/strict";
import test from "node:test";
import type { ResolutionInput } from "@kita/contracts";
import { prepareResolutionEvidence } from "../src/index.js";

const input: ResolutionInput = {
  contractVersion: "1.0", jobId: "00000000-0000-4000-8000-000000000001",
  crawlRun: { id: "00000000-0000-4000-8000-000000000002", sourceId: "00000000-0000-4000-8000-000000000003", sourceName: "Test", rootUrl: "https://example.test", rootEventId: null },
  documents: ["1", "2"].map((suffix) => ({
    id: `00000000-0000-4000-8000-00000000000${Number(suffix) + 3}`, canonicalUrl: "https://example.test/schedule", title: "Schedule", pageType: "SCHEDULE", mimeType: "text/html", fetchedAt: "2026-01-01T00:00:00.000Z", textPreview: "same", contentUrl: "https://example.test/raw",
    assertions: [{ id: `00000000-0000-4000-8000-00000000001${suffix}`, fieldPath: "content.sessions", value: [{ externalKey: "opening", title: "Opening", room: suffix === "2" ? "Main" : "" }], normalizedValue: [{ externalKey: "opening", title: "Opening", room: suffix === "2" ? "Main" : "" }], confidence: .9, locator: "json", excerpt: "Opening" }],
    chunks: [{ index: 0, heading: "Schedule", content: "Opening ceremony at the main stage." }],
    media: [{ id: `00000000-0000-4000-8000-00000000002${suffix}`, url: `https://img.test/hero-1200x600.jpg?width=${suffix}00`, category: "EVENT_HERO", score: .8, width: 1200, height: 600, mimeType: "image/jpeg" }],
  })),
};

test("prepares a provenance-preserving deduplicated evidence index", () => {
  const result = prepareResolutionEvidence(input, "2026-01-01T00:00:00.000Z");
  assert.equal(result.stats.input.documents, 2);
  assert.equal(result.stats.prepared.documents, 1);
  assert.equal(result.stats.prepared.chunks, 1);
  assert.equal(result.stats.prepared.media, 1);
  assert.equal(result.collections["content.sessions"]?.length, 1);
  assert.equal(result.collections["content.sessions"]?.[0]?.room, "Main");
  assert.equal(result.collections["content.sessions"]?.[0]?.sourceDocumentIds.length, 2);
});
