import { sql } from "drizzle-orm";
import { getDb } from "./index";
import { enqueueSourceCrawl } from "./crawler";

const iso = (value: unknown) => value ? new Date(String(value)).toISOString() : null;

export async function getCrawlRunDetail(runId: string) {
  const db = getDb();
  const [runResult, discoveries, documents, media, sourceCandidates] = await Promise.all([
    db.execute(sql`SELECT r.*,s.name AS source_name,s.base_url FROM ingestion.crawl_run r JOIN ingestion.source s ON s.id=r.source_id WHERE r.id=${runId}::uuid`),
    db.execute(sql`SELECT * FROM ingestion.discovered_url WHERE crawl_run_id=${runId}::uuid ORDER BY priority_score DESC NULLS LAST,discovered_at`),
    db.execute(sql`SELECT id,canonical_url,document_type,page_type,title,fetched_at,content_hash,mime_type,byte_size,processing_status,r2_bucket,r2_key FROM ingestion.raw_document WHERE crawl_run_id=${runId}::uuid ORDER BY fetched_at DESC`),
    db.execute(sql`SELECT id,resolved_url,category,classification_score,fetch_status,r2_bucket,r2_key,width,height,mime_type FROM ingestion.media_candidate WHERE crawl_run_id=${runId}::uuid ORDER BY classification_score DESC`),
    db.execute(sql`SELECT id,candidate_type,url,display_name,confidence,status,created_source_id,evidence FROM ingestion.source_candidate WHERE crawl_run_id=${runId}::uuid ORDER BY confidence DESC`),
  ]);
  const row = runResult.rows[0];
  if (!row) return null;
  return {
    run: {
      id: String(row.id), sourceId: String(row.source_id), sourceName: String(row.source_name), baseUrl: String(row.base_url || ""), rootEventId: row.root_event_id ? String(row.root_event_id) : null,
      rootUrl: String(row.root_url || ""), status: String(row.status), trigger: String(row.trigger), scheduledAt: iso(row.scheduled_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at),
      pagesScheduled: Number(row.pages_scheduled || 0), pagesFetched: Number(row.pages_fetched || 0), pagesUnchanged: Number(row.pages_unchanged || 0), pagesFailed: Number(row.pages_failed || 0), pagesBlocked: Number(row.pages_blocked || 0),
      documentsCreated: Number(row.documents_created || 0), bytesFetched: Number(row.bytes_fetched || 0), mediaDiscovered: Number(row.media_discovered || 0), logoStatus: String(row.logo_discovery_status || "NOT_RUN"),
      configSnapshot: row.config_snapshot || {}, errors: row.error_summary || {}, policySnapshot: row.policy_snapshot || {},
    },
    discoveries: discoveries.rows.map((item) => ({ ...item, id: String(item.id), parent_raw_document_id: item.parent_raw_document_id ? String(item.parent_raw_document_id) : null, fetched_raw_document_id: item.fetched_raw_document_id ? String(item.fetched_raw_document_id) : null })),
    documents: documents.rows.map((item) => ({ ...item, id: String(item.id), fetched_at: iso(item.fetched_at) })),
    media: media.rows.map((item) => ({ ...item, id: String(item.id) })),
    sourceCandidates: sourceCandidates.rows.map((item) => ({ ...item, id: String(item.id), created_source_id: item.created_source_id ? String(item.created_source_id) : null })),
  };
}

export async function getRawDocumentDetail(rawDocumentId: string) {
  const db = getDb();
  const [document, chunks, candidates, media] = await Promise.all([
    db.execute(sql`SELECT d.*,s.name AS source_name FROM ingestion.raw_document d JOIN ingestion.source s ON s.id=d.source_id WHERE d.id=${rawDocumentId}::uuid`),
    db.execute(sql`SELECT id,chunk_index,heading_path,content,language,char_start,char_end,metadata FROM ingestion.document_chunk WHERE raw_document_id=${rawDocumentId}::uuid ORDER BY chunk_index LIMIT 100`),
    db.execute(sql`SELECT id,candidate_type,confidence,status,payload,created_at FROM ingestion.candidate WHERE raw_document_id=${rawDocumentId}::uuid ORDER BY created_at DESC`),
    db.execute(sql`SELECT id,resolved_url,category,classification_score,fetch_status,width,height,mime_type FROM ingestion.media_candidate WHERE raw_document_id=${rawDocumentId}::uuid ORDER BY classification_score DESC`),
  ]);
  const row = document.rows[0];
  if (!row) return null;
  return { document: { ...row, id: String(row.id), source_id: String(row.source_id), crawl_run_id: row.crawl_run_id ? String(row.crawl_run_id) : null, root_event_id: row.root_event_id ? String(row.root_event_id) : null, fetched_at: iso(row.fetched_at), created_at: iso(row.created_at) }, chunks: chunks.rows.map((item) => ({ ...item, id: String(item.id) })), candidates: candidates.rows.map((item) => ({ ...item, id: String(item.id), created_at: iso(item.created_at) })), media: media.rows.map((item) => ({ ...item, id: String(item.id) })) };
}

export async function getRawArtifactMetadata(rawDocumentId: string) {
  const result = await getDb().execute(sql`SELECT r2_bucket,r2_key,mime_type,title,canonical_url FROM ingestion.raw_document WHERE id=${rawDocumentId}::uuid`);
  const row = result.rows[0];
  return row ? { bucket: String(row.r2_bucket), key: String(row.r2_key), mimeType: String(row.mime_type || "application/octet-stream"), filename: String(row.title || row.canonical_url || rawDocumentId) } : null;
}

export async function getMediaArtifactMetadata(mediaAssetId: string) {
  const result = await getDb().execute(sql`SELECT r2_bucket,r2_key,mime_type,COALESCE(original_filename,metadata->>'title',id::text) AS title FROM media.asset WHERE id=${mediaAssetId}::uuid`);
  const row = result.rows[0];
  return row && row.r2_bucket && row.r2_key ? { bucket: String(row.r2_bucket), key: String(row.r2_key), mimeType: String(row.mime_type || "application/octet-stream"), filename: String(row.title) } : null;
}

export async function retryCrawlRun(runId: string) {
  const result = await getDb().execute(sql`SELECT source_id FROM ingestion.crawl_run WHERE id=${runId}::uuid`);
  if (!result.rows[0]) throw new Error("Crawl run not found");
  return enqueueSourceCrawl(String(result.rows[0].source_id));
}

export async function enqueueCrawlRunResolution(runId: string) {
  const result = await getDb().execute(sql`
    WITH eligible AS (
      SELECT r.id,r.source_id,r.root_event_id,count(d.id)::int AS document_count
      FROM ingestion.crawl_run r
      JOIN ingestion.source s ON s.id=r.source_id AND s.connector_key<>'animecons'
      JOIN ingestion.raw_document d ON d.crawl_run_id=r.id
      WHERE r.id=${runId}::uuid AND r.status IN ('COMPLETED','PARTIAL')
        AND NOT EXISTS (
          SELECT 1 FROM ingestion.job pending
          WHERE pending.crawl_run_id=r.id
            AND pending.job_type IN ('URL_FETCH','MEDIA_FETCH')
            AND pending.status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')
        )
      GROUP BY r.id,r.source_id,r.root_event_id
    ), inserted AS (
      INSERT INTO ingestion.job(job_type,required_capability,status,priority,dedupe_key,payload,source_id,crawl_run_id,available_at,not_before,max_attempts)
      SELECT 'EVENT_RESOLUTION','EVENT_RESOLUTION_V1','QUEUED','NORMAL',
        'event-resolution:v2:run:' || id::text || ':documents:' || document_count::text,
        jsonb_build_object('crawlRunId',id,'sourceId',source_id,'knownEventId',root_event_id,'documentCount',document_count),
        source_id,id,now(),now(),4
      FROM eligible
      ON CONFLICT(dedupe_key) DO NOTHING
      RETURNING id,status,crawl_run_id
    )
    SELECT id,status,crawl_run_id,false AS reused FROM inserted
    UNION ALL
    SELECT j.id,j.status,j.crawl_run_id,true AS reused
    FROM ingestion.job j,eligible e
    WHERE j.dedupe_key='event-resolution:v2:run:' || e.id::text || ':documents:' || e.document_count::text
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Crawl run is not complete or still has crawler work in progress");
  return { jobId: String(row.id), status: String(row.status), crawlRunId: String(row.crawl_run_id), reused: Boolean(row.reused) };
}

export async function getEventEvidence(eventId: string) {
  const db = getDb();
  const [event, runs, sources, documents, media, graph] = await Promise.all([
    db.execute(sql`SELECT id,canonical_name,official_url,enrichment_state,internal_cover_asset_id FROM event.event WHERE id=${eventId}::uuid`),
    db.execute(sql`SELECT id,status,scheduled_at,started_at,finished_at,pages_scheduled,pages_fetched,pages_unchanged,pages_failed,documents_created,media_discovered,logo_discovery_status,error_summary FROM ingestion.crawl_run WHERE root_event_id=${eventId}::uuid ORDER BY scheduled_at DESC LIMIT 20`),
    db.execute(sql`SELECT s.id,s.name,s.source_type,s.base_url,s.trust_level,s.enabled,es.relation_type,es.confidence FROM ingestion.event_source es JOIN ingestion.source s ON s.id=es.source_id WHERE es.event_id=${eventId}::uuid ORDER BY es.confidence DESC`),
    db.execute(sql`SELECT id,canonical_url,document_type,page_type,title,fetched_at,mime_type,byte_size FROM ingestion.raw_document WHERE root_event_id=${eventId}::uuid ORDER BY fetched_at DESC LIMIT 100`),
    db.execute(sql`SELECT a.id,a.detected_category,a.source_url,a.r2_bucket,a.r2_key,a.width,a.height,a.mime_type,ma.role,ma.is_default_internal,ma.pinned FROM media.assignment ma JOIN media.asset a ON a.id=ma.asset_id WHERE ma.event_id=${eventId}::uuid ORDER BY ma.pinned DESC,ma.is_default_internal DESC,ma.priority_score DESC NULLS LAST`),
    db.execute(sql`SELECT id,parent_raw_document_id,normalized_url,anchor_text,link_kind,page_hint,priority_score,decision,decision_reason,fetched_raw_document_id FROM ingestion.discovered_url WHERE root_event_id=${eventId}::uuid ORDER BY discovered_at,priority_score DESC`),
  ]);
  if (!event.rows[0]) return null;
  return { event: event.rows[0], runs: runs.rows.map((row) => ({ ...row, id: String(row.id), scheduled_at: iso(row.scheduled_at), started_at: iso(row.started_at), finished_at: iso(row.finished_at) })), sources: sources.rows.map((row) => ({ ...row, id: String(row.id) })), documents: documents.rows.map((row) => ({ ...row, id: String(row.id), fetched_at: iso(row.fetched_at) })), media: media.rows.map((row) => ({ ...row, id: String(row.id) })), graph: graph.rows.map((row) => ({ ...row, id: String(row.id), parent_raw_document_id: row.parent_raw_document_id ? String(row.parent_raw_document_id) : null, fetched_raw_document_id: row.fetched_raw_document_id ? String(row.fetched_raw_document_id) : null })) };
}
