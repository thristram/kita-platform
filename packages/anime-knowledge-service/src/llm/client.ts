import { z } from "zod";
import type { KnowledgeConfig } from "../config.js";

const completionResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
});

const ollamaResponseSchema = z.object({
  message: z.object({ content: z.string(), thinking: z.string().optional() }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  done_reason: z.string().optional(),
});

const ollamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string().optional(), model: z.string().optional() })),
});

const openAiModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface JsonLlm {
  readonly enabled: boolean;
  readonly modelName: string;
  readonly providerName: string;
  json(system: string, user: string, options?: { maxOutputTokens?: number; schema?: Record<string, unknown> }): Promise<{ value: unknown; inputTokens?: number; outputTokens?: number }>;
}

export class ModelUnavailableError extends Error {}

export class LocalLlmClient implements JsonLlm {
  constructor(private readonly config: KnowledgeConfig, private readonly request: FetchImplementation = fetch) {}

  get enabled(): boolean { return Boolean(this.config.llmBaseUrl && this.config.llmModel); }
  get modelName(): string { return this.config.llmModel || "unconfigured"; }
  get providerName(): string { return `${this.config.llmApiStyle}-local`; }

  async available(): Promise<boolean> {
    if (!this.config.llmBaseUrl || !this.config.llmModel) return false;
    try {
      if (this.config.llmApiStyle === "ollama") {
        const origin = this.config.llmBaseUrl.replace(/\/v1$/, "");
        const response = await this.request(`${origin}/api/tags`, { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) return false;
        const tags = ollamaTagsSchema.parse(await response.json());
        return tags.models.some((model) => model.name === this.config.llmModel || model.model === this.config.llmModel);
      }
      const response = await this.request(`${this.config.llmBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.llmApiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return false;
      return openAiModelsSchema.parse(await response.json()).data.some((model) => model.id === this.config.llmModel);
    } catch {
      return false;
    }
  }

  async json(system: string, user: string, options: { maxOutputTokens?: number; schema?: Record<string, unknown> } = {}): Promise<{ value: unknown; inputTokens?: number; outputTokens?: number }> {
    if (!this.config.llmBaseUrl || !this.config.llmModel) throw new Error("Local LLM is not configured");
    if (this.config.llmApiStyle === "ollama") return this.ollamaJson(system, user, options);
    return this.openAiCompatibleJson(system, user, options);
  }

  private async ollamaJson(system: string, user: string, options: { maxOutputTokens?: number; schema?: Record<string, unknown> }) {
    const origin = this.config.llmBaseUrl!.replace(/\/v1$/, "");
    let response: Response;
    try {
      response = await this.request(`${origin}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.llmModel,
          stream: false,
          think: false,
          format: options.schema || "json",
          options: { temperature: 0.1, ...(options.maxOutputTokens ? { num_predict: options.maxOutputTokens } : {}) },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(this.config.llmTimeoutMs),
      });
    } catch (error) {
      throw new ModelUnavailableError(`Ollama is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) throw new ModelUnavailableError(`Configured Ollama model was not found: ${this.config.llmModel}`);
    if (!response.ok) throw new Error(`LLM returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const parsed = ollamaResponseSchema.parse(await response.json());
    const content = parsed.message.content.trim() || parsed.message.thinking?.trim() || "";
    if (!content) throw new Error(`LLM returned an empty structured response${parsed.done_reason ? ` (${parsed.done_reason})` : ""}`);
    return { value: parseJsonObject(content), inputTokens: parsed.prompt_eval_count, outputTokens: parsed.eval_count };
  }

  private async openAiCompatibleJson(system: string, user: string, options: { maxOutputTokens?: number; schema?: Record<string, unknown> }) {
    let response: Response;
    try {
      response = await this.request(`${this.config.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.llmApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.llmModel,
          temperature: 0.1,
          reasoning_effort: "none",
          think: false,
          response_format: options.schema
            ? { type: "json_schema", json_schema: { name: "structured_response", strict: true, schema: options.schema } }
            : { type: "json_object" },
          ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(this.config.llmTimeoutMs),
      });
    } catch (error) {
      throw new ModelUnavailableError(`Model endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) throw new ModelUnavailableError(`Configured model was not found: ${this.config.llmModel}`);
    if (!response.ok) throw new Error(`LLM returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const parsed = completionResponseSchema.parse(await response.json());
    return { value: parseJsonObject(parsed.choices[0]?.message.content || ""), inputTokens: parsed.usage?.prompt_tokens, outputTokens: parsed.usage?.completion_tokens };
  }
}

function parseJsonObject(content: string): unknown {
  const jsonStart = content.indexOf("{");
  const jsonEnd = content.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("LLM response did not contain a JSON object");
  return JSON.parse(content.slice(jsonStart, jsonEnd + 1));
}
