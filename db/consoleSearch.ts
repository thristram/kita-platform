import { sql } from "drizzle-orm";
import { getDb } from "./index";

export type ConsoleSearchResult = {
  kind: "event" | "candidate" | "entity" | "source";
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

const text = (value: unknown): string => String(value ?? "");

export async function searchConsole(query: string): Promise<ConsoleSearchResult[]> {
  const term = query.trim().slice(0, 160);
  if (term.length < 2) return [];

  const db = getDb();
  const [events, candidates, entities, sources] = await Promise.all([
    db.execute(sql`
      SELECT id, canonical_name, event_type, status
      FROM event.event
      WHERE position(lower(${term}) in lower(canonical_name)) > 0
         OR position(lower(${term}) in lower(id::text)) > 0
      ORDER BY CASE WHEN lower(canonical_name) = lower(${term}) THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 8
    `),
    db.execute(sql`
      SELECT c.id, c.status,
        COALESCE(c.payload#>>'{review,draftBundle,event,name}', c.payload#>>'{result,event,name}', rd.title, c.id::text) AS title
      FROM ingestion.candidate c
      LEFT JOIN ingestion.raw_document rd ON rd.id = c.raw_document_id
      WHERE c.candidate_type = 'EVENT_RESOLUTION'
        AND COALESCE(c.payload#>>'{review,draftBundle,schemaVersion}', c.payload#>>'{result,schemaVersion}') = 'event-content-bundle/v2'
        AND (position(lower(${term}) in lower(COALESCE(c.payload#>>'{review,draftBundle,event,name}', c.payload#>>'{result,event,name}', rd.title, ''))) > 0
          OR position(lower(${term}) in lower(c.id::text)) > 0)
      ORDER BY c.created_at DESC
      LIMIT 6
    `),
    db.execute(sql`
      SELECT id, canonical_name, entity_type
      FROM core.entity
      WHERE status = 'ACTIVE' AND position(lower(${term}) in lower(canonical_name)) > 0
      ORDER BY canonical_name
      LIMIT 6
    `),
    db.execute(sql`
      SELECT id, name, base_url
      FROM ingestion.source
      WHERE position(lower(${term}) in lower(name)) > 0
         OR position(lower(${term}) in lower(COALESCE(base_url, ''))) > 0
      ORDER BY name
      LIMIT 6
    `),
  ]);

  return [
    ...events.rows.map((row): ConsoleSearchResult => {
      const id = text(row.id);
      return { kind: "event", id, title: text(row.canonical_name), subtitle: `${text(row.event_type).replaceAll("_", " ")} · ${text(row.status)} · ${id.slice(0, 8)}`, href: `/events/${id}` };
    }),
    ...candidates.rows.map((row): ConsoleSearchResult => {
      const id = text(row.id);
      return { kind: "candidate", id, title: text(row.title), subtitle: `${text(row.status)} · ${id.slice(0, 8)}`, href: `/candidates/${id}/overview` };
    }),
    ...entities.rows.map((row): ConsoleSearchResult => {
      const title = text(row.canonical_name);
      return { kind: "entity", id: text(row.id), title, subtitle: `${text(row.entity_type).replaceAll("_", " ")} · Related events`, href: `/events?q=${encodeURIComponent(title)}` };
    }),
    ...sources.rows.map((row): ConsoleSearchResult => {
      const title = text(row.name);
      return { kind: "source", id: text(row.id), title, subtitle: text(row.base_url) || "Crawler source", href: `/sources?q=${encodeURIComponent(title)}` };
    }),
  ];
}
