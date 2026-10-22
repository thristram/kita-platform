#!/usr/bin/env node
import { knowledgeImportsResponseSchema, knowledgeStatusSchema } from "@kita/contracts";
import { loadConfig } from "./config.js";
import { bangumiIdentityWarning } from "./identity/bangumi.js";
import { KnowledgeManager } from "./kb/manager.js";
import { LocalLlmClient } from "./llm/client.js";
import { serve } from "./server.js";

const [command = "help"] = process.argv.slice(2);

async function main() {
  const config = loadConfig();
  if (command === "serve") return serve(config);
  const manager = new KnowledgeManager(config);
  await manager.initialize();
  const llm = new LocalLlmClient(config);
  if (command === "import:scan") {
    console.log(JSON.stringify(knowledgeImportsResponseSchema.parse({ activeVersion: manager.activeVersion, imports: await manager.scan() }), null, 2));
    return;
  }
  if (command === "doctor") {
    const modelReady = await llm.available();
    console.log(JSON.stringify({ ...knowledgeStatusSchema.parse({ service: "anime-knowledge-service", ready: manager.ready && modelReady, kbReady: manager.ready, modelConfigured: llm.enabled, modelReady, activeVersion: manager.activeVersion, counts: manager.counts, model: { provider: llm.providerName, name: llm.modelName } }), dataRoot: config.dataRoot, importsDirectory: manager.importsDirectory, snapshotsDirectory: manager.snapshotsDirectory, thinking: false, identityWarning: bangumiIdentityWarning() }, null, 2));
    return;
  }
  console.log("Commands: serve, import:scan, doctor");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
