import assert from "node:assert/strict";
import test from "node:test";
import { estimateModelTokens, type ResolutionInput } from "@kita/contracts";
import { compactEventEvidence, type HydratedResolutionDocument } from "../src/pipelines/evidence-compactor.js";

const runId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";

function inputAndDocuments(): { input: ResolutionInput; documents: HydratedResolutionDocument[] } {
  const makeDocument = (id: string, url: string, pageType: string, startDate: string, mediaId: string): HydratedResolutionDocument => ({
    id,
    canonicalUrl: url,
    title: "Anime Expo 2026",
    pageType,
    mimeType: "text/html",
    fetchedAt: "2026-10-07T00:00:00.000Z",
    textPreview: "Anime Expo information",
    contentUrl: `https://artifacts.example/${id}`,
    assertions: [
      {
        id: id.replace(/^./, "a"), fieldPath: "title", value: "Anime Expo 2026", normalizedValue: "Anime Expo 2026",
        confidence: 0.98, locator: "h1", excerpt: "Anime Expo 2026",
      },
      {
        id: id.replace(/^./, "b"), fieldPath: "description", value: "The largest celebration of Japanese pop culture in North America.", normalizedValue: "The largest celebration of Japanese pop culture in North America.",
        confidence: 0.9, locator: "meta", excerpt: "The largest celebration of Japanese pop culture in North America.",
      },
      {
        id: id.replace(/^./, "c"), fieldPath: "start_date", value: startDate, normalizedValue: startDate,
        confidence: 0.92, locator: "time", excerpt: startDate,
      },
    ],
    chunks: [
      { index: 0, heading: "About", content: "Anime Expo brings fans and industry together in Los Angeles." },
      { index: 1, heading: "Dates", content: `The convention begins on ${startDate}.` },
    ],
    media: [{
      id: mediaId,
      url: "https://cdn.example/hero-1200x630.jpg?utm_source=test",
      category: "hero",
      score: pageType === "EVENT" ? 0.95 : 0.8,
      width: pageType === "EVENT" ? 1200 : 600,
      height: pageType === "EVENT" ? 630 : 315,
      mimeType: "image/jpeg",
    }],
    rawText: "Anime Expo brings fans and industry together in Los Angeles. ".repeat(200),
  });

  const documents = [
    makeDocument("31111111-1111-4111-8111-111111111111", "https://www.anime-expo.org/", "EVENT", "2026-07-02", "51111111-1111-4111-8111-111111111111"),
    makeDocument("32222222-2222-4222-8222-222222222222", "https://www.anime-expo.org/about/", "ABOUT", "2025-07-03", "52222222-2222-4222-8222-222222222222"),
  ];
  return {
    input: {
      contractVersion: "1.0",
      jobId: "41111111-1111-4111-8111-111111111111",
      crawlRun: { id: runId, sourceId, sourceName: "Anime Expo Official", rootUrl: "https://www.anime-expo.org/", rootEventId: null },
      documents,
    },
    documents,
  };
}

test("deduplicates event evidence, preserves conflicting values, and stays within budget", () => {
  const { input, documents } = inputAndDocuments();
  const compacted = compactEventEvidence(input, documents, 6_000);
  const assertions = compacted.evidence.documents.flatMap((document) => document.assertions as Array<{ fieldPath: string; normalizedValue: unknown }>);
  const dates = assertions.filter((assertion) => assertion.fieldPath === "start_date").map((assertion) => assertion.normalizedValue).sort();

  assert.deepEqual(dates, ["2025-07-03", "2026-07-02"]);
  assert.equal(assertions.filter((assertion) => assertion.fieldPath === "title").length, 1);
  assert.equal(assertions.filter((assertion) => assertion.fieldPath === "description").length, 1);
  assert.equal(compacted.evidence.documents.flatMap((document) => document.media).length, 1);
  assert.ok(compacted.stats.selected.chunks < compacted.stats.source.chunks);
  assert.ok(compacted.stats.estimatedTokens <= 6_000);
  assert.equal(compacted.stats.estimatedTokens, estimateModelTokens(compacted.evidence));
});

test("compaction is deterministic and prioritizes assertions over raw HTML", () => {
  const { input, documents } = inputAndDocuments();
  const first = compactEventEvidence(input, documents, 1_500);
  const second = compactEventEvidence(input, documents, 1_500);

  assert.deepEqual(first, second);
  assert.ok(first.stats.selected.assertions > 0);
  assert.equal(first.stats.selected.rawText, 0);
  assert.ok(first.stats.estimatedTokens <= 1_500);
});

test("splits large structured assertion arrays so useful records fit the budget", () => {
  const { input, documents } = inputAndDocuments();
  documents[0]!.assertions.push({
    id: "d1111111-1111-4111-8111-111111111111",
    fieldPath: "content.sessions",
    value: Array.from({ length: 40 }, (_, index) => ({
      externalKey: `session:${index}`,
      title: `Session ${index}`,
      description: `Useful schedule detail ${index}. `.repeat(20),
    })),
    normalizedValue: Array.from({ length: 40 }, (_, index) => ({
      externalKey: `session:${index}`,
      title: `Session ${index}`,
      description: `Useful schedule detail ${index}. `.repeat(20),
    })),
    confidence: 0.9,
    locator: "structured:sessions",
    excerpt: "Anime Expo schedule",
  });

  const compacted = compactEventEvidence(input, documents, 2_000);
  const sessionAssertions = compacted.evidence.documents
    .flatMap((document) => document.assertions as Array<{ fieldPath: string; normalizedValue: unknown[] }>)
    .filter((assertion) => assertion.fieldPath === "content.sessions");

  assert.ok(sessionAssertions.length > 0);
  assert.ok(sessionAssertions.every((assertion) => assertion.normalizedValue.length === 1));
  assert.ok(compacted.stats.estimatedTokens <= 2_000);
});
