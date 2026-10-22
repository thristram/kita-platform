import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  filenameResolutionRequestSchema,
  knowledgeEventResolutionRequestSchema,
  knowledgeImportsResponseSchema,
  knowledgeStatusSchema,
  knowledgeSubjectSearchRequestSchema,
  knowledgeSubjectSearchResponseSchema,
} from "@kita/contracts";
import { ZodError } from "zod";
import type { KnowledgeConfig } from "./config.js";
import { KnowledgeManager } from "./kb/manager.js";
import { LocalLlmClient, ModelUnavailableError } from "./llm/client.js";
import { log } from "./logger.js";
import { ContextBudgetError, resolveEventWithKnowledge } from "./pipelines/event.js";
import { resolveReleaseFilename } from "./pipelines/filename.js";

const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });

function authorized(request: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function serve(config: KnowledgeConfig): Promise<void> {
  const manager = new KnowledgeManager(config);
  const llm = new LocalLlmClient(config);
  await manager.initialize();
  const scan = () => void manager.scan().catch((error) => {
    log("error", "Knowledge import scan failed", { error: error instanceof Error ? error.message : String(error) });
  });
  scan();
  const scanTimer = setInterval(scan, config.importPollMs);
  scanTimer.unref();

  const server = createServer(async (request, response) => {
    let result = json(404, { error: "Not found" });
    try {
      const method = request.method || "GET";
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (method === "GET" && pathname === "/health") {
        result = json(200, { status: "ok", service: "anime-knowledge-service" });
      } else if (method === "GET" && pathname === "/ready") {
        const modelReady = await llm.available();
        const ready = manager.ready && modelReady;
        result = json(ready ? 200 : 503, { ready, kbReady: manager.ready, modelConfigured: llm.enabled, modelReady, activeVersion: manager.activeVersion });
      } else if (pathname.startsWith("/v1/") && !authorized(request, config.token)) {
        result = json(401, { error: "Unauthorized" });
      } else if (method === "GET" && pathname === "/v1/knowledge/status") {
        const modelReady = await llm.available();
        result = json(200, knowledgeStatusSchema.parse({ service: "anime-knowledge-service", ready: manager.ready && modelReady, kbReady: manager.ready, modelConfigured: llm.enabled, modelReady, activeVersion: manager.activeVersion, counts: manager.counts, model: { provider: llm.providerName, name: llm.modelName } }));
      } else if (method === "GET" && pathname === "/v1/knowledge/imports") {
        result = json(200, knowledgeImportsResponseSchema.parse({ activeVersion: manager.activeVersion, imports: manager.listImports() }));
      } else if (method === "POST" && pathname === "/v1/knowledge/imports/scan") {
        result = json(200, knowledgeImportsResponseSchema.parse({ activeVersion: manager.activeVersion, imports: await manager.scan() }));
      } else if (method === "POST" && pathname === "/v1/search/subjects") {
        if (!manager.currentStore || !manager.activeVersion) result = json(503, { error: "Bangumi knowledge base is not ready" });
        else {
          const input = knowledgeSubjectSearchRequestSchema.parse(await readJson(request, config.maxBodyBytes));
          const seen = new Set<string>();
          const matches = input.queries.flatMap((query) => manager.currentStore!.search(query, input.limit).map((match) => ({ query, ...match }))).filter((match) => {
            const key = `${match.query}:${match.subject.canonicalKey}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          result = json(200, knowledgeSubjectSearchResponseSchema.parse({ knowledgeVersion: manager.activeVersion, matches }));
        }
      } else if (method === "POST" && pathname === "/v1/search/people") {
        if (!manager.currentStore || !manager.activeVersion) result = json(503, { error: "Bangumi knowledge base is not ready" });
        else {
          const input = knowledgeSubjectSearchRequestSchema.parse(await readJson(request, config.maxBodyBytes));
          const matches = input.queries.flatMap((query) => manager.currentStore!.searchPeople(query, input.limit).map((match) => ({ query, ...match })));
          result = json(200, { knowledgeVersion: manager.activeVersion, matches });
        }
      } else if (method === "GET" && /^\/v1\/subjects\/[1-9]\d*$/.test(pathname)) {
        if (!manager.currentStore || !manager.activeVersion) result = json(503, { error: "Bangumi knowledge base is not ready" });
        else {
          const subjectId = Number(pathname.split("/").at(-1));
          const subject = Number.isSafeInteger(subjectId) ? manager.currentStore.getSubject(subjectId) : null;
          result = subject ? json(200, { knowledgeVersion: manager.activeVersion, ...subject, ...manager.currentStore.expandSubject(subjectId, 30) }) : json(404, { error: "Bangumi subject not found" });
        }
      } else if (method === "GET" && /^\/v1\/people\/[1-9]\d*$/.test(pathname)) {
        if (!manager.currentStore || !manager.activeVersion) result = json(503, { error: "Bangumi knowledge base is not ready" });
        else {
          const personId = Number(pathname.split("/").at(-1));
          const person = Number.isSafeInteger(personId) ? manager.currentStore.getPerson(personId) : null;
          result = person ? json(200, { knowledgeVersion: manager.activeVersion, ...person }) : json(404, { error: "Bangumi person not found" });
        }
      } else if (method === "POST" && pathname === "/v1/resolve/filename") {
        if (!manager.currentStore || !manager.activeVersion || !llm.enabled) result = json(503, { error: "Filename resolution requires an active knowledge snapshot and configured model" });
        else {
          const input = filenameResolutionRequestSchema.parse(await readJson(request, config.maxBodyBytes));
          result = json(200, await resolveReleaseFilename(input.value, manager.currentStore, llm, config.maxCandidates));
        }
      } else if (method === "POST" && pathname === "/v1/resolve/event") {
        if (!manager.currentStore || !manager.activeVersion || !llm.enabled) result = json(503, { error: "Event resolution requires an active knowledge snapshot and configured model" });
        else {
          const input = knowledgeEventResolutionRequestSchema.parse(await readJson(request, config.maxBodyBytes));
          result = json(200, await resolveEventWithKnowledge(input, manager.currentStore, llm, manager.activeVersion, config.eventPromptTokenBudget));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ZodError || error instanceof SyntaxError ? 400 : error instanceof ContextBudgetError ? 413 : error instanceof ModelUnavailableError ? 503 : 500;
      result = json(status, { error: message });
    }
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });

  await new Promise<void>((resolve, reject) => server.listen(config.port, config.host, resolve).once("error", reject));
  log("info", "Anime Knowledge Service started", { url: `http://${config.host}:${config.port}`, activeVersion: manager.activeVersion, bangumiSubjects: manager.currentStore?.size || 0, model: llm.modelName, thinking: false });
}
