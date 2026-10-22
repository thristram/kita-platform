import { sql } from "drizzle-orm";
import { eventBundleSchema, type EventBundle } from "@kita/contracts";
import { getDb } from "./index";

export interface CreateManualCandidateInput {
  sourceId: string;
  name: string;
  bundle?: unknown;
}

const documentReferences = (bundle: EventBundle): string[] => {
  const values = new Set<string>();
  const add = (items: string[]) => items.forEach((value) => values.add(value));
  bundle.links.forEach((item) => add(item.sourceDocumentIds));
  bundle.facts.forEach((item) => add(item.sourceDocumentIds));
  bundle.ticketOffers.forEach((item) => add(item.sourceDocumentIds));
  bundle.exhibitors.forEach((item) => add(item.sourceDocumentIds));
  bundle.sessions.forEach((item) => add(item.sourceDocumentIds));
  bundle.guests.forEach((item) => add(item.sourceDocumentIds));
  bundle.updates.forEach((item) => add(item.sourceDocumentIds));
  bundle.activities.forEach((item) => add(item.sourceDocumentIds));
  bundle.relatedSubjects.forEach((item) => add(item.sourceDocumentIds));
  bundle.relations.forEach((item) => add(item.evidenceDocumentIds));
  bundle.media.forEach((item) => values.add(item.sourceDocumentId));
  bundle.evidence.forEach((item) => values.add(item.sourceDocumentId));
  bundle.conflicts.forEach((item) => item.values.forEach((value) => values.add(value.sourceDocumentId)));
  return [...values];
};

async function assertCandidateDocuments(candidateId: string, bundle: EventBundle): Promise<void> {
  const allowed = await getDb().execute(sql`
    SELECT raw_document_id AS id FROM ingestion.candidate_evidence WHERE candidate_id=${candidateId}::uuid
    UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${candidateId}::uuid AND raw_document_id IS NOT NULL
  `);
  const ids = new Set(allowed.rows.map((row) => String(row.id)));
  const unknown = documentReferences(bundle).filter((id) => !ids.has(id));
  if (unknown.length) throw new Error(`UNKNOWN_SOURCE_DOCUMENT_IDS: ${unknown.slice(0, 8).join(", ")}`);
}

export async function importCandidateBundle(candidateId: string, input: unknown, filename = "pasted-json"): Promise<{ bundle: EventBundle; revision: number; savedAt: string }> {
  const bundle = eventBundleSchema.parse(input);
  await assertCandidateDocuments(candidateId, bundle);
  const savedAt = new Date().toISOString();
  const result = await getDb().execute(sql`
    UPDATE ingestion.candidate
    SET payload=jsonb_set(
      payload,
      '{review}',
      COALESCE(payload->'review','{}'::jsonb) || jsonb_build_object(
        'draftBundle',${JSON.stringify(bundle)}::jsonb,
        'draftRevision',COALESCE((payload#>>'{review,draftRevision}')::int,0)+1,
        'draftSavedAt',${savedAt}::text,
        'importedAt',${savedAt}::text,
        'importFilename',${filename.slice(0, 240)}::text,
        'importFormat','event-content-bundle/v2'
      ),
      true
    ),updated_at=now()
    WHERE id=${candidateId}::uuid AND status='PENDING' AND published_event_id IS NULL
    RETURNING (payload#>>'{review,draftRevision}')::int AS revision
  `);
  if (!result.rows[0]) throw new Error("CANDIDATE_NOT_PENDING");
  return { bundle, revision: Number(result.rows[0].revision || 1), savedAt };
}

export async function createManualCandidate(input: CreateManualCandidateInput): Promise<{ candidateId: string }> {
  const scope = await getDb().execute(sql`
    WITH latest_run AS (
      SELECT id FROM ingestion.crawl_run
      WHERE source_id=${input.sourceId}::uuid AND status IN ('COMPLETED','PARTIAL')
      ORDER BY finished_at DESC NULLS LAST,scheduled_at DESC LIMIT 1
    )
    SELECT s.id AS source_id,s.name AS source_name,s.base_url,s.timezone,lr.id AS crawl_run_id,
      d.id AS document_id,d.title AS document_title,d.canonical_url
    FROM ingestion.source s
    LEFT JOIN latest_run lr ON true
    LEFT JOIN LATERAL (
      SELECT id,title,canonical_url FROM ingestion.raw_document
      WHERE crawl_run_id=lr.id
      ORDER BY CASE WHEN page_type='EVENT' THEN 0 WHEN page_type='OVERVIEW' THEN 1 ELSE 2 END,fetched_at DESC
      LIMIT 1
    ) d ON true
    WHERE s.id=${input.sourceId}::uuid
  `);
  const row = scope.rows[0];
  if (!row) throw new Error("SOURCE_NOT_FOUND");
  if (!row.crawl_run_id || !row.document_id) throw new Error("SOURCE_HAS_NO_COMPLETED_CRAWL");
  const sourceUrl = String(row.base_url || row.canonical_url || "");
  try { new URL(sourceUrl); } catch { throw new Error("SOURCE_HAS_NO_VALID_URL"); }
  const documentId = String(row.document_id);
  const createdManually = input.bundle === undefined;
  const bundle = input.bundle === undefined ? eventBundleSchema.parse({
    schemaVersion: "event-content-bundle/v2",
    event: {
      name: input.name.trim() || String(row.source_name),alternateNames: [],eventType: "CONVENTION",description: "",
      startDate: null,endDate: null,timezone: String(row.timezone || "UTC"),
      venue: { name: "",addressLine1: "",city: "",region: "",postalCode: "",countryCode: "" },
      officialUrl: sourceUrl,organizerNames: [],
    },
    links: [],facts: [],ticketOffers: [],exhibitors: [],sessions: [],guests: [],updates: [],activities: [],relatedSubjects: [],relations: [],media: [],
    evidence: [{ field: "event.name",sourceDocumentId: documentId,method: "human",quote: input.name.trim() || String(row.source_name),confidence: 1 }],
    conflicts: [],warnings: ["Manual draft created from an existing crawler source."],confidence: 1,
  }) : eventBundleSchema.parse(input.bundle);

  const runDocuments = await getDb().execute(sql`SELECT id FROM ingestion.raw_document WHERE crawl_run_id=${String(row.crawl_run_id)}::uuid`);
  const allowed = new Set(runDocuments.rows.map((item) => String(item.id)));
  const unknown = documentReferences(bundle).filter((id) => !allowed.has(id));
  if (unknown.length) throw new Error(`UNKNOWN_SOURCE_DOCUMENT_IDS: ${unknown.slice(0, 8).join(", ")}`);
  const now = new Date().toISOString();
  const payload = {
    contractVersion: "1.0",
    result: bundle,
    model: { provider: "manual", name: "editorial", promptVersion: input.bundle === undefined ? "manual-draft-v1" : "codex-import-v1" },
    metrics: {},
    review: {
      createdManually,
      sourceId: input.sourceId,
      crawlRunId: String(row.crawl_run_id),
      draftBundle: bundle,
      draftRevision: 1,
      draftSavedAt: now,
      ...(input.bundle === undefined ? {} : { importedAt: now, importFilename: "new-event-import.json", importFormat: "event-content-bundle/v2" }),
    },
  };
  const inserted = await getDb().execute(sql`
    WITH candidate AS (
      INSERT INTO ingestion.candidate(candidate_type,raw_document_id,payload,confidence,status)
      VALUES('EVENT_RESOLUTION',${documentId}::uuid,${JSON.stringify(payload)}::jsonb,1,'PENDING')
      RETURNING id
    ), evidence AS (
      INSERT INTO ingestion.candidate_evidence(candidate_id,raw_document_id,is_primary)
      SELECT c.id,d.id,d.id=${documentId}::uuid
      FROM candidate c JOIN ingestion.raw_document d ON d.crawl_run_id=${String(row.crawl_run_id)}::uuid
      ON CONFLICT DO NOTHING
    ) SELECT id FROM candidate
  `);
  const candidateId = inserted.rows[0]?.id;
  if (!candidateId) throw new Error("MANUAL_CANDIDATE_CREATE_FAILED");
  return { candidateId: String(candidateId) };
}

export async function getCandidateExportScope(candidateId: string) {
  const db = getDb();
  const [candidate, documents, assertions, chunks, media] = await Promise.all([
    db.execute(sql`
      SELECT c.id,c.created_at,c.payload,c.confidence,c.job_id,COALESCE(j.crawl_run_id,primary_document.crawl_run_id) AS crawl_run_id,
        s.id AS source_id,s.name AS source_name,s.base_url
      FROM ingestion.candidate c
      LEFT JOIN ingestion.job j ON j.id=c.job_id
      LEFT JOIN ingestion.raw_document primary_document ON primary_document.id=c.raw_document_id
      LEFT JOIN ingestion.source s ON s.id=primary_document.source_id
      WHERE c.id=${candidateId}::uuid AND c.candidate_type='EVENT_RESOLUTION'
    `),
    db.execute(sql`
      SELECT d.id,d.source_id,d.crawl_run_id,d.canonical_url,d.document_type,d.page_type,d.title,d.text_preview,d.fetched_at,
        d.content_hash,d.mime_type,d.byte_size,d.r2_bucket,d.r2_key,d.metadata
      FROM ingestion.raw_document d
      WHERE d.id IN (
        SELECT raw_document_id FROM ingestion.candidate_evidence WHERE candidate_id=${candidateId}::uuid
        UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${candidateId}::uuid AND raw_document_id IS NOT NULL
      ) ORDER BY CASE WHEN d.page_type='EVENT' THEN 0 WHEN d.page_type='OVERVIEW' THEN 1 ELSE 2 END,d.fetched_at
    `),
    db.execute(sql`
      SELECT a.id,a.raw_document_id,a.field_path,a.value_json,a.normalized_value_json,a.confidence,a.evidence_locator,a.evidence_excerpt,a.observed_at
      FROM ingestion.assertion a WHERE a.raw_document_id IN (
        SELECT raw_document_id FROM ingestion.candidate_evidence WHERE candidate_id=${candidateId}::uuid
        UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${candidateId}::uuid AND raw_document_id IS NOT NULL
      ) ORDER BY a.raw_document_id,a.field_path,a.confidence DESC NULLS LAST
    `),
    db.execute(sql`
      SELECT c.id,c.raw_document_id,c.chunk_index,c.heading_path,c.content,c.language,c.char_start,c.char_end,c.metadata
      FROM ingestion.document_chunk c WHERE c.raw_document_id IN (
        SELECT raw_document_id FROM ingestion.candidate_evidence WHERE candidate_id=${candidateId}::uuid
        UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${candidateId}::uuid AND raw_document_id IS NOT NULL
      ) ORDER BY c.raw_document_id,c.chunk_index
    `),
    db.execute(sql`
      SELECT m.id,m.raw_document_id,m.resolved_url,m.category,m.classification_score,m.fetch_status,m.r2_bucket,m.r2_key,
        m.width,m.height,m.mime_type,m.byte_size,m.sha256,m.perceptual_hash,
        m.owner_hint_type,m.owner_hint_external_key,m.storage_mode,m.usage_scope,m.license_status,
        m.source_signals,m.classification_reasons,m.attribution
      FROM ingestion.media_candidate m WHERE m.raw_document_id IN (
        SELECT raw_document_id FROM ingestion.candidate_evidence WHERE candidate_id=${candidateId}::uuid
        UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${candidateId}::uuid AND raw_document_id IS NOT NULL
      ) ORDER BY m.raw_document_id,m.classification_score DESC NULLS LAST
    `),
  ]);
  if (!candidate.rows[0]) return null;
  return { candidate: candidate.rows[0], documents: documents.rows, assertions: assertions.rows, chunks: chunks.rows, media: media.rows };
}
