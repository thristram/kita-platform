import { sql, type SQL } from "drizzle-orm";
import { getDb } from "./index";
import type { ConsoleEvent } from "./console";

export type EventSortField = "title" | "type" | "date" | "fandom" | "source" | "state";
export type EventSortDirection = "asc" | "desc";
export type EventTimeFilter = "all" | "upcoming" | "past" | "undated";

export interface EventListQuery {
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  type: string;
  status: string;
  origin: "all" | "LIVE" | "MOCK";
  time: EventTimeFilter;
  sort: EventSortField;
  direction: EventSortDirection;
}

export interface ConsoleEventPage {
  events: ConsoleEvent[];
  total: number;
  page: number;
  pageSize: EventListQuery["pageSize"];
  pageCount: number;
  query: EventListQuery;
  facets: { types: string[]; statuses: string[] };
}

type QueryInput = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined): string => Array.isArray(value) ? value[0] || "" : value || "";
const positiveInteger = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function parseEventListQuery(input: QueryInput = {}): EventListQuery {
  const pageSize = positiveInteger(first(input.pageSize), 25);
  const sort = first(input.sort);
  const direction = first(input.direction);
  const origin = first(input.origin);
  const time = first(input.time);
  return {
    page: Math.min(100_000, positiveInteger(first(input.page), 1)),
    pageSize: pageSize === 50 || pageSize === 100 ? pageSize : 25,
    search: first(input.q).trim().slice(0, 160),
    type: first(input.type).trim().slice(0, 80),
    status: first(input.status).trim().slice(0, 80),
    origin: origin === "LIVE" || origin === "MOCK" ? origin : "all",
    time: time === "upcoming" || time === "past" || time === "undated" ? time : "all",
    sort: sort === "title" || sort === "type" || sort === "fandom" || sort === "source" || sort === "state" ? sort : "date",
    direction: direction === "asc" ? "asc" : "desc",
  };
}

const eventDate = (value: unknown): string => value
  ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(String(value)))
  : "Date pending";
const titleCase = (value: unknown): string => String(value || "").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

export async function listConsoleEvents(query: EventListQuery): Promise<ConsoleEventPage> {
  const db = getDb();
  const filters: SQL[] = [sql`true`];
  if (query.search) {
    const match = `%${query.search}%`;
    filters.push(sql`(
      e.canonical_name ILIKE ${match} OR e.event_type ILIKE ${match} OR e.status ILIKE ${match}
      OR COALESCE(v.name, '') ILIKE ${match} OR COALESCE(v.city, '') ILIKE ${match}
      OR COALESCE(v.region, '') ILIKE ${match}
      OR EXISTS (
        SELECT 1 FROM event.event_entity ee JOIN core.entity linked ON linked.id=ee.entity_id
        WHERE ee.event_id=e.id AND ee.status='ACTIVE' AND linked.canonical_name ILIKE ${match}
      )
      OR EXISTS (
        SELECT 1 FROM event.related_subject rs WHERE rs.event_id=e.id AND rs.label ILIKE ${match}
      )
    )`);
  }
  if (query.type) filters.push(sql`e.event_type = ${query.type}`);
  if (query.status) filters.push(sql`e.status = ${query.status}`);
  if (query.origin !== "all") filters.push(sql`e.data_origin = ${query.origin}`);
  if (query.time === "upcoming") filters.push(sql`COALESCE(e.end_at, e.start_at) >= now()`);
  if (query.time === "past") filters.push(sql`COALESCE(e.end_at, e.start_at) < now()`);
  if (query.time === "undated") filters.push(sql`e.start_at IS NULL AND e.end_at IS NULL`);
  const where = sql.join(filters, sql` AND `);

  const countResult = await db.execute(sql`
    SELECT count(*)::int AS total FROM event.event e
    LEFT JOIN event.venue v ON v.id=e.venue_id WHERE ${where}
  `);
  const total = Number(countResult.rows[0]?.total || 0);
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pageCount);
  const sortExpressions: Record<EventSortField, SQL> = {
    title: sql`lower(e.canonical_name)`,
    type: sql`lower(e.event_type)`,
    date: sql`e.start_at`,
    fandom: sql`lower(f.fandom)`,
    source: sql`sc.source_count`,
    state: sql`lower(e.status)`,
  };
  const direction = query.direction === "asc" ? sql`ASC` : sql`DESC`;
  const [rowsResult, facetsResult] = await Promise.all([
    db.execute(sql`
      SELECT e.id, e.canonical_name AS title, e.event_type AS type, e.start_at,
        e.status, e.data_origin, e.metadata, v.city, v.region,
        f.fandom, sc.source_count
      FROM event.event e
      LEFT JOIN event.venue v ON v.id=e.venue_id
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT name, ' · ' ORDER BY name) AS fandom FROM (
          SELECT linked.canonical_name AS name
          FROM event.event_entity ee JOIN core.entity linked ON linked.id=ee.entity_id
          WHERE ee.event_id=e.id AND ee.status='ACTIVE'
          UNION SELECT rs.label AS name FROM event.related_subject rs WHERE rs.event_id=e.id
        ) names
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT source_id)::int AS source_count FROM (
          SELECT a.source_id FROM ingestion.assertion a WHERE a.subject_id=e.id
          UNION SELECT rd.source_id FROM event.event_evidence ev
            JOIN ingestion.raw_document rd ON rd.id=ev.raw_document_id WHERE ev.event_id=e.id
        ) sources
      ) sc ON true
      WHERE ${where}
      ORDER BY ${sortExpressions[query.sort]} ${direction} NULLS LAST, e.id ASC
      LIMIT ${query.pageSize} OFFSET ${(page - 1) * query.pageSize}
    `),
    db.execute(sql`
      SELECT array_agg(DISTINCT event_type ORDER BY event_type) AS types,
        array_agg(DISTINCT status ORDER BY status) AS statuses FROM event.event
    `),
  ]);
  const facets = facetsResult.rows[0] as { types?: unknown; statuses?: unknown } | undefined;
  return {
    events: rowsResult.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      type: titleCase(row.type),
      date: eventDate(row.start_at),
      place: [row.city, row.region].filter(Boolean).join(", ") || "Venue pending",
      fandom: String(row.fandom || "Unlinked"),
      state: titleCase(row.status),
      source: `${Number(row.source_count || 0)} sources`,
      art: String((row.metadata as Record<string, unknown> | null)?.tone || "slate"),
      dataOrigin: String(row.data_origin) as "LIVE" | "MOCK",
    })),
    total,
    page,
    pageSize: query.pageSize,
    pageCount,
    query,
    facets: {
      types: Array.isArray(facets?.types) ? facets.types.map(String) : [],
      statuses: Array.isArray(facets?.statuses) ? facets.statuses.map(String) : [],
    },
  };
}
