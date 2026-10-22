import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeManager } from "../src/kb/manager.js";
import { testConfig } from "./fixtures.js";

test("READY import builds and atomically activates a knowledge snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kita-knowledge-import-"));
  const source = path.join(root, "imports", "bangumi-2026-10-07");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "subject.jsonlines"), `${JSON.stringify({ id: 425911, type: 2, name: "氷の城壁", name_cn: "冰之城墙", infobox: "{{Infobox animanga/TVAnime\r\n|别名={\r\n[Koori no Jouheki]\r\n[The Ramparts of Ice]\r\n}\r\n}}" })}\n`);
  await writeFile(path.join(source, "READY"), "");
  const manager = new KnowledgeManager(testConfig(root));
  await manager.initialize();
  assert.equal(manager.activeVersion, null);
  await manager.scan();
  assert.equal(manager.activeVersion, "bangumi-2026-10-07");
  assert.equal(manager.currentStore?.search("Koori no Jouheki")[0]?.subject.rawId, 425911);
  assert.equal(manager.listImports()[0]?.status, "ACTIVE");
});

test("a failed new import leaves the active snapshot unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kita-knowledge-rollback-"));
  const good = path.join(root, "imports", "good");
  await mkdir(good, { recursive: true });
  await writeFile(path.join(good, "subject.jsonlines"), `${JSON.stringify({ id: 1, type: 2, name: "Good", name_cn: "", infobox: "" })}\n`);
  await writeFile(path.join(good, "READY"), "");
  const manager = new KnowledgeManager(testConfig(root));
  await manager.initialize();
  await manager.scan();
  const bad = path.join(root, "imports", "bad");
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(bad, "subject.jsonlines"), "not-json\n");
  await writeFile(path.join(bad, "READY"), "");
  await manager.scan();
  assert.equal(manager.activeVersion, "good");
  assert.equal(manager.listImports().find((entry) => entry.version === "bad")?.status, "FAILED");
});

test("snapshot supports exact subject lookup, people search, and relation expansion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kita-knowledge-graph-"));
  const source = path.join(root, "imports", "graph-v1");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "subject.jsonlines"), [
    { id: 101, type: 2, name: "Frieren", name_cn: "葬送的芙莉莲" },
    { id: 102, type: 1, name: "Frieren manga", name_cn: "葬送的芙莉莲 漫画" },
  ].map((subject) => JSON.stringify(subject)).join("\n") + "\n");
  await writeFile(path.join(source, "person.jsonlines"), `${JSON.stringify({ id: 201, name: "Example Creator", career: ["writer"] })}\n`);
  await writeFile(path.join(source, "subject_relation.jsonlines"), `${JSON.stringify({ subject_id: 101, related_subject_id: 102, relation_type: 1 })}\n`);
  await writeFile(path.join(source, "subject_person.jsonlines"), `${JSON.stringify({ subject_id: 101, person_id: 201, position: 1 })}\n`);
  await writeFile(path.join(source, "READY"), "");
  const manager = new KnowledgeManager(testConfig(root));
  await manager.initialize();
  await manager.scan();
  assert.equal(manager.currentStore?.getSubject(101)?.subject.canonicalKey, "bangumi:subject:101");
  assert.equal(manager.currentStore?.getSubject(999), null);
  assert.equal(manager.currentStore?.searchPeople("Example Creator")[0]?.person.canonicalKey, "bangumi:person:201");
  assert.equal(manager.currentStore?.getPerson(201)?.name, "Example Creator");
  assert.equal(manager.currentStore?.expandSubject(101).relatedSubjects[0]?.subject.rawId, 102);
  assert.equal(manager.currentStore?.expandSubject(101).people[0]?.person.rawId, 201);
});
