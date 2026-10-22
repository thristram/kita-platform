import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createKnowledgeMcpServer } from "../src/mcp.js";

test("MCP advertises only read-only KB tools and forwards bounded queries", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const server = createKnowledgeMcpServer(async (path, body) => {
    calls.push({ path, body });
    return path.startsWith("/v1/search/")
      ? { knowledgeVersion: "fixture-v1", matches: [] }
      : { knowledgeVersion: "fixture-v1", subject: { rawId: 42 }, relatedSubjects: [], people: [] };
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_person", "get_subject", "search_people", "search_subjects"]);
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    assert.ok(tools.every((tool) => tool.annotations?.destructiveHint === false));

    const search = await client.callTool({ name: "search_subjects", arguments: { queries: ["Frieren"], limit: 3 } });
    assert.equal((search.structuredContent as { knowledgeVersion?: string } | undefined)?.knowledgeVersion, "fixture-v1");
    assert.deepEqual(calls[0], { path: "/v1/search/subjects", body: { queries: ["Frieren"], limit: 3 } });

    await client.callTool({ name: "get_subject", arguments: { rawId: 42 } });
    assert.deepEqual(calls[1], { path: "/v1/subjects/42", body: undefined });

    await client.callTool({ name: "search_people", arguments: { queries: ["Hayao Miyazaki"] } });
    assert.deepEqual(calls[2], { path: "/v1/search/people", body: { queries: ["Hayao Miyazaki"], limit: 5 } });

    const invalid = await client.callTool({ name: "get_subject", arguments: { rawId: -1 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 3);
  } finally {
    await client.close();
    await server.close();
  }
});
