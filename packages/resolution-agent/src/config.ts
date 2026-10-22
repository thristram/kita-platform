import { config as loadDotenv } from "dotenv";

loadDotenv({ path: [".env.local", ".env"], quiet: true });

const integer = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
};

export interface AgentConfig {
  apiBaseUrl: string;
  token: string;
  agentId: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  maxDocumentBytes: number;
  maxContextChars: number;
  evidenceTokenBudget: number;
  knowledgePromptTokenBudget: number;
  knowledgeServiceBaseUrl: string | null;
  knowledgeServiceToken: string;
  knowledgeServiceTimeoutMs: number;
}

export function loadConfig(options: { requireControlPlane?: boolean } = {}): AgentConfig {
  const token = process.env.KITACON_AGENT_TOKEN || "";
  if (options.requireControlPlane && token.length < 32) throw new Error("KITACON_AGENT_TOKEN must contain at least 32 characters");
  const apiBaseUrl = (process.env.KITACON_API_BASE_URL || "http://localhost:3009").replace(/\/$/, "");
  new URL(apiBaseUrl);
  const knowledgeServiceBaseUrl = process.env.KNOWLEDGE_SERVICE_BASE_URL ? process.env.KNOWLEDGE_SERVICE_BASE_URL.replace(/\/$/, "") : null;
  if (knowledgeServiceBaseUrl) new URL(knowledgeServiceBaseUrl);
  return {
    apiBaseUrl,
    token,
    agentId: process.env.AGENT_ID || `resolution-agent-${process.platform}-${process.pid}`,
    pollIntervalMs: integer("AGENT_POLL_INTERVAL_MS", 10_000, 250, 60_000),
    leaseSeconds: integer("AGENT_LEASE_SECONDS", 600, 60, 1800),
    maxDocumentBytes: integer("AGENT_MAX_DOCUMENT_BYTES", 2_000_000, 10_000, 20_000_000),
    maxContextChars: integer("AGENT_MAX_CONTEXT_CHARS", 180_000, 10_000, 1_000_000),
    evidenceTokenBudget: integer("AGENT_EVIDENCE_TOKEN_BUDGET", 15_000, 4_000, 100_000),
    knowledgePromptTokenBudget: integer("KNOWLEDGE_EVENT_PROMPT_TOKEN_BUDGET", 24_000, 8_000, 200_000),
    knowledgeServiceBaseUrl,
    knowledgeServiceToken: process.env.KNOWLEDGE_SERVICE_TOKEN || "",
    knowledgeServiceTimeoutMs: integer("KNOWLEDGE_SERVICE_TIMEOUT_MS", 600_000, 1_000, 900_000),
  };
}
