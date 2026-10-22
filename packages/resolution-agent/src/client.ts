import {
  leaseResponseSchema,
  resolutionInputSchema,
  type CompletionRequest,
  type LeasedJob,
  type ResolutionInput,
} from "@kita/contracts";
import type { AgentConfig } from "./config.js";

export class ControlPlaneError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

export class ResolutionControlClient {
  constructor(private readonly config: AgentConfig) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new ControlPlaneError(`Control API ${response.status}: ${body.slice(0, 500)}`, response.status, response.status >= 500 || response.status === 429);
    }
    return response;
  }

  async health(): Promise<unknown> {
    const response = await fetch(`${this.config.apiBaseUrl}/api/internal/v1/resolution/health`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Control API health returned ${response.status}`);
    return response.json();
  }

  async lease(): Promise<{ job: LeasedJob | null; retryAfterMs: number }> {
    const response = await this.request("/api/internal/v1/resolution/jobs/lease", {
      method: "POST",
      body: JSON.stringify({
        agentId: this.config.agentId,
        agentVersion: "0.1.0",
        capabilities: ["EVENT_RESOLUTION_V1", "BANGUMI_LINKING_V1"],
        leaseSeconds: this.config.leaseSeconds,
      }),
    });
    const parsed = leaseResponseSchema.parse(await response.json());
    return { job: parsed.job, retryAfterMs: parsed.retryAfterMs ?? this.config.pollIntervalMs };
  }

  async input(job: LeasedJob): Promise<ResolutionInput> {
    const response = await this.request(`/api/internal/v1/resolution/jobs/${job.id}/input`, {
      headers: { "X-Lease-Token": job.leaseToken },
    });
    return resolutionInputSchema.parse(await response.json());
  }

  async documentContent(job: LeasedJob, contentUrl: string): Promise<string> {
    const url = new URL(contentUrl);
    if (url.origin !== new URL(this.config.apiBaseUrl).origin) throw new Error("Control API returned a cross-origin content URL");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.token}`, "X-Lease-Token": job.leaseToken },
      signal: AbortSignal.timeout(60_000),
      redirect: "follow",
    });
    if (!response.ok) throw new ControlPlaneError(`Document content returned ${response.status}`, response.status, response.status >= 500);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > this.config.maxDocumentBytes) throw new Error(`Document exceeds AGENT_MAX_DOCUMENT_BYTES (${declaredLength})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.config.maxDocumentBytes) throw new Error(`Document exceeds AGENT_MAX_DOCUMENT_BYTES (${bytes.byteLength})`);
    return new TextDecoder().decode(bytes);
  }

  async heartbeat(job: LeasedJob): Promise<void> {
    await this.request(`/api/internal/v1/resolution/jobs/${job.id}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, extendBySeconds: Math.min(900, Math.max(60, Math.round(this.config.leaseSeconds / 2))) }),
    });
  }

  async complete(job: LeasedJob, completion: Omit<CompletionRequest, "leaseToken" | "contractVersion">): Promise<{ candidateId: string; reused: boolean }> {
    const response = await this.request(`/api/internal/v1/resolution/jobs/${job.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ contractVersion: "1.0", leaseToken: job.leaseToken, ...completion }),
    });
    return response.json() as Promise<{ candidateId: string; reused: boolean }>;
  }

  async fail(job: LeasedJob, error: unknown): Promise<void> {
    const retryable = !(error instanceof ControlPlaneError) || error.retryable;
    const message = error instanceof Error ? error.message : String(error);
    await this.request(`/api/internal/v1/resolution/jobs/${job.id}/fail`, {
      method: "POST",
      body: JSON.stringify({ leaseToken: job.leaseToken, errorCode: error instanceof Error ? error.name : "UNKNOWN", message, retryable }),
    });
  }
}
