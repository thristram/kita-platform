import { sql } from "drizzle-orm";
import { getDb } from "./index";

export interface CrawlerSourceRecord {
  id: string;
  name: string;
  type: string;
  trust: string;
  status: string;
  baseUrl: string;
  lastSuccess: string;
  nextRun: string;
  items: string;
  enabled: boolean;
  policyStatus: string;
  policyNote: string;
  contactIdentity: string;
  dataOrigin: "LIVE" | "MOCK";
  maxDepth: number;
  maxPagesPerRun: number;
  connectorKey: string;
  followOfficialSites: boolean;
  discoverLinkedEvents: boolean;
}

export interface CrawlerWorkerStatus {
  id: string;
  name: string;
  version: string;
  state: "Online" | "Offline";
  lastHeartbeatAt: string | null;
  heartbeatAge: string;
}

export interface CrawlerRunStatus {
  id: string;
  sourceId: string;
  sourceName: string;
  status: string;
  progress: number;
  pagesScheduled: number;
  pagesFetched: number;
  pagesUnchanged: number;
  pagesFailed: number;
  pagesBlocked: number;
  assertions: number;
  candidates: number;
  media: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CrawlerJobStatus {
  id: string;
  runId: string | null;
  sourceId: string | null;
  sourceName: string;
  type: string;
  capability: string;
  priority: string;
  status: string;
  worker: string;
  age: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string;
  dataOrigin: "LIVE" | "MOCK";
}

export interface CrawlerDashboardStatus {
  checkedAt: string;
  workers: CrawlerWorkerStatus[];
  runs: CrawlerRunStatus[];
  jobs: CrawlerJobStatus[];
}

export interface CreateCrawlerSourceInput {
  name: string;
  url: string;
  connectorKey?: "website" | "animecons";
  trustLevel: "OFFICIAL" | "VERIFIED" | "COMMUNITY";
  policyApproved: boolean;
  reviewNote: string;
  contactIdentity: string;
  rootEventId?: string;
  followOfficialSites?: boolean;
  discoverLinkedEvents?: boolean;
}

const relativeTime = (value: unknown): string => {
  if (!value) return "Never";
  const date = new Date(String(value));
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

const titleCase = (value: unknown): string => String(value)
  .replaceAll("_", " ")
  .toLowerCase()
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const normalizeSourceUrl = (value: string): URL => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Source URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Source URLs cannot contain credentials");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Source URL uses an unsupported port");
  if (!url.hostname) throw new Error("Source URL must include a hostname");
  url.hash = "";
  return url;
};

const mapSource = (row: Record<string, unknown>): CrawlerSourceRecord => ({
  id: String(row.id),
  name: String(row.name),
  type: String(row.source_type),
  trust: String(row.trust_level),
  status: row.enabled ? "Healthy" : "Disabled",
  baseUrl: String(row.base_url || ""),
  lastSuccess: relativeTime(row.last_success_at),
  nextRun: row.next_fetch_at ? relativeTime(row.next_fetch_at) : "Manual",
  items: String(row.item_count || 0),
  enabled: Boolean(row.enabled),
  policyStatus: String(row.terms_review_status),
  policyNote: String(row.terms_review_note || ""),
  contactIdentity: String(row.contact_identity || ""),
  dataOrigin: String(row.data_origin) as "LIVE" | "MOCK",
  maxDepth: Number(row.max_depth || 3),
  maxPagesPerRun: Number(row.max_pages_per_run || 100),
  connectorKey: String(row.connector_key || "website"),
  followOfficialSites: Boolean((row.config as Record<string, unknown> | null)?.follow_official_sites),
  discoverLinkedEvents: (row.config as Record<string, unknown> | null)?.discover_linked_events !== false,
});

export async function getCrawlerSource(sourceId: string): Promise<CrawlerSourceRecord | null> {
  const result = await getDb().execute(sql`
    SELECT s.id,s.name,s.source_type,s.connector_key,s.trust_level,s.enabled,s.base_url,s.config,
      s.terms_review_status,s.terms_review_note,s.contact_identity,s.data_origin,s.max_depth,s.max_pages_per_run,
      st.last_success_at,st.next_fetch_at,count(DISTINCT rd.id)::int AS item_count
    FROM ingestion.source s
    LEFT JOIN ingestion.source_sync_state st ON st.source_id=s.id
    LEFT JOIN ingestion.raw_document rd ON rd.source_id=s.id
    WHERE s.id=${sourceId}::uuid
    GROUP BY s.id,st.last_success_at,st.next_fetch_at
  `);
  return result.rows[0] ? mapSource(result.rows[0] as Record<string, unknown>) : null;
}

export async function createCrawlerSource(input: CreateCrawlerSourceInput): Promise<CrawlerSourceRecord> {
  const url = normalizeSourceUrl(input.url);
  if (input.policyApproved && !input.reviewNote.trim()) {
    throw new Error("Add a policy review note before enabling this source");
  }
  const duplicate = await getDb().execute(sql`
    SELECT id FROM ingestion.source WHERE lower(base_url)=lower(${url.toString()}) LIMIT 1
  `);
  if (duplicate.rows[0]) {
    const existingId = String(duplicate.rows[0].id);
    if (!input.rootEventId) throw new Error("A source with this URL already exists");
    await getDb().execute(sql`
      INSERT INTO ingestion.event_source(event_id,source_id,relation_type,confidence)
      VALUES (${input.rootEventId}::uuid,${existingId}::uuid,'SEED',1)
      ON CONFLICT (event_id,source_id,relation_type) DO UPDATE SET updated_at=now()
    `);
    const existing = await getCrawlerSource(existingId);
    if (!existing) throw new Error("Existing source could not be reloaded");
    return existing;
  }

  const id = crypto.randomUUID();
  await getDb().execute(sql`
    INSERT INTO ingestion.source(
      id,name,source_type,connector_key,base_url,trust_level,priority,enabled,config,
      officiality,timezone,robots_mode,terms_review_status,terms_reviewed_at,
      terms_review_note,contact_identity,allowed_domains,allowed_path_prefixes,
      denied_path_prefixes,default_fetch_mode,data_origin
    ) VALUES (
      ${id}::uuid,${input.name},${input.connectorKey === "animecons" ? "EVENT_DIRECTORY" : "WEBSITE"},${input.connectorKey || "website"},${url.toString()},${input.trustLevel},'NORMAL',
      ${input.policyApproved},${JSON.stringify({ seed_urls: [url.toString()], follow_official_sites: Boolean(input.followOfficialSites), discover_linked_events: input.discoverLinkedEvents !== false, ...(input.rootEventId ? { root_event_id: input.rootEventId } : {}) })}::jsonb,
      ${input.trustLevel === "OFFICIAL" ? "FIRST_PARTY" : "THIRD_PARTY"},'UTC','ENFORCE',
      ${input.policyApproved ? "REVIEWED_ALLOWED" : "UNKNOWN"},
      CASE WHEN ${input.policyApproved} THEN now() ELSE NULL END,
      ${input.reviewNote.trim() || null},${input.contactIdentity.trim() || null},
      ARRAY[${url.hostname.toLowerCase()}]::text[],ARRAY['/']::text[],ARRAY[]::text[],
      'HTTP','LIVE'
    )
  `);
  if (input.rootEventId) {
    await getDb().execute(sql`
      INSERT INTO ingestion.event_source(event_id,source_id,relation_type,confidence)
      VALUES (${input.rootEventId}::uuid,${id}::uuid,'SEED',1)
      ON CONFLICT (event_id,source_id,relation_type) DO UPDATE SET updated_at=now()
    `);
  }
  const source = await getCrawlerSource(id);
  if (!source) throw new Error("Source was created but could not be reloaded");
  return source;
}

export async function reviewCrawlerSource(
  sourceId: string,
  input: { approved: boolean; reviewNote: string; contactIdentity: string; maxDepth?: number; maxPagesPerRun?: number; followOfficialSites?: boolean; discoverLinkedEvents?: boolean },
): Promise<CrawlerSourceRecord> {
  if (input.approved && !input.reviewNote.trim()) {
    throw new Error("Add a policy review note before enabling this source");
  }
  await getDb().execute(sql`
    UPDATE ingestion.source SET
      enabled=${input.approved},
      terms_review_status=${input.approved ? "REVIEWED_ALLOWED" : "REVIEWED_DENIED"},
      terms_reviewed_at=now(),terms_review_note=${input.reviewNote.trim()},
      contact_identity=${input.contactIdentity.trim() || null},updated_at=now()
      ,max_depth=${input.maxDepth ?? 3},max_pages_per_run=${input.maxPagesPerRun ?? 100}
      ,config=config || ${JSON.stringify({ ...(input.followOfficialSites !== undefined ? { follow_official_sites: input.followOfficialSites } : {}), ...(input.discoverLinkedEvents !== undefined ? { discover_linked_events: input.discoverLinkedEvents } : {}) })}::jsonb
    WHERE id=${sourceId}::uuid
  `);
  const source = await getCrawlerSource(sourceId);
  if (!source) throw new Error("Source not found");
  return source;
}

export async function getCrawlerDashboardStatus(): Promise<CrawlerDashboardStatus> {
  const [workersResult, runsResult, jobsResult] = await Promise.all([
    getDb().execute(sql`
      SELECT id,worker_name,status,last_heartbeat_at,metadata,
        (last_heartbeat_at >= now()-interval '10 seconds') AS is_online
      FROM ingestion.worker
      WHERE worker_type<>'RESOLUTION_AGENT'
      ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 20
    `),
    getDb().execute(sql`
      SELECT r.id,r.source_id,s.name AS source_name,r.status,r.pages_scheduled,
        r.pages_fetched,r.pages_unchanged,r.pages_failed,r.pages_blocked,r.assertions_emitted,
        r.candidates_emitted,r.media_discovered,r.created_at,r.started_at,r.finished_at
      FROM ingestion.crawl_run r
      JOIN ingestion.source s ON s.id=r.source_id
      ORDER BY r.created_at DESC LIMIT 50
    `),
    getDb().execute(sql`
      SELECT j.id,j.crawl_run_id,j.source_id,s.name AS source_name,j.job_type,
        j.required_capability,j.priority,j.status,j.created_at,j.attempt_count,j.max_attempts,
        COALESCE(j.lease_owner,w.worker_name,'Unassigned') AS worker,
        COALESCE(j.last_error_message_redacted,j.last_error,'') AS last_error,
        COALESCE(s.data_origin,'LIVE') AS data_origin
      FROM ingestion.job j
      LEFT JOIN ingestion.worker w ON w.id=j.leased_by
      LEFT JOIN ingestion.source s ON s.id=j.source_id
      WHERE j.job_type<>'EVENT_RESOLUTION'
      ORDER BY j.created_at DESC LIMIT 100
    `),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    workers: workersResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.worker_name),
      version: String((row.metadata as Record<string, unknown> | null)?.version || "unknown"),
      state: row.is_online ? "Online" : "Offline",
      lastHeartbeatAt: row.last_heartbeat_at ? new Date(String(row.last_heartbeat_at)).toISOString() : null,
      heartbeatAge: relativeTime(row.last_heartbeat_at),
    })),
    runs: runsResult.rows.map((row) => {
      const scheduled = Number(row.pages_scheduled || 0);
      const completed = Number(row.pages_fetched || 0) + Number(row.pages_unchanged || 0) + Number(row.pages_failed || 0) + Number(row.pages_blocked || 0);
      return {
        id: String(row.id),
        sourceId: String(row.source_id),
        sourceName: String(row.source_name),
        status: titleCase(row.status),
        progress: scheduled ? Math.min(100, Math.round((completed / scheduled) * 100)) : 0,
        pagesScheduled: scheduled,
        pagesFetched: Number(row.pages_fetched || 0),
        pagesUnchanged: Number(row.pages_unchanged || 0),
        pagesFailed: Number(row.pages_failed || 0),
        pagesBlocked: Number(row.pages_blocked || 0),
        assertions: Number(row.assertions_emitted || 0),
        candidates: Number(row.candidates_emitted || 0),
        media: Number(row.media_discovered || 0),
        createdAt: new Date(String(row.created_at)).toISOString(),
        startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
        finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
      };
    }),
    jobs: jobsResult.rows.map((row) => ({
      id: String(row.id),
      runId: row.crawl_run_id ? String(row.crawl_run_id) : null,
      sourceId: row.source_id ? String(row.source_id) : null,
      sourceName: String(row.source_name || "Unknown source"),
      type: titleCase(row.job_type),
      capability: String(row.required_capability),
      priority: String(row.priority),
      status: titleCase(row.status),
      worker: String(row.worker),
      age: relativeTime(row.created_at),
      attemptCount: Number(row.attempt_count || 0),
      maxAttempts: Number(row.max_attempts || 0),
      lastError: String(row.last_error || ""),
      dataOrigin: String(row.data_origin) as "LIVE" | "MOCK",
    })),
  };
}

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

  const config = (source.config || {}) as { seed_urls?: string[]; root_event_id?: string; follow_official_sites?: boolean; discover_linked_events?: boolean };
  const url = config.seed_urls?.[0] || String(source.base_url || "");
  if (!url) throw new Error("Source has no seed URL");

  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const canonicalUrl = new URL(url).toString();
  const dedupeKey = `source-run:${sourceId}:${runId}`;
  const policySnapshot = {
    source_id: sourceId,
    source_name: String(source.name),
  };
  const payload = {
    request_id: requestId,
    source_id: sourceId,
    url,
    canonical_url: canonicalUrl,
    page_type: String(source.connector_key) === "animecons" && /\/events\/info\/\d+/.test(url) ? "EVENT" : "LISTING",
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
    metadata: {
      auto_approve_official_site: String(source.connector_key) === "animecons" && Boolean(config.follow_official_sites),
      discover_linked_events: config.discover_linked_events !== false,
    },
  };
  await getDb().execute(sql`
    WITH inserted_run AS (
      INSERT INTO ingestion.crawl_run(
        id,source_id,trigger,connector_key,connector_version,worker_version,
        policy_snapshot,status,pages_scheduled,root_event_id,root_url,config_snapshot
      ) VALUES (
        ${runId}::uuid,${sourceId}::uuid,'MANUAL',${String(source.connector_key)},'1.0.0','web-console',
        ${JSON.stringify(policySnapshot)}::jsonb,'QUEUED',1,
        NULLIF(${String(config.root_event_id || "")},'')::uuid,${canonicalUrl},${JSON.stringify(config)}::jsonb
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
  await getDb().execute(sql`UPDATE ingestion.crawl_run SET job_id=${jobId}::uuid WHERE id=${runId}::uuid`);
  return { runId, jobId };
}
