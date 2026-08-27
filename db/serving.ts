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
  dataOrigin: "LIVE" | "MOCK";
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
      ,data_origin AS "dataOrigin"
    FROM serving.event_listing
    WHERE status = 'PUBLISHED'
      AND (start_at IS NULL OR start_at >= now())
      AND (
        data_origin <> 'MOCK'
        OR COALESCE((
          SELECT (value #>> '{}')::boolean
          FROM system.runtime_setting
          WHERE key = 'consumer_show_mock_data'
        ), false)
      )
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${safeLimit}
  `);
  return result.rows as unknown as PublishedEventRow[];
}

export async function getConsumerMockDataVisibility(): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT COALESCE((value #>> '{}')::boolean, false) AS enabled
    FROM system.runtime_setting
    WHERE key='consumer_show_mock_data'
  `);
  return Boolean(result.rows[0]?.enabled);
}

export async function setConsumerMockDataVisibility(enabled: boolean): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO system.runtime_setting(key,value,description,updated_at)
    VALUES ('consumer_show_mock_data', ${JSON.stringify(enabled)}::jsonb,
      'Include records tagged MOCK in consumer-facing queries', now())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
  `);
}
