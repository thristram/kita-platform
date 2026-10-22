#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import path from "node:path";

// MCP uses stdout for JSON-RPC. Never log or start the HTTP service here.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
loadDotenv({ path: [path.join(repoRoot, ".env.local"), path.join(packageRoot, ".env.local"), path.join(repoRoot, ".env")], quiet: true });

const searchInput = {
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(10).describe("Anime, manga, or person names copied from event evidence"),
  limit: z.number().int().min(1).max(20).default(5).describe("Maximum matches per query"),
};
const idInput = { rawId: z.number().int().positive().safe().describe("Verified raw Bangumi ID, not encodedId") };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

function serviceOrigin(): string {
  const url = new URL(process.env.KNOWLEDGE_SERVICE_BASE_URL || "http://127.0.0.1:4320");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("MCP requires a loopback-only KNOWLEDGE_SERVICE_BASE_URL origin");
  }
  return url.origin;
}

export async function queryKnowledge(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const token = process.env.KNOWLEDGE_SERVICE_TOKEN || "";
  const response = await fetch(new URL(path, serviceOrigin()), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof value.error === "string" ? value.error : `HTTP ${response.status}`;
    throw new Error(`Knowledge Service ${response.status}: ${detail}`);
  }
  return value;
}

const toolResult = (value: Record<string, unknown>) => ({
  structuredContent: value,
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export function createKnowledgeMcpServer(request: typeof queryKnowledge = queryKnowledge): McpServer {
  const server = new McpServer(
    { name: "kita-anime-knowledge", version: "0.1.0" },
    { instructions: "Read-only Bangumi identity lookup. Use search results to find candidates, then exact lookup to verify IDs and relations. KB membership alone never proves participation in a convention; require crawler sourceDocumentIds. Never call a local LLM through this server. Use canonicalKey as identity; encodedId is compatibility metadata." },
  );

  server.registerTool("search_subjects", {
    title: "Search Bangumi subjects",
    description: "Use this to find Bangumi anime/manga subject candidates by title or alias. Returns rawId, encodedId, canonicalKey, score, and snapshot version. A match does not prove an event relationship.",
    inputSchema: searchInput,
    annotations: readOnly,
  }, async ({ queries, limit }) => toolResult(await request("/v1/search/subjects", { queries, limit })));

  server.registerTool("get_subject", {
    title: "Get Bangumi subject and relationships",
    description: "Use this after searching to verify one exact Bangumi subject ID and inspect its archived related subjects and credited people. Relation type codes are raw Bangumi values; do not infer event attendance from them.",
    inputSchema: idInput,
    annotations: readOnly,
  }, async ({ rawId }) => toolResult(await request(`/v1/subjects/${rawId}`)));

  server.registerTool("search_people", {
    title: "Search Bangumi people",
    description: "Use this to find a person credited in Bangumi Archive by exact or partial name. Returns candidate identities and career data, not proof that the person is a convention guest.",
    inputSchema: searchInput,
    annotations: readOnly,
  }, async ({ queries, limit }) => toolResult(await request("/v1/search/people", { queries, limit })));

  server.registerTool("get_person", {
    title: "Get Bangumi person",
    description: "Use this to verify an exact Bangumi person raw ID returned by search or subject relationship expansion.",
    inputSchema: idInput,
    annotations: readOnly,
  }, async ({ rawId }) => toolResult(await request(`/v1/people/${rawId}`)));

  return server;
}

async function main(): Promise<void> {
  serviceOrigin();
  const server = createKnowledgeMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
