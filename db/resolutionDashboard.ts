import { sql } from "drizzle-orm";
import { getDb } from "./index";

export interface ResolutionWorkerStatus {
  id: string;
  name: string;
  version: string;
  state: "Online" | "Offline";
  model: string;
  lastHeartbeatAt: string | null;
}

export interface ResolutionJobStatus {
  id: string;
  crawlRunId: string;
  sourceName: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  worker: string;
  mode: "AUTO" | "LLM_REQUIRED";
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  documentCount: number;
  candidateId: string | null;
  warnings: string[];
  errorCode: string;
  error: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ResolutionDashboardStatus {
  checkedAt: string;
  workers: ResolutionWorkerStatus[];
  jobs: ResolutionJobStatus[];
}

const date = (value: unknown): string | null => value ? new Date(String(value)).toISOString() : null;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export async function getResolutionDashboardStatus(): Promise<ResolutionDashboardStatus> {
  const [workers, jobs] = await Promise.all([
    getDb().execute(sql`
      SELECT id,worker_name,last_heartbeat_at,model_provider,model_name,metadata,
        last_heartbeat_at>=now()-interval '15 seconds' AS is_online
      FROM ingestion.worker
      WHERE worker_type='RESOLUTION_AGENT'
      ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 20
    `),
    getDb().execute(sql`
      SELECT j.id,j.crawl_run_id,j.status,j.attempt_count,j.max_attempts,j.payload,j.result_payload,
        j.created_at,j.started_at,j.completed_at,j.finished_at,j.last_error_code,
        COALESCE(j.last_error_message_redacted,j.last_error,'') AS last_error,
        COALESCE(j.lease_owner,w.worker_name,'Unassigned') AS worker,
        COALESCE(s.name,'Unknown source') AS source_name,
        c.id AS candidate_id,c.payload AS candidate_payload,
        COALESCE((j.payload->>'documentCount')::int,(SELECT count(*)::int FROM ingestion.raw_document d WHERE d.crawl_run_id=j.crawl_run_id)) AS document_count
      FROM ingestion.job j
      LEFT JOIN ingestion.worker w ON w.id=j.leased_by
      LEFT JOIN ingestion.source s ON s.id=j.source_id
      LEFT JOIN LATERAL (SELECT id,payload FROM ingestion.candidate WHERE job_id=j.id ORDER BY created_at DESC LIMIT 1) c ON true
      WHERE j.job_type='EVENT_RESOLUTION'
      ORDER BY j.created_at DESC LIMIT 100
    `),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    workers: workers.rows.map((row) => ({
      id: String(row.id),
      name: String(row.worker_name),
      version: String(object(row.metadata).version || "unknown"),
      state: row.is_online ? "Online" : "Offline",
      model: [row.model_provider, row.model_name].filter(Boolean).map(String).join(" / ") || "Reported by job",
      lastHeartbeatAt: date(row.last_heartbeat_at),
    })),
    jobs: jobs.rows.map((row) => {
      const jobPayload = object(row.payload);
      const completion = object(row.candidate_payload || row.result_payload);
      const model = object(completion.model);
      const metrics = object(completion.metrics);
      const result = object(completion.result);
      return {
        id: String(row.id),
        crawlRunId: String(row.crawl_run_id || ""),
        sourceName: String(row.source_name),
        status: String(row.status),
        attempt: Number(row.attempt_count || 0),
        maxAttempts: Number(row.max_attempts || 0),
        worker: String(row.worker),
        mode: jobPayload.resolutionMode === "LLM_REQUIRED" ? "LLM_REQUIRED" : "AUTO",
        modelProvider: String(model.provider || "pending"),
        modelName: String(model.name || "pending"),
        promptVersion: String(model.promptVersion || "pending"),
        inputTokens: numberOrNull(metrics.inputTokens),
        outputTokens: numberOrNull(metrics.outputTokens),
        durationMs: numberOrNull(metrics.durationMs),
        documentCount: Number(row.document_count || 0),
        candidateId: row.candidate_id ? String(row.candidate_id) : null,
        warnings: strings(result.warnings),
        errorCode: String(row.last_error_code || ""),
        error: String(row.last_error || ""),
        createdAt: date(row.created_at) || new Date(0).toISOString(),
        startedAt: date(row.started_at),
        completedAt: date(row.completed_at || row.finished_at),
      } satisfies ResolutionJobStatus;
    }),
  };
}
