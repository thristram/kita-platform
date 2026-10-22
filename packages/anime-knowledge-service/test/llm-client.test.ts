import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalLlmClient } from "../src/llm/client.js";
import { testConfig } from "./fixtures.js";

test("native Ollama calls disable thinking", async () => {
  let body: Record<string, unknown> = {};
  const request = async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), { status: 200 });
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "kita-knowledge-llm-"));
  const result = await new LocalLlmClient(testConfig(root), request).json("system", "user", { maxOutputTokens: 1_024 });
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(body.format, "json");
  assert.equal((body.options as Record<string, unknown>).num_predict, 1_024);
  assert.deepEqual(result.value, { ok: true });
});

test("Ollama readiness requires the configured model tag", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kita-knowledge-ready-"));
  const present = new LocalLlmClient(testConfig(root), async () => new Response(JSON.stringify({ models: [{ name: "kita-qwen3.5:9b-q4" }] }), { status: 200 }));
  const missing = new LocalLlmClient(testConfig(root), async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));
  assert.equal(await present.available(), true);
  assert.equal(await missing.available(), false);
});
