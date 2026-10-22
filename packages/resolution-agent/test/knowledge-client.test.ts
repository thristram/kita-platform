import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../src/config.js";
import { KnowledgeServiceClient } from "../src/knowledge/client.js";

const config: AgentConfig = {
  apiBaseUrl: "http://localhost:3009",
  token: "",
  agentId: "test",
  pollIntervalMs: 10_000,
  leaseSeconds: 600,
  maxDocumentBytes: 2_000_000,
  maxContextChars: 180_000,
  evidenceTokenBudget: 18_000,
  knowledgePromptTokenBudget: 24_000,
  knowledgeServiceBaseUrl: "http://127.0.0.1:4320",
  knowledgeServiceToken: "secret",
  knowledgeServiceTimeoutMs: 300_000,
};

test("reads Anime Knowledge Service status through its stable contract", async () => {
  let authorization = "";
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("Authorization") || "";
    return new Response(JSON.stringify({ service: "anime-knowledge-service", ready: true, kbReady: true, modelConfigured: true, modelReady: true, activeVersion: "test-v1", counts: { subjects: 1 }, model: { provider: "ollama-local", name: "test" } }), { status: 200 });
  };
  const status = await new KnowledgeServiceClient(config, request).status();
  assert.equal(status.activeVersion, "test-v1");
  assert.equal(authorization, "Bearer secret");
});
