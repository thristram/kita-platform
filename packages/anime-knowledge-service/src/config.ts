import path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: [".env.local", ".env"], quiet: true });

const integer = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
};

export interface KnowledgeConfig {
  host: string;
  port: number;
  token: string;
  dataRoot: string;
  importPollMs: number;
  maxCandidates: number;
  maxBodyBytes: number;
  llmBaseUrl: string | null;
  llmApiStyle: "ollama" | "openai-compatible";
  llmApiKey: string;
  llmModel: string | null;
  llmTimeoutMs: number;
  eventPromptTokenBudget: number;
}

export function loadConfig(): KnowledgeConfig {
  const host = process.env.KNOWLEDGE_SERVICE_HOST || "127.0.0.1";
  const token = process.env.KNOWLEDGE_SERVICE_TOKEN || "";
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && token.length < 32) {
    throw new Error("KNOWLEDGE_SERVICE_TOKEN must contain at least 32 characters when binding outside loopback");
  }
  const llmApiStyle = process.env.LLM_API_STYLE || "ollama";
  if (llmApiStyle !== "ollama" && llmApiStyle !== "openai-compatible") throw new Error("LLM_API_STYLE must be ollama or openai-compatible");
  return {
    host,
    port: integer("KNOWLEDGE_SERVICE_PORT", 4320, 1, 65_535),
    token,
    dataRoot: path.resolve(process.env.KNOWLEDGE_DATA_ROOT || "./data"),
    importPollMs: integer("KNOWLEDGE_IMPORT_POLL_MS", 5_000, 1_000, 3_600_000),
    maxCandidates: integer("KNOWLEDGE_MAX_CANDIDATES", 12, 1, 50),
    maxBodyBytes: integer("KNOWLEDGE_MAX_BODY_BYTES", 5_000_000, 1_000, 50_000_000),
    llmBaseUrl: process.env.LLM_BASE_URL ? process.env.LLM_BASE_URL.replace(/\/$/, "") : null,
    llmApiStyle,
    llmApiKey: process.env.LLM_API_KEY || "ollama",
    llmModel: process.env.LLM_MODEL || null,
    llmTimeoutMs: integer("LLM_TIMEOUT_MS", 600_000, 1_000, 900_000),
    eventPromptTokenBudget: integer("KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET", 24_000, 8_000, 200_000),
  };
}
