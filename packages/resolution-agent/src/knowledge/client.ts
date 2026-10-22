import { knowledgeEventResolutionResponseSchema, knowledgeStatusSchema, type KnowledgeEventResolutionRequest, type KnowledgeEventResolutionResponse, type KnowledgeStatus } from "@kita/contracts";
import type { AgentConfig } from "../config.js";

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class KnowledgeServiceClient {
  constructor(private readonly config: AgentConfig, private readonly request: FetchImplementation = fetch) {}

  get enabled(): boolean { return Boolean(this.config.knowledgeServiceBaseUrl); }

  async status(): Promise<KnowledgeStatus> {
    return knowledgeStatusSchema.parse(await this.call("/v1/knowledge/status", { method: "GET" }));
  }

  async resolveEvent(input: KnowledgeEventResolutionRequest): Promise<KnowledgeEventResolutionResponse> {
    return knowledgeEventResolutionResponseSchema.parse(await this.call("/v1/resolve/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }));
  }

  private async call(pathname: string, init: RequestInit): Promise<unknown> {
    if (!this.config.knowledgeServiceBaseUrl) throw new Error("Anime Knowledge Service is not configured");
    const headers = new Headers(init.headers);
    if (this.config.knowledgeServiceToken) headers.set("Authorization", `Bearer ${this.config.knowledgeServiceToken}`);
    const response = await this.request(`${this.config.knowledgeServiceBaseUrl}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(this.config.knowledgeServiceTimeoutMs) });
    if (!response.ok) throw new Error(`Anime Knowledge Service returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.json();
  }
}
