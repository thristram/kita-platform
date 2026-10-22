import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeImportRecord } from "@kita/contracts";
import type { KnowledgeConfig } from "../config.js";
import { log } from "../logger.js";
import { BangumiStore, buildBangumiIndex } from "./store.js";

interface SnapshotManifest {
  schemaVersion: number;
  version: string;
  builtAt: string;
  counts: Record<string, number>;
}

export class KnowledgeManager {
  readonly importsDirectory: string;
  readonly snapshotsDirectory: string;
  readonly activePointerPath: string;
  private store: BangumiStore | null = null;
  private active: SnapshotManifest | null = null;
  private records = new Map<string, KnowledgeImportRecord>();
  private scanPromise: Promise<KnowledgeImportRecord[]> | null = null;

  constructor(private readonly config: KnowledgeConfig) {
    this.importsDirectory = path.join(config.dataRoot, "imports");
    this.snapshotsDirectory = path.join(config.dataRoot, "snapshots");
    this.activePointerPath = path.join(config.dataRoot, "active.json");
  }

  get currentStore(): BangumiStore | null { return this.store; }
  get activeVersion(): string | null { return this.active?.version || null; }
  get counts(): Record<string, number> { return this.active?.counts || {}; }
  get ready(): boolean { return Boolean(this.store?.size); }

  async initialize(): Promise<void> {
    await mkdir(this.importsDirectory, { recursive: true });
    await mkdir(this.snapshotsDirectory, { recursive: true });
    await this.discoverSnapshots();
    if (existsSync(this.activePointerPath)) {
      const pointer = JSON.parse(await readFile(this.activePointerPath, "utf8")) as { version?: unknown };
      if (typeof pointer.version === "string") await this.activateExisting(pointer.version, false);
    }
  }

  listImports(): KnowledgeImportRecord[] {
    return [...this.records.values()].sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt));
  }

  scan(): Promise<KnowledgeImportRecord[]> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanInternal().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  private async scanInternal(): Promise<KnowledgeImportRecord[]> {
    const entries = await readdir(this.importsDirectory, { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(entry.name)) {
        this.recordFailure(entry.name, "Import directory name must use only letters, numbers, dot, underscore, and hyphen");
        continue;
      }
      const sourceDirectory = path.join(this.importsDirectory, entry.name);
      try {
        await access(path.join(sourceDirectory, "READY"));
      } catch {
        if (!this.records.has(entry.name)) this.records.set(entry.name, this.makeRecord(entry.name, "DISCOVERED"));
        continue;
      }
      const existing = this.records.get(entry.name);
      if (existing && ["ACTIVE", "AVAILABLE", "INDEXING", "FAILED"].includes(existing.status)) continue;
      await this.importVersion(entry.name, sourceDirectory);
    }
    return this.listImports();
  }

  private async importVersion(version: string, sourceDirectory: string): Promise<void> {
    const finalDirectory = path.join(this.snapshotsDirectory, version);
    if (existsSync(finalDirectory)) {
      await this.activateExisting(version, true);
      return;
    }
    const stagingDirectory = path.join(this.snapshotsDirectory, `.${version}.staging-${process.pid}-${Date.now()}`);
    const record = this.records.get(version) || this.makeRecord(version, "DISCOVERED");
    this.records.set(version, { ...record, status: "INDEXING", error: null });
    log("info", "Knowledge import started", { version, sourceDirectory });
    try {
      const counts = await buildBangumiIndex(sourceDirectory, stagingDirectory, version);
      const candidateStore = new BangumiStore(stagingDirectory);
      await candidateStore.load();
      if (!candidateStore.size) throw new Error("Generated snapshot has no subjects");
      await rename(stagingDirectory, finalDirectory);
      await this.activateExisting(version, true);
      this.records.set(version, { ...record, status: "ACTIVE", completedAt: new Date().toISOString(), error: null, counts });
      log("info", "Knowledge import activated", { version, counts });
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      this.recordFailure(version, error instanceof Error ? error.message : String(error));
      log("error", "Knowledge import failed", { version, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async activateExisting(version: string, updatePointer: boolean): Promise<void> {
    const snapshotDirectory = path.join(this.snapshotsDirectory, version);
    const manifest = JSON.parse(await readFile(path.join(snapshotDirectory, "manifest.json"), "utf8")) as SnapshotManifest;
    if (manifest.version !== version || manifest.schemaVersion !== 1) throw new Error(`Snapshot ${version} has an incompatible manifest`);
    const candidateStore = new BangumiStore(snapshotDirectory);
    await candidateStore.load();
    if (!candidateStore.size) throw new Error(`Snapshot ${version} contains no subjects`);
    if (updatePointer) {
      const temporary = `${this.activePointerPath}.tmp-${process.pid}`;
      await writeFile(temporary, JSON.stringify({ version, activatedAt: new Date().toISOString() }, null, 2));
      await rename(temporary, this.activePointerPath);
    }
    const priorVersion = this.active?.version;
    this.store = candidateStore;
    this.active = manifest;
    for (const [recordVersion, record] of this.records) {
      if (record.status === "ACTIVE" && recordVersion !== version) this.records.set(recordVersion, { ...record, status: "AVAILABLE" });
    }
    const record = this.records.get(version) || this.makeRecord(version, "AVAILABLE", manifest.builtAt);
    this.records.set(version, { ...record, status: "ACTIVE", completedAt: manifest.builtAt, error: null, counts: manifest.counts });
    if (priorVersion !== version) log("info", "Active knowledge snapshot changed", { previousVersion: priorVersion || null, version });
  }

  private async discoverSnapshots(): Promise<void> {
    const entries = await readdir(this.snapshotsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(this.snapshotsDirectory, entry.name, "manifest.json"), "utf8")) as SnapshotManifest;
        this.records.set(entry.name, { version: entry.name, status: "AVAILABLE", discoveredAt: manifest.builtAt, completedAt: manifest.builtAt, error: null, counts: manifest.counts });
      } catch {
        this.recordFailure(entry.name, "Existing snapshot manifest is missing or invalid");
      }
    }
  }

  private makeRecord(version: string, status: KnowledgeImportRecord["status"], discoveredAt = new Date().toISOString()): KnowledgeImportRecord {
    return { version, status, discoveredAt, completedAt: null, error: null, counts: {} };
  }

  private recordFailure(version: string, message: string): void {
    const current = this.records.get(version) || this.makeRecord(version, "FAILED");
    this.records.set(version, { ...current, status: "FAILED", completedAt: new Date().toISOString(), error: message });
  }
}
