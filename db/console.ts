import { sql } from "drizzle-orm";
import { getDb } from "./index";
import { getCrawlerDashboardStatus, type CrawlerDashboardStatus } from "./crawler";

export interface ConsoleEvent {
  id: string;
  title: string;
  type: string;
  date: string;
  place: string;
  fandom: string;
  state: string;
  source: string;
  art: string;
  dataOrigin: "LIVE" | "MOCK";
}

export interface ConsoleAsset {
  id: string;
  title: string;
  category: string;
  dimensions: string;
  source: string;
  art: string;
  dataOrigin: "LIVE" | "MOCK";
}

export interface ConsoleSource {
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

export interface ConsoleSnapshot {
  events: ConsoleEvent[];
  assets: ConsoleAsset[];
  sources: ConsoleSource[];
  crawler: CrawlerDashboardStatus;
  totals: {
    events: number;
    entities: number;
    assets: number;
    sources: number;
    review: number;
    queuedJobs: number;
  };
  consumerShowMockData: boolean;
}

const relativeTime = (value: unknown): string => {
  if (!value) return "Never";
  const date = new Date(String(value));
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
};

const eventDate = (value: unknown): string => {
  if (!value) return "Date pending";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(String(value)));
};

export async function getConsoleSnapshot(): Promise<ConsoleSnapshot> {
  const db = getDb();
  const [eventsResult, assetsResult, sourcesResult, crawler, totalsResult, settingResult] = await Promise.all([
    db.execute(sql`
      SELECT e.id, e.canonical_name AS title, e.event_type AS type, e.start_at,
        e.status, e.data_origin, e.metadata, v.city, v.region,
        count(DISTINCT a.source_id)::int AS source_count,
        string_agg(DISTINCT linked.canonical_name, ' · ' ORDER BY linked.canonical_name) AS fandom
      FROM event.event e
      LEFT JOIN event.venue v ON v.id = e.venue_id
      LEFT JOIN ingestion.assertion a ON a.subject_id = e.id
      LEFT JOIN event.event_entity ee ON ee.event_id = e.id AND ee.status = 'ACTIVE'
      LEFT JOIN core.entity linked ON linked.id = ee.entity_id
      WHERE COALESCE(e.end_at, e.start_at) >= now()
      GROUP BY e.id, v.city, v.region
      ORDER BY e.start_at ASC NULLS LAST, e.id ASC
      LIMIT 4
    `),
    db.execute(sql`
      SELECT id, COALESCE(metadata->>'title', original_filename, 'Untitled asset') AS title,
        COALESCE(detected_category, 'OTHER') AS category, width, height,
        COALESCE(origin, 'UNKNOWN') AS source, COALESCE(metadata->>'tone', 'slate') AS tone,
        data_origin
      FROM media.asset
      ORDER BY created_at DESC
      LIMIT 50
    `),
    db.execute(sql`
      SELECT s.id, s.name, s.source_type, s.connector_key, s.trust_level, s.enabled, s.base_url,s.config,
        s.terms_review_status, s.terms_review_note, s.contact_identity, s.data_origin,s.max_depth,s.max_pages_per_run,
        st.last_success_at, st.next_fetch_at,
        count(DISTINCT rd.id)::int AS item_count
      FROM ingestion.source s
      LEFT JOIN ingestion.source_sync_state st ON st.source_id = s.id
      LEFT JOIN ingestion.raw_document rd ON rd.source_id = s.id
      GROUP BY s.id, st.last_success_at, st.next_fetch_at
      ORDER BY s.priority, s.name
      LIMIT 100
    `),
    getCrawlerDashboardStatus(),
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM event.event) AS events,
        (SELECT count(*)::int FROM core.entity) AS entities,
        (SELECT count(*)::int FROM media.asset) AS assets,
        (SELECT count(*)::int FROM ingestion.source WHERE enabled) AS sources,
        (SELECT count(*)::int FROM ingestion.candidate WHERE status = 'PENDING' AND candidate_type='EVENT_RESOLUTION' AND published_event_id IS NULL) AS review,
        (SELECT count(*)::int FROM ingestion.job WHERE job_type<>'EVENT_RESOLUTION' AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) AS queued_jobs
    `),
    db.execute(sql`SELECT COALESCE((value #>> '{}')::boolean, false) AS enabled FROM system.runtime_setting WHERE key='consumer_show_mock_data'`),
  ]);

  const totals = totalsResult.rows[0] as Record<string, unknown>;
  return {
    events: eventsResult.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      type: String(row.type).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()),
      date: eventDate(row.start_at),
      place: [row.city, row.region].filter(Boolean).join(", ") || "Venue pending",
      fandom: String(row.fandom || "Unlinked"),
      state: String(row.status).toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()),
      source: `${Number(row.source_count || 0)} sources`,
      art: String((row.metadata as Record<string, unknown> | null)?.tone || "slate"),
      dataOrigin: String(row.data_origin) as "LIVE" | "MOCK",
    })),
    assets: assetsResult.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      category: String(row.category),
      dimensions: row.width && row.height ? `${row.width} × ${row.height}` : "Dimensions pending",
      source: String(row.source).replaceAll("_", " "),
      art: String(row.tone),
      dataOrigin: String(row.data_origin) as "LIVE" | "MOCK",
    })),
    sources: sourcesResult.rows.map((row) => ({
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
    })),
    crawler,
    totals: {
      events: Number(totals.events || 0),
      entities: Number(totals.entities || 0),
      assets: Number(totals.assets || 0),
      sources: Number(totals.sources || 0),
      review: Number(totals.review || 0),
      queuedJobs: Number(totals.queued_jobs || 0),
    },
    consumerShowMockData: Boolean(settingResult.rows[0]?.enabled),
  };
}
