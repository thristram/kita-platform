import type { AgentConfig } from "./config.js";
import { ResolutionControlClient } from "./client.js";
import { KnowledgeServiceClient } from "./knowledge/client.js";
import { log } from "./logger.js";
import { resolveEvent } from "./pipelines/event.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runWorker(config: AgentConfig, options: { once?: boolean } = {}): Promise<void> {
  const client = new ResolutionControlClient(config);
  const knowledge = new KnowledgeServiceClient(config);
  log("info", "Resolution Agent started", { agentId: config.agentId, knowledgeServiceConfigured: knowledge.enabled, once: Boolean(options.once) });
  do {
    let retryAfterMs = config.pollIntervalMs;
    try {
      const lease = await client.lease();
      retryAfterMs = lease.retryAfterMs;
      if (!lease.job) {
        if (options.once) return;
        await sleep(retryAfterMs);
        continue;
      }
      const job = lease.job;
      log("info", "Leased resolution job", { jobId: job.id, attempt: job.attempt, documents: job.input.documentIds.length });
      const heartbeat = setInterval(() => void client.heartbeat(job).catch((error) => log("warn", "Lease heartbeat failed", { jobId: job.id, error: error instanceof Error ? error.message : String(error) })), Math.max(30_000, config.leaseSeconds * 500));
      const startedAt = Date.now();
      try {
        const input = await client.input(job);
        const resolved = await resolveEvent(config, client, knowledge, job, input);
        const completion = await client.complete(job, {
          result: resolved.result,
          model: resolved.model,
          metrics: { durationMs: Date.now() - startedAt, inputTokens: resolved.inputTokens, outputTokens: resolved.outputTokens },
        });
        log("info", "Completed resolution job", { jobId: job.id, candidateId: completion.candidateId, reused: completion.reused });
      } catch (error) {
        log("error", "Resolution job failed", { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
        await client.fail(job, error).catch((reportError) => log("error", "Could not report job failure", { jobId: job.id, error: reportError instanceof Error ? reportError.message : String(reportError) }));
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      log("error", "Worker loop failed", { error: error instanceof Error ? error.message : String(error) });
    }
    if (!options.once) await sleep(retryAfterMs);
  } while (!options.once);
}
