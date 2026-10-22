#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { ResolutionControlClient } from "./client.js";
import { KnowledgeServiceClient } from "./knowledge/client.js";
import { runWorker } from "./worker.js";

const [command = "help", ...args] = process.argv.slice(2);

async function main() {
  if (command === "worker") return runWorker(loadConfig({ requireControlPlane: true }), { once: args.includes("--once") });
  if (command === "doctor") {
    const config = loadConfig();
    const knowledge = new KnowledgeServiceClient(config);
    let controlPlane: unknown = "not checked (KITACON_AGENT_TOKEN is not configured)";
    if (config.token.length >= 32) controlPlane = await new ResolutionControlClient(config).health();
    let knowledgeService: unknown = "not configured";
    if (knowledge.enabled) knowledgeService = await knowledge.status();
    console.log(JSON.stringify({ node: process.version, controlPlane, knowledgeService }, null, 2));
    return;
  }
  console.log("Commands: worker [--once], doctor");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
