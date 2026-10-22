import type { KnowledgeConfig } from "../src/config.js";

export function testConfig(dataRoot: string, overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return {
    host: "127.0.0.1",
    port: 4320,
    token: "",
    dataRoot,
    importPollMs: 5_000,
    maxCandidates: 12,
    maxBodyBytes: 5_000_000,
    llmBaseUrl: "http://localhost:11434",
    llmApiStyle: "ollama",
    llmApiKey: "ollama",
    llmModel: "kita-qwen3.5:9b-q4",
    llmTimeoutMs: 300_000,
    eventPromptTokenBudget: 24_000,
    ...overrides,
  };
}
