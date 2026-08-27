import { sql } from "drizzle-orm";
import { getDb } from "./index";

export interface PublishedEventRow {
  eventId: string;
  slug: string;
  eventType: string;
  title: string;
  startAt: Date | null;
  city: string | null;
  region: string | null;
  primaryImageUrl: string | null;
}

export async function listPublishedEvents(limit = 24): Promise<PublishedEventRow[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const result = await getDb().execute(sql`
    SELECT
      event_id AS "eventId",
      slug,
      event_type AS "eventType",
      title,
      start_at AS "startAt",
      city,
      region,
      primary_image_url AS "primaryImageUrl"
    FROM serving.event_listing
    WHERE status = 'PUBLISHED'
      AND (start_at IS NULL OR start_at >= now())
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${safeLimit}
  `);
  return result.rows as unknown as PublishedEventRow[];
}
