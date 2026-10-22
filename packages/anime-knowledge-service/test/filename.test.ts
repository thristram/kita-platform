import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BangumiStore } from "../src/kb/store.js";
import { resolveReleaseFilename } from "../src/pipelines/filename.js";

test("LLM selects one supplied Bangumi candidate for a release filename", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kita-knowledge-filename-"));
  await writeFile(path.join(directory, "subjects.jsonl"), `${JSON.stringify({ id: 425911, type: 2, name: "Koori no Jouheki", nameCn: "冰之城墙", aliases: [] })}\n`);
  const store = new BangumiStore(directory);
  await store.load();
  const llm = {
    enabled: true,
    modelName: "test",
    providerName: "test",
    async json(_system: string, user: string) {
      const prompt = JSON.parse(user) as { bangumiCandidates: Array<{ canonicalKey: string }> };
      assert.equal(prompt.bangumiCandidates[0]?.canonicalKey, "bangumi:subject:425911");
      return { value: { normalizedTitle: "Koori no Jouheki", season: null, episode: 15, selectedCanonicalKey: "bangumi:subject:425911", confidence: 0.98 } };
    },
  };
  const result = await resolveReleaseFilename("[SweetSub] Koori no Jouheki - 15 [1080p].mkv", store, llm, 12);
  assert.equal(result.selectedMatch?.subject.rawId, 425911);
  assert.equal(result.episode, 15);
  assert.equal(result.resolutionMethod, "llm-kb");
});

test("LLM cannot invent a Bangumi id", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kita-knowledge-filename-"));
  await writeFile(path.join(directory, "subjects.jsonl"), `${JSON.stringify({ id: 1, type: 2, name: "Example", nameCn: "", aliases: [] })}\n`);
  const store = new BangumiStore(directory);
  await store.load();
  const llm = { enabled: true, modelName: "test", providerName: "test", async json() { return { value: { normalizedTitle: "Example", season: null, episode: 1, selectedCanonicalKey: "bangumi:subject:999", confidence: 1 } }; } };
  await assert.rejects(resolveReleaseFilename("Example - 01.mkv", store, llm, 12), /outside the retrieved candidates/);
});
