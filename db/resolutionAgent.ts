import { sql } from "drizzle-orm";
import type { CompletionRequest, LeaseRequest } from "@kita/contracts";
import { getDb } from "./index";
import { sha256 } from "@/lib/resolutionAgentAuth";

const iso = (value: unknown): string => new Date(String(value)).toISOString();

export async function leaseResolutionJob(input: LeaseRequest) {
  const leaseToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const leaseTokenHash = await sha256(leaseToken);
  const workerId = crypto.randomUUID();
  const capabilities = JSON.stringify(input.capabilities);
  const result = await getDb().execute(sql`
    WITH registered_worker AS (
      INSERT INTO ingestion.worker(id,worker_name,worker_type,capabilities,model_provider,model_name,status,last_heartbeat_at,metadata)
      VALUES (${workerId}::uuid,${input.agentId},'RESOLUTION_AGENT',${capabilities}::jsonb,'LOCAL',NULL,'ONLINE',now(),${JSON.stringify({ version: input.agentVersion })}::jsonb)
      ON CONFLICT (worker_name) DO UPDATE SET
        capabilities=EXCLUDED.capabilities,status='ONLINE',last_heartbeat_at=now(),metadata=EXCLUDED.metadata,updated_at=now()
      RETURNING id
    ), next_job AS (
      SELECT j.id
      FROM ingestion.job j
      WHERE j.job_type='EVENT_RESOLUTION'
        AND j.required_capability IN (SELECT jsonb_array_elements_text(${capabilities}::jsonb))
        AND j.attempt_count < j.max_attempts
        AND (
          (j.status IN ('QUEUED','RETRY_WAIT') AND COALESCE(j.not_before,j.available_at)<=now())
          OR (j.status='RUNNING' AND j.lease_expires_at<now())
        )
      ORDER BY CASE j.priority WHEN 'REALTIME' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,j.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), leased AS (
      UPDATE ingestion.job j SET
        status='RUNNING',leased_by=(SELECT id FROM registered_worker),lease_owner=${input.agentId},
        lease_token_hash=${leaseTokenHash},lease_expires_at=now()+(${input.leaseSeconds}::text || ' seconds')::interval,
        started_at=COALESCE(started_at,now()),attempt_count=attempt_count+1,last_error=NULL,last_error_class=NULL,
        last_error_code=NULL,last_error_message_redacted=NULL
      FROM next_job WHERE j.id=next_job.id
      RETURNING j.*
    )
    SELECT l.*,
      COALESCE((SELECT jsonb_agg(d.id ORDER BY d.fetched_at) FROM ingestion.raw_document d WHERE d.crawl_run_id=l.crawl_run_id),'[]'::jsonb) AS document_ids
    FROM leased l
  `);
  const row = result.rows[0];
  if (!row) return null;
  const payload = (row.payload || {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    type: "EVENT_RESOLUTION" as const,
    attempt: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseToken,
    leaseExpiresAt: iso(row.lease_expires_at),
    input: {
      crawlRunId: String(row.crawl_run_id),
      sourceId: String(row.source_id),
      documentIds: (row.document_ids as unknown[]).map(String),
      knownEventId: payload.knownEventId ? String(payload.knownEventId) : null,
      resolutionMode: payload.resolutionMode === "LLM_REQUIRED" ? "LLM_REQUIRED" as const : "AUTO" as const,
    },
  };
}

async function verifiedLease(jobId: string, leaseToken: string) {
  const leaseTokenHash = await sha256(leaseToken);
  const result = await getDb().execute(sql`
    SELECT id,crawl_run_id,source_id,attempt_count,max_attempts,status,lease_expires_at
    FROM ingestion.job
    WHERE id=${jobId}::uuid AND job_type='EVENT_RESOLUTION' AND status='RUNNING'
      AND lease_expires_at>now() AND lease_token_hash=${leaseTokenHash}
  `);
  return result.rows[0] || null;
}

export async function getResolutionJobInput(jobId: string, leaseToken: string, origin: string) {
  const lease = await verifiedLease(jobId, leaseToken);
  if (!lease) return null;
  const db = getDb();
  const [runResult, documentResult, assertionResult, chunkResult, mediaResult] = await Promise.all([
    db.execute(sql`
      SELECT r.id,r.source_id,r.root_url,r.root_event_id,s.name AS source_name
      FROM ingestion.crawl_run r JOIN ingestion.source s ON s.id=r.source_id
      WHERE r.id=${String(lease.crawl_run_id)}::uuid
    `),
    db.execute(sql`
      SELECT id,canonical_url,title,page_type,mime_type,fetched_at,content_hash,text_preview
      FROM ingestion.raw_document WHERE crawl_run_id=${String(lease.crawl_run_id)}::uuid ORDER BY fetched_at,id
    `),
    db.execute(sql`
      SELECT a.id,a.raw_document_id,a.field_path,a.value_json,a.normalized_value_json,a.confidence,a.evidence_locator,a.evidence_excerpt
      FROM ingestion.assertion a JOIN ingestion.raw_document d ON d.id=a.raw_document_id
      WHERE d.crawl_run_id=${String(lease.crawl_run_id)}::uuid ORDER BY a.raw_document_id,a.field_path,a.confidence DESC
    `),
    db.execute(sql`
      SELECT c.raw_document_id,c.chunk_index,c.heading_path,c.content
      FROM ingestion.document_chunk c JOIN ingestion.raw_document d ON d.id=c.raw_document_id
      WHERE d.crawl_run_id=${String(lease.crawl_run_id)}::uuid ORDER BY c.raw_document_id,c.chunk_index
    `),
    db.execute(sql`
      SELECT m.id,m.raw_document_id,m.resolved_url,m.category,m.classification_score,m.width,m.height,m.mime_type
      FROM ingestion.media_candidate m JOIN ingestion.raw_document d ON d.id=m.raw_document_id
      WHERE d.crawl_run_id=${String(lease.crawl_run_id)}::uuid ORDER BY m.raw_document_id,m.classification_score DESC
    `),
  ]);
  const run = runResult.rows[0];
  if (!run) return null;
  return {
    contractVersion: "1.0" as const,
    jobId,
    crawlRun: {
      id: String(run.id),sourceId: String(run.source_id),sourceName: String(run.source_name),
      rootUrl: String(run.root_url),rootEventId: run.root_event_id ? String(run.root_event_id) : null,
    },
    documents: documentResult.rows.map((document) => {
      const documentId = String(document.id);
      return {
        id: documentId,canonicalUrl: String(document.canonical_url),title: String(document.title || ""),
        pageType: String(document.page_type || "OTHER"),mimeType: String(document.mime_type || "application/octet-stream"),
        fetchedAt: iso(document.fetched_at),contentHash: document.content_hash ? String(document.content_hash) : undefined,textPreview: String(document.text_preview || ""),
        contentUrl: `${origin}/api/internal/v1/resolution/jobs/${jobId}/documents/${documentId}/content`,
        assertions: assertionResult.rows.filter((row) => String(row.raw_document_id) === documentId).map((row) => ({
          id: String(row.id),fieldPath: String(row.field_path),value: row.value_json,
          normalizedValue: row.normalized_value_json,confidence: Number(row.confidence || 0),
          locator: String(row.evidence_locator || ""),excerpt: String(row.evidence_excerpt || ""),
        })),
        chunks: chunkResult.rows.filter((row) => String(row.raw_document_id) === documentId).map((row) => ({
          index: Number(row.chunk_index),heading: String(row.heading_path || ""),content: String(row.content || ""),
        })),
        media: mediaResult.rows.filter((row) => String(row.raw_document_id) === documentId).map((row) => ({
          id: String(row.id),url: String(row.resolved_url),category: String(row.category || "OTHER"),
          score: Number(row.classification_score || 0),width: row.width === null ? null : Number(row.width),
          height: row.height === null ? null : Number(row.height),mimeType: row.mime_type ? String(row.mime_type) : null,
        })),
      };
    }),
  };
}

export async function heartbeatResolutionJob(jobId: string, leaseToken: string, extendBySeconds: number) {
  const leaseTokenHash = await sha256(leaseToken);
  const result = await getDb().execute(sql`
    UPDATE ingestion.job SET lease_expires_at=now()+(${extendBySeconds}::text || ' seconds')::interval
    WHERE id=${jobId}::uuid AND job_type='EVENT_RESOLUTION' AND status='RUNNING'
      AND lease_expires_at>now() AND lease_token_hash=${leaseTokenHash}
    RETURNING lease_expires_at,leased_by
  `);
  if (!result.rows[0]) return null;
  await getDb().execute(sql`UPDATE ingestion.worker SET last_heartbeat_at=now(),status='ONLINE',updated_at=now() WHERE id=${String(result.rows[0].leased_by)}::uuid`);
  return { leaseExpiresAt: iso(result.rows[0].lease_expires_at) };
}

export async function completeResolutionJob(jobId: string, input: CompletionRequest) {
  const lease = await verifiedLease(jobId, input.leaseToken);
  if (!lease) {
    const existing = await getDb().execute(sql`SELECT id FROM ingestion.candidate WHERE job_id=${jobId}::uuid LIMIT 1`);
    return existing.rows[0] ? { candidateId: String(existing.rows[0].id), reused: true } : null;
  }
  const evidenceIds = [...new Set(input.result.evidence.map((item) => item.sourceDocumentId))];
  for (const relation of input.result.relations) evidenceIds.push(...relation.evidenceDocumentIds);
  for (const media of input.result.media) evidenceIds.push(media.sourceDocumentId);
  for (const group of [input.result.links, input.result.facts, input.result.ticketOffers, input.result.exhibitors, input.result.sessions, input.result.guests, input.result.updates, input.result.activities, input.result.relatedSubjects]) {
    for (const record of group) evidenceIds.push(...record.sourceDocumentIds);
  }
  const uniqueEvidenceIds = [...new Set(evidenceIds)];
  const allowedResult = await getDb().execute(sql`
    SELECT id FROM ingestion.raw_document
    WHERE crawl_run_id=${String(lease.crawl_run_id)}::uuid
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(uniqueEvidenceIds)}::jsonb))
  `);
  if (allowedResult.rows.length !== uniqueEvidenceIds.length) throw new Error("RESULT_REFERENCES_DOCUMENT_OUTSIDE_JOB");
  const mediaCandidateIds = [...new Set([
    ...input.result.media.map((item) => item.mediaCandidateId),
    ...input.result.exhibitors.flatMap((item) => item.logoMediaCandidateId ? [item.logoMediaCandidateId] : []),
    ...input.result.sessions.flatMap((item) => item.imageMediaCandidateId ? [item.imageMediaCandidateId] : []),
    ...input.result.guests.flatMap((item) => item.imageMediaCandidateId ? [item.imageMediaCandidateId] : []),
    ...input.result.updates.flatMap((item) => item.imageMediaCandidateId ? [item.imageMediaCandidateId] : []),
    ...input.result.activities.flatMap((item) => item.mediaCandidateIds),
  ])];
  if (mediaCandidateIds.length) {
    const allowedMedia = await getDb().execute(sql`
      SELECT mc.id FROM ingestion.media_candidate mc JOIN ingestion.raw_document rd ON rd.id=mc.raw_document_id
      WHERE rd.crawl_run_id=${String(lease.crawl_run_id)}::uuid
        AND mc.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(mediaCandidateIds)}::jsonb))
    `);
    if (allowedMedia.rows.length !== mediaCandidateIds.length) throw new Error("RESULT_REFERENCES_MEDIA_OUTSIDE_JOB");
  }
  const primaryDocumentId = uniqueEvidenceIds[0];
  if (!primaryDocumentId) throw new Error("RESULT_HAS_NO_EVIDENCE");
  const candidateId = crypto.randomUUID();
  const resultPayload = JSON.stringify({
    contractVersion: input.contractVersion,
    result: input.result,
    model: input.model,
    metrics: input.metrics,
  });
  const result = await getDb().execute(sql`
    WITH inserted_candidate AS (
      INSERT INTO ingestion.candidate(id,candidate_type,raw_document_id,job_id,payload,confidence,status)
      VALUES (${candidateId}::uuid,'EVENT_RESOLUTION',${primaryDocumentId}::uuid,${jobId}::uuid,${resultPayload}::jsonb,${input.result.confidence},'PENDING')
      ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING
      RETURNING id
    ), selected_candidate AS (
      SELECT id FROM inserted_candidate
      UNION ALL SELECT id FROM ingestion.candidate WHERE job_id=${jobId}::uuid LIMIT 1
    ), inserted_evidence AS (
      INSERT INTO ingestion.candidate_evidence(candidate_id,raw_document_id,is_primary)
      SELECT (SELECT id FROM selected_candidate),d.id,d.id=${primaryDocumentId}::uuid
      FROM ingestion.raw_document d WHERE d.crawl_run_id=${String(lease.crawl_run_id)}::uuid
      ON CONFLICT DO NOTHING
    ), superseded AS (
      UPDATE ingestion.candidate c SET status='SUPERSEDED',updated_at=now()
      WHERE c.status='PENDING' AND c.job_id<>${jobId}::uuid
        AND c.raw_document_id IN (SELECT id FROM ingestion.raw_document WHERE crawl_run_id=${String(lease.crawl_run_id)}::uuid)
      RETURNING c.id
    ), completed AS (
      UPDATE ingestion.job SET status='SUCCEEDED',completed_at=now(),finished_at=now(),lease_expires_at=NULL,
        lease_token_hash=NULL,result_payload=${resultPayload}::jsonb
      WHERE id=${jobId}::uuid AND status='RUNNING'
      RETURNING id
    )
    SELECT id FROM selected_candidate LIMIT 1
  `);
  return { candidateId: String(result.rows[0].id), reused: false };
}

export async function failResolutionJob(jobId: string, leaseToken: string, errorCode: string, message: string, retryable: boolean) {
  const leaseTokenHash = await sha256(leaseToken);
  const result = await getDb().execute(sql`
    UPDATE ingestion.job SET
      status=CASE WHEN ${retryable} AND attempt_count<max_attempts THEN 'RETRY_WAIT' ELSE 'DEAD' END,
      not_before=CASE WHEN ${retryable} THEN now()+(LEAST(900,power(2,attempt_count)*2)::text || ' seconds')::interval ELSE not_before END,
      lease_expires_at=NULL,lease_token_hash=NULL,last_error_class='ResolutionAgentError',last_error_code=${errorCode},
      last_error_message_redacted=${message.slice(0, 1000)},last_error=${message.slice(0, 1000)},
      finished_at=CASE WHEN NOT ${retryable} OR attempt_count>=max_attempts THEN now() ELSE finished_at END
    WHERE id=${jobId}::uuid AND job_type='EVENT_RESOLUTION' AND status='RUNNING' AND lease_token_hash=${leaseTokenHash}
    RETURNING status
  `);
  return result.rows[0] ? { status: String(result.rows[0].status) } : null;
}

export async function getResolutionDocumentArtifact(jobId: string, documentId: string, leaseToken: string) {
  const lease = await verifiedLease(jobId, leaseToken);
  if (!lease) return null;
  const result = await getDb().execute(sql`
    SELECT d.r2_bucket,d.r2_key,d.mime_type,d.title,d.canonical_url
    FROM ingestion.raw_document d
    WHERE d.id=${documentId}::uuid AND d.crawl_run_id=${String(lease.crawl_run_id)}::uuid
  `);
  const row = result.rows[0];
  return row ? { bucket: String(row.r2_bucket),key: String(row.r2_key),mimeType: String(row.mime_type || "application/octet-stream"),filename: String(row.title || row.canonical_url || documentId) } : null;
}
