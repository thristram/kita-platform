import { createReadStream, existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { bangumiReference } from "../identity/bangumi.js";

export interface BangumiSubject {
  id: number;
  type: number;
  name: string;
  nameCn: string;
  aliases: string[];
}

export interface BangumiPerson {
  id: number;
  name: string;
  career: string[];
}

export interface BangumiPersonSearchMatch {
  person: ReturnType<typeof bangumiReference>;
  name: string;
  career: string[];
  score: number;
}

export interface BangumiSearchMatch {
  subject: ReturnType<typeof bangumiReference>;
  name: string;
  nameCn: string;
  score: number;
}

type JsonRecord = Record<string, unknown>;

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const aliasesFromInfobox = (value: unknown): string[] => {
  if (typeof value !== "string") return [];
  const aliases: string[] = [];
  let insideAliasBlock = false;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (insideAliasBlock) {
      if (line.startsWith("}")) {
        insideAliasBlock = false;
        continue;
      }
      const blockValue = line.match(/^\[([^\]]+)\]$/)?.[1]?.split("|").at(-1)?.trim();
      if (blockValue && blockValue.length < 120) aliases.push(blockValue);
      continue;
    }
    const field = line.match(/^\|\s*(别名|中文名|英文名|日文名|原名|alias)\s*[=:：]\s*(.*)$/i);
    if (!field) continue;
    const candidate = field[2]?.trim() || "";
    if (candidate.startsWith("{")) {
      insideAliasBlock = true;
      continue;
    }
    const cleaned = candidate.replace(/[{}]|\[|\]/g, " ").trim();
    if (cleaned.length > 1 && cleaned.length < 120) aliases.push(cleaned);
  }
  return [...new Set(aliases)];
};

export async function* readJsonLines(filePath: string): AsyncGenerator<JsonRecord> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as JsonRecord;
    } catch (error) {
      throw new Error(`${path.basename(filePath)} contains invalid JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function archiveFile(directory: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const filePath = path.join(directory, candidate);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

const optionalFiles: Array<[string[], string]> = [
  [["person.jsonlines", "persons.jsonlines", "person.jsonl", "persons.jsonl"], "persons.jsonl"],
  [["character.jsonlines", "characters.jsonlines", "character.jsonl", "characters.jsonl"], "characters.jsonl"],
  [["episode.jsonlines", "episodes.jsonlines", "episode.jsonl", "episodes.jsonl"], "episodes.jsonl"],
  [["subject_relation.jsonlines", "subject-relations.jsonlines", "subject_relation.jsonl", "subject-relations.jsonl"], "subject-relations.jsonl"],
  [["subject_person.jsonlines", "subject-persons.jsonlines", "subject_person.jsonl", "subject-persons.jsonl"], "subject-persons.jsonl"],
  [["subject_character.jsonlines", "subject-characters.jsonlines", "subject_character.jsonl", "subject-characters.jsonl"], "subject-characters.jsonl"],
];

export async function buildBangumiIndex(archiveDirectory: string, indexDirectory: string, version = path.basename(archiveDirectory)): Promise<Record<string, number>> {
  const subjectSource = archiveFile(archiveDirectory, ["subject.jsonlines", "subjects.jsonlines", "subject.jsonl", "subjects.jsonl"]);
  if (!subjectSource) throw new Error(`No subject.jsonlines found in ${archiveDirectory}`);
  await mkdir(indexDirectory, { recursive: true });
  const subjectOutput = await open(path.join(indexDirectory, "subjects.jsonl"), "w");
  let subjects = 0;
  try {
    for await (const record of readJsonLines(subjectSource)) {
      const id = Number(record.id);
      if (!Number.isInteger(id) || id < 1) throw new Error(`subject.jsonlines contains an invalid id at logical record ${subjects + 1}`);
      const normalized: BangumiSubject = {
        id,
        type: Number(record.type || 0),
        name: String(record.name || ""),
        nameCn: String(record.name_cn || ""),
        aliases: aliasesFromInfobox(record.infobox),
      };
      if (!normalized.name && !normalized.nameCn) throw new Error(`Bangumi subject ${id} has no name`);
      await subjectOutput.write(`${JSON.stringify(normalized)}\n`);
      subjects += 1;
    }
  } finally {
    await subjectOutput.close();
  }
  if (!subjects) throw new Error("subject.jsonlines did not contain any valid subjects");

  const counts: Record<string, number> = { subjects };
  for (const [sources, destination] of optionalFiles) {
    const source = archiveFile(archiveDirectory, sources);
    if (!source) continue;
    const output = await open(path.join(indexDirectory, destination), "w");
    let count = 0;
    try {
      for await (const record of readJsonLines(source)) {
        await output.write(`${JSON.stringify(record)}\n`);
        count += 1;
      }
    } finally {
      await output.close();
    }
    counts[destination] = count;
  }
  const manifest = await open(path.join(indexDirectory, "manifest.json"), "w");
  try {
    await manifest.write(JSON.stringify({ schemaVersion: 1, version, builtAt: new Date().toISOString(), counts }, null, 2));
  } finally {
    await manifest.close();
  }
  return counts;
}

export class BangumiStore {
  private subjects: BangumiSubject[] = [];
  private subjectById = new Map<number, BangumiSubject>();
  private people = new Map<number, BangumiPerson>();
  private subjectRelations = new Map<number, Array<{ relatedSubjectId: number; relationType: number }>>();
  private subjectPeople = new Map<number, Array<{ personId: number; position: number }>>();

  constructor(private readonly indexDirectory: string) {}

  async load(): Promise<void> {
    const filePath = path.join(this.indexDirectory, "subjects.jsonl");
    if (!existsSync(filePath)) return;
    const subjects: BangumiSubject[] = [];
    for await (const record of readJsonLines(filePath)) {
      subjects.push({ id: Number(record.id), type: Number(record.type || 0), name: String(record.name || ""), nameCn: String(record.nameCn || ""), aliases: Array.isArray(record.aliases) ? record.aliases.map(String) : [] });
    }
    this.subjects = subjects;
    this.subjectById = new Map(subjects.map((subject) => [subject.id, subject]));

    const peoplePath = path.join(this.indexDirectory, "persons.jsonl");
    if (existsSync(peoplePath)) {
      for await (const record of readJsonLines(peoplePath)) {
        const id = Number(record.id);
        if (Number.isInteger(id) && id > 0) this.people.set(id, { id, name: String(record.name || ""), career: Array.isArray(record.career) ? record.career.map(String) : [] });
      }
    }
    const relationsPath = path.join(this.indexDirectory, "subject-relations.jsonl");
    if (existsSync(relationsPath)) {
      for await (const record of readJsonLines(relationsPath)) {
        const subjectId = Number(record.subject_id);
        const relatedSubjectId = Number(record.related_subject_id);
        if (!Number.isInteger(subjectId) || !Number.isInteger(relatedSubjectId)) continue;
        this.subjectRelations.set(subjectId, [...(this.subjectRelations.get(subjectId) || []), { relatedSubjectId, relationType: Number(record.relation_type || 0) }]);
      }
    }
    const subjectPeoplePath = path.join(this.indexDirectory, "subject-persons.jsonl");
    if (existsSync(subjectPeoplePath)) {
      for await (const record of readJsonLines(subjectPeoplePath)) {
        const subjectId = Number(record.subject_id);
        const personId = Number(record.person_id);
        if (!Number.isInteger(subjectId) || !Number.isInteger(personId)) continue;
        this.subjectPeople.set(subjectId, [...(this.subjectPeople.get(subjectId) || []), { personId, position: Number(record.position || 0) }]);
      }
    }
  }

  get size(): number { return this.subjects.length; }

  getSubject(subjectId: number) {
    const subject = this.subjectById.get(subjectId);
    return subject ? { subject: bangumiReference("subject", subject.id), type: subject.type, name: subject.name, nameCn: subject.nameCn, aliases: subject.aliases } : null;
  }

  getPerson(personId: number) {
    const person = this.people.get(personId);
    return person ? { person: bangumiReference("person", person.id), name: person.name, career: person.career } : null;
  }

  searchPeople(query: string, limit = 8): BangumiPersonSearchMatch[] {
    const target = normalize(query);
    if (!target) return [];
    return [...this.people.values()].map((person) => {
      const name = normalize(person.name);
      let score = 0;
      if (name === target) score = 1;
      else if (name && (name.includes(target) || target.includes(name))) score = Math.min(name.length, target.length) / Math.max(name.length, target.length) * 0.9;
      return { person: bangumiReference("person", person.id), name: person.name, career: person.career, score };
    }).filter((match) => match.score >= 0.25).sort((left, right) => right.score - left.score).slice(0, limit);
  }

  search(query: string, limit = 8): BangumiSearchMatch[] {
    const target = normalize(query);
    if (!target) return [];
    return this.subjects.map((subject) => {
      const names = [subject.name, subject.nameCn, ...subject.aliases].filter(Boolean);
      let score = 0;
      for (const name of names) {
        const candidate = normalize(name);
        if (candidate === target) score = Math.max(score, 1);
        else if (candidate.includes(target) || target.includes(candidate)) score = Math.max(score, Math.min(candidate.length, target.length) / Math.max(candidate.length, target.length) * 0.9);
        else {
          const queryBigrams = new Set(Array.from({ length: Math.max(0, target.length - 1) }, (_, index) => target.slice(index, index + 2)));
          const candidateBigrams = new Set(Array.from({ length: Math.max(0, candidate.length - 1) }, (_, index) => candidate.slice(index, index + 2)));
          const overlap = [...queryBigrams].filter((item) => candidateBigrams.has(item)).length;
          const union = new Set([...queryBigrams, ...candidateBigrams]).size;
          if (union) score = Math.max(score, overlap / union * 0.75);
        }
      }
      return { subject: bangumiReference("subject", subject.id), name: subject.name, nameCn: subject.nameCn, score };
    }).filter((match) => match.score >= 0.25).sort((left, right) => right.score - left.score).slice(0, limit);
  }

  expandSubject(subjectId: number, limit = 20) {
    const relatedSubjects = (this.subjectRelations.get(subjectId) || []).slice(0, limit).flatMap((relation) => {
      const subject = this.subjectById.get(relation.relatedSubjectId);
      return subject ? [{ relationType: relation.relationType, subject: bangumiReference("subject", subject.id), name: subject.name, nameCn: subject.nameCn }] : [];
    });
    const people = (this.subjectPeople.get(subjectId) || []).slice(0, limit).flatMap((relation) => {
      const person = this.people.get(relation.personId);
      return person ? [{ position: relation.position, person: bangumiReference("person", person.id), name: person.name, career: person.career }] : [];
    });
    return { relatedSubjects, people };
  }
}
