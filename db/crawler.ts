import { sql } from "drizzle-orm";
import { getDb } from "./index";

export async function enqueueSourceCrawl(sourceId: string) {
  const sourceResult = await getDb().execute(sql`
    SELECT id,name,base_url,connector_key,enabled,terms_review_status,config
    FROM ingestion.source
    WHERE id=${sourceId}::uuid
  `);
  const source = sourceResult.rows[0] as Record<string, unknown> | undefined;
  if (!source) throw new Error("Source not found");
  if (!source.enabled) throw new Error("Source is disabled. Review and enable its policy first.");
  if (source.terms_review_status !== "REVIEWED_ALLOWED") throw new Error("Source terms must be REVIEWED_ALLOWED before crawling.");

  const config = (source.config || {}) as { seed_urls?: string[] };
  const url = config.seed_urls?.[0] || String(source.base_url || "");
  if (!url) throw new Error("Source has no seed URL");

  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const canonicalUrl = new URL(url).toString();
  const dedupeKey = `source-run:${sourceId}:${runId}`;
  const payload = {
    request_id: requestId,
    source_id: sourceId,
    url,
    canonical_url: canonicalUrl,
    page_type: "LISTING",
    parent_request_id: null,
    depth: 0,
    method: "GET",
    headers: {},
    body: null,
    dedupe_key: dedupeKey,
    expected_content_types: ["text/html"],
    fetch_mode_hint: "AUTO",
    render_wait: "DOM_CONTENT_LOADED",
    render_selector: null,
    capture_xhr_patterns: [],
    locale_hint: "en-US",
    not_before: null,
    priority: "NORMAL",
    metadata: {},
  };
  await getDb().execute(sql`
    WITH inserted_run AS (
      INSERT INTO ingestion.crawl_run(
        id,source_id,trigger,connector_key,connector_version,worker_version,
        policy_snapshot,status,pages_scheduled
      ) VALUES (
        ${runId}::uuid,${sourceId}::uuid,'MANUAL',${String(source.connector_key)},'1.0.0','web-console',
        jsonb_build_object('source_id',${sourceId},'source_name',${String(source.name)}),'QUEUED',1
      )
      RETURNING id
    )
    INSERT INTO ingestion.job(
      id,job_type,required_capability,status,priority,dedupe_key,payload,
      source_id,crawl_run_id,available_at,not_before,max_attempts
    ) SELECT ${jobId}::uuid,'URL_FETCH','INGESTION','QUEUED','NORMAL',${dedupeKey},
      ${JSON.stringify(payload)}::jsonb,${sourceId}::uuid,id,now(),now(),4
    FROM inserted_run
  `);
  return { runId, jobId };
}
