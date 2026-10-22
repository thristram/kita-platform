import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { KnowledgeManager } from "../src/kb/manager.js";
import { testConfig } from "./fixtures.js";

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a test port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

test("HTTP KB endpoints serve only authenticated exact/search results", async (context) => {
  let port: number;
  try {
    port = await unusedPort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("This sandbox forbids loopback listeners");
      return;
    }
    throw error;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "kita-mcp-http-"));
  const source = path.join(root, "imports", "http-v1");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "subject.jsonlines"), `${JSON.stringify({ id: 101, type: 2, name: "Example Anime", name_cn: "示例动画" })}\n`);
  await writeFile(path.join(source, "person.jsonlines"), `${JSON.stringify({ id: 201, name: "Example Creator", career: ["writer"] })}\n`);
  await writeFile(path.join(source, "subject_person.jsonlines"), `${JSON.stringify({ subject_id: 101, person_id: 201, position: 1 })}\n`);
  await writeFile(path.join(source, "READY"), "");
  const manager = new KnowledgeManager(testConfig(root));
  await manager.initialize();
  await manager.scan();

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      KNOWLEDGE_DATA_ROOT: root,
      KNOWLEDGE_SERVICE_HOST: "127.0.0.1",
      KNOWLEDGE_SERVICE_PORT: String(port),
      KNOWLEDGE_SERVICE_TOKEN: "test-secret",
      LLM_BASE_URL: "",
      LLM_MODEL: "",
    },
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let started = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Knowledge Service exited with ${child.exitCode}`);
      try {
        started = (await fetch(`${origin}/health`)).ok;
        if (started) break;
      } catch { /* Waiting for the child process to bind. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(started, true, "Knowledge Service did not start");
    assert.equal((await fetch(`${origin}/v1/subjects/101`)).status, 401);
    const headers = { Authorization: "Bearer test-secret" };
    const subject = await fetch(`${origin}/v1/subjects/101`, { headers });
    assert.equal(subject.status, 200);
    const subjectBody = await subject.json() as { knowledgeVersion: string; subject: { canonicalKey: string }; people: Array<{ person: { rawId: number } }> };
    assert.equal(subjectBody.knowledgeVersion, "http-v1");
    assert.equal(subjectBody.subject.canonicalKey, "bangumi:subject:101");
    assert.equal(subjectBody.people[0].person.rawId, 201);
    assert.equal((await fetch(`${origin}/v1/subjects/999`, { headers })).status, 404);
    const people = await fetch(`${origin}/v1/search/people`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ queries: ["Example Creator"], limit: 1 }) });
    assert.equal(people.status, 200);
    const peopleBody = await people.json() as { matches: Array<{ person: { canonicalKey: string } }> };
    assert.equal(peopleBody.matches[0].person.canonicalKey, "bangumi:person:201");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
});
