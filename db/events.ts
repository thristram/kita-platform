import { sql } from "drizzle-orm";
import { getDb } from "./index";
import type { ConsoleAsset } from "./console";

export interface ConsoleEventRelation {
  entityId: string;
  name: string;
  entityType: string;
  relationType: string;
  pinned: boolean;
}

export interface ConsoleEntityOption {
  id: string;
  name: string;
  entityType: string;
}

export interface ConsoleEventSource {
  id: string;
  name: string;
  trust: string;
}

export interface ConsoleEventDetail {
  id: string;
  title: string;
  eventType: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  status: string;
  officialUrl: string;
  summary: string;
  dataOrigin: "LIVE" | "MOCK";
  tone: string;
  short: string;
  updatedAt: string;
  venue: {
    id: string;
    name: string;
    address: string;
    city: string;
    region: string;
    countryCode: string;
  } | null;
  organizer: {
    id: string;
    name: string;
  } | null;
  assets: ConsoleAsset[];
  relations: ConsoleEventRelation[];
  availableEntities: ConsoleEntityOption[];
  sources: ConsoleEventSource[];
  conflictCount: number;
  media: Array<{ id: string; url: string; role: string; category: string; selected: boolean }>;
  organizerNames: string[];
  content: {
    links: unknown[];
    facts: unknown[];
    ticketOffers: unknown[];
    exhibitors: unknown[];
    sessions: unknown[];
    guests: unknown[];
    updates: unknown[];
    activities: unknown[];
    relatedSubjects: unknown[];
  };
}

export interface EventUpdateInput {
  title: string;
  eventType: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  officialUrl: string;
  summary: string;
  venue?: { name: string; address: string; city: string; region: string; countryCode: string };
  heroMediaCandidateId?: string | null;
  organizerNames?: string[];
}

const titleCase = (value: unknown) => String(value)
  .replaceAll("_", " ")
  .toLowerCase()
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

export async function getConsoleEventDetail(id: string): Promise<ConsoleEventDetail | null> {
  const db = getDb();
  const [eventResult, assetsResult, relationsResult, entitiesResult, sourcesResult, contentResult, mediaResult] = await Promise.all([
    db.execute(sql`
      SELECT e.id, e.canonical_name, e.event_type, e.start_at, e.end_at,
        e.timezone, e.status, e.official_url, e.data_origin, e.metadata,
        e.metadata ? 'heroMediaCandidateId' AS hero_override,e.metadata->>'heroMediaCandidateId' AS hero_media_id,e.updated_at, COALESCE(e.metadata->'organizerNames',(SELECT COALESCE(c.payload->'review'->'draftBundle',c.payload->'result')->'event'->'organizerNames' FROM ingestion.candidate c WHERE c.published_event_id=e.id ORDER BY c.updated_at DESC LIMIT 1),'[]'::jsonb) AS organizer_names, v.id AS venue_id, v.name AS venue_name,
        v.address_line1, v.city, v.region, v.country_code,
        organizer.id AS organizer_id, organizer.canonical_name AS organizer_name,
        COALESCE(summary.value, '') AS summary,
        (SELECT count(*)::int FROM ingestion.resolution_conflict rc
          WHERE rc.subject_id = e.id AND rc.status = 'OPEN') AS conflict_count
      FROM event.event e
      LEFT JOIN event.venue v ON v.id = e.venue_id
      LEFT JOIN core.entity organizer ON organizer.id = e.organizer_entity_id
      LEFT JOIN LATERAL (
        SELECT value
        FROM event.event_text
        WHERE event_id = e.id AND field_type = 'SUMMARY'
        ORDER BY is_primary DESC, updated_at DESC
        LIMIT 1
      ) summary ON true
      WHERE e.id = ${id}::uuid
      LIMIT 1
    `),
    db.execute(sql`
      SELECT a.id, COALESCE(a.metadata->>'title', a.original_filename, 'Untitled asset') AS title,
        COALESCE(a.detected_category, ma.role, 'OTHER') AS category,
        a.width, a.height, COALESCE(a.origin, 'UNKNOWN') AS source,
        COALESCE(a.metadata->>'tone', 'slate') AS tone, a.data_origin
      FROM media.assignment ma
      JOIN media.asset a ON a.id = ma.asset_id
      WHERE ma.event_id = ${id}::uuid
      ORDER BY ma.is_primary_public DESC, ma.is_default_internal DESC,
        ma.priority_score DESC NULLS LAST, ma.sort_order ASC NULLS LAST
    `),
    db.execute(sql`
      SELECT linked.id AS entity_id, linked.canonical_name, linked.entity_type,
        ee.relation_type, ee.pinned
      FROM event.event_entity ee
      JOIN core.entity linked ON linked.id = ee.entity_id
      WHERE ee.event_id = ${id}::uuid AND ee.status = 'ACTIVE'
      ORDER BY linked.canonical_name
    `),
    db.execute(sql`
      SELECT id, canonical_name, entity_type
      FROM core.entity
      WHERE status = 'ACTIVE'
      ORDER BY canonical_name
      LIMIT 200
    `),
    db.execute(sql`
      SELECT DISTINCT s.id, s.name, s.trust_level
      FROM ingestion.assertion a
      JOIN ingestion.source s ON s.id = a.source_id
      WHERE a.subject_id = ${id}::uuid
      ORDER BY s.name
    `),
    db.execute(sql`
      SELECT
        COALESCE((SELECT jsonb_agg(jsonb_build_object('type',l.link_type,'url',l.url,'label',l.affiliate_metadata->>'label') ORDER BY l.link_type,l.url) FROM event.event_link l WHERE l.event_id=${id}::uuid AND l.active), '[]') AS links,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'type',f.fact_type,'label',f.label,'value',f.value_json,'unit',f.unit,'confidence',f.confidence) ORDER BY f.fact_type,f.label) FROM event.event_fact f WHERE f.event_id=${id}::uuid), '[]') AS facts,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'externalKey',t.external_key,'name',t.name,'description',t.description,'purchaseUrl',t.purchase_url,'priceText',t.price_text,'availability',t.availability,'validFrom',t.valid_from,'validThrough',t.valid_through,'confidence',t.confidence) ORDER BY t.valid_from NULLS LAST,t.name) FROM event.ticket_offer t WHERE t.event_id=${id}::uuid), '[]') AS ticket_offers,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'externalKey',x.external_key,'name',x.name,'description',x.description,'booth',x.booth,'categories',x.categories,'featured',x.featured,'websiteUrl',x.website_url,'organizationNames',x.organization_names,'logoMediaCandidateId',x.logo_media_candidate_id,'confidence',x.confidence) ORDER BY x.featured DESC,x.name) FROM event.exhibitor x WHERE x.event_id=${id}::uuid), '[]') AS exhibitors,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'externalKey',s.external_key,'title',s.title,'sessionType',s.session_type,'description',s.description,'startDate',s.start_at,'endDate',s.end_at,'timezone',s.timezone,'venueName',s.venue_name,'room',s.room,'ageRating',s.age_rating,'organizationNames',s.organization_names,'subjectTargets',s.subject_targets,'personTargets',s.person_targets,'imageMediaCandidateId',s.image_media_candidate_id,'tags',s.tags,'confidence',s.confidence) ORDER BY s.start_at NULLS LAST,s.title) FROM event.session s WHERE s.event_id=${id}::uuid), '[]') AS sessions,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'externalKey',g.external_key,'name',g.name,'description',g.description,'role',g.role,'organizationNames',g.organization_names,'personTarget',g.person_target,'subjectTargets',g.subject_targets,'imageMediaCandidateId',g.image_media_candidate_id,'confidence',g.confidence) ORDER BY g.name) FROM event.guest g WHERE g.event_id=${id}::uuid), '[]') AS guests,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',u.id,'externalKey',u.external_key,'title',u.title,'summary',u.summary,'publishedAt',u.published_at,'category',u.category,'sourceName',u.source_name,'sourceUrl',u.source_url,'imageMediaCandidateId',u.image_media_candidate_id,'confidence',u.confidence) ORDER BY u.published_at DESC NULLS LAST,u.title) FROM event.event_update u WHERE u.event_id=${id}::uuid), '[]') AS updates,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'externalKey',a.external_key,'activityType',a.activity_type,'title',a.title,'description',a.description,'startDate',a.start_at,'endDate',a.end_at,'location',a.location,'exhibitorExternalKey',a.exhibitor_external_key,'sessionExternalKey',a.session_external_key,'organizationNames',a.organization_names,'subjectTargets',a.subject_targets,'personTargets',a.person_targets,'mediaCandidateIds',a.media_candidate_ids,'confidence',a.confidence) ORDER BY a.start_at NULLS LAST,a.title) FROM event.activity a WHERE a.event_id=${id}::uuid), '[]') AS activities,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('canonicalKey',r.canonical_key,'provider',r.provider,'entityType',r.entity_type,'rawId',r.raw_id,'encodedId',r.encoded_id,'label',r.label,'description',r.description,'featured',r.featured,'confidence',r.confidence) ORDER BY r.featured DESC,r.label) FROM event.related_subject r WHERE r.event_id=${id}::uuid), '[]') AS related_subjects
    `),
    db.execute(sql`
      WITH choices AS (
        SELECT item->>'mediaCandidateId' AS id,item->>'role' AS role
        FROM ingestion.candidate c CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(COALESCE(c.payload->'review'->'draftBundle',c.payload->'result')->'media','[]'::jsonb)
        ) item WHERE c.published_event_id=${id}::uuid
      )
      SELECT DISTINCT mc.id,mc.resolved_url,mc.category,(choices.id IS NOT NULL) AS selected,COALESCE(choices.role,'OTHER') AS role
      FROM ingestion.media_candidate mc LEFT JOIN choices ON choices.id=mc.id::text
      WHERE mc.root_event_id=${id}::uuid
      ORDER BY mc.id
    `),
  ]);

  const row = eventResult.rows[0];
  if (!row) return null;
  const metadata = (row.metadata || {}) as Record<string, unknown>;
  const content = contentResult.rows[0] || {};

  return {
    id: String(row.id),
    title: String(row.canonical_name),
    eventType: String(row.event_type),
    startAt: row.start_at ? new Date(String(row.start_at)).toISOString() : null,
    endAt: row.end_at ? new Date(String(row.end_at)).toISOString() : null,
    timezone: String(row.timezone || "UTC"),
    status: String(row.status),
    officialUrl: String(row.official_url || ""),
    summary: String(row.summary || ""),
    dataOrigin: String(row.data_origin) as "LIVE" | "MOCK",
    tone: String(metadata.tone || "slate"),
    short: String(metadata.short || String(row.canonical_name).slice(0, 2).toUpperCase()),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    venue: row.venue_id ? {
      id: String(row.venue_id),
      name: String(row.venue_name),
      address: String(row.address_line1 || ""),
      city: String(row.city || ""),
      region: String(row.region || ""),
      countryCode: String(row.country_code || ""),
    } : null,
    organizer: row.organizer_id ? {
      id: String(row.organizer_id),
      name: String(row.organizer_name),
    } : null,
    assets: assetsResult.rows.map((asset) => ({
      id: String(asset.id),
      title: String(asset.title),
      category: String(asset.category),
      dimensions: asset.width && asset.height ? `${asset.width} × ${asset.height}` : "Dimensions pending",
      source: String(asset.source).replaceAll("_", " "),
      art: String(asset.tone),
      dataOrigin: String(asset.data_origin) as "LIVE" | "MOCK",
    })),
    relations: relationsResult.rows.map((relation) => ({
      entityId: String(relation.entity_id),
      name: String(relation.canonical_name),
      entityType: titleCase(relation.entity_type),
      relationType: String(relation.relation_type),
      pinned: Boolean(relation.pinned),
    })),
    availableEntities: entitiesResult.rows.map((entity) => ({
      id: String(entity.id),
      name: String(entity.canonical_name),
      entityType: titleCase(entity.entity_type),
    })),
    sources: sourcesResult.rows.map((source) => ({
      id: String(source.id),
      name: String(source.name),
      trust: titleCase(source.trust_level),
    })),
    conflictCount: Number(row.conflict_count || 0),
    organizerNames: (row.organizer_names || []) as string[],
    media: mediaResult.rows.map((m) => ({ id: String(m.id), url: String(m.resolved_url || ""), role: row.hero_override ? (String(m.id) === row.hero_media_id ? "EVENT_HERO" : ["EVENT_HERO","EVENT_POSTER"].includes(String(m.role)) ? "OTHER" : String(m.role)) : String(m.role || ""), category: String(m.category || ""), selected: Boolean(m.selected) })),
    content: {
      links: (content.links || []) as unknown[],
      facts: (content.facts || []) as unknown[],
      ticketOffers: (content.ticket_offers || []) as unknown[],
      exhibitors: (content.exhibitors || []) as unknown[],
      sessions: (content.sessions || []) as unknown[],
      guests: (content.guests || []) as unknown[],
      updates: (content.updates || []) as unknown[],
      activities: (content.activities || []) as unknown[],
      relatedSubjects: (content.related_subjects || []) as unknown[],
    },
  };
}

async function syncServingProjection(id: string, status: string): Promise<void> {
  const db = getDb();
  if (status !== "PUBLISHED") {
    await db.execute(sql`
      UPDATE serving.event_listing
      SET status = ${status}, updated_at = now(), projection_version = projection_version + 1
      WHERE event_id = ${id}::uuid
    `);
    return;
  }

  await db.execute(sql`
    INSERT INTO serving.event_listing(
      event_id, slug, status, event_type, title, start_at, end_at, timezone,
      city, region, country, primary_image_url, primary_fandom_ids,
      popularity_score, canonical_version, projection_version, data_origin, updated_at
    )
    SELECT e.id,
      COALESCE(existing.slug,
        trim(both '-' from regexp_replace(lower(e.canonical_name), '[^a-z0-9]+', '-', 'g')) || '-' || left(e.id::text, 8)),
      'PUBLISHED', e.event_type, e.canonical_name, e.start_at, e.end_at, e.timezone,
      v.city, v.region, v.country_code, existing.primary_image_url,
      COALESCE((SELECT array_agg(ee.entity_id ORDER BY ee.entity_id)
        FROM event.event_entity ee WHERE ee.event_id=e.id AND ee.status='ACTIVE'), '{}'),
      COALESCE(e.importance_score::double precision, 0),
      COALESCE(existing.canonical_version, 0) + 1,
      COALESCE(existing.projection_version, 0) + 1,
      e.data_origin, now()
    FROM event.event e
    LEFT JOIN event.venue v ON v.id=e.venue_id
    LEFT JOIN serving.event_listing existing ON existing.event_id=e.id
    WHERE e.id=${id}::uuid
    ON CONFLICT (event_id) DO UPDATE SET
      status='PUBLISHED', event_type=EXCLUDED.event_type, title=EXCLUDED.title,
      start_at=EXCLUDED.start_at, end_at=EXCLUDED.end_at, timezone=EXCLUDED.timezone,
      city=EXCLUDED.city, region=EXCLUDED.region, country=EXCLUDED.country,
      primary_fandom_ids=EXCLUDED.primary_fandom_ids,
      canonical_version=EXCLUDED.canonical_version,
      projection_version=EXCLUDED.projection_version,
      data_origin=EXCLUDED.data_origin, updated_at=now()
  `);
}

export async function updateConsoleEvent(id: string, input: EventUpdateInput): Promise<void> {
  const db = getDb();
  if (input.heroMediaCandidateId) {
    const media = await db.execute(sql`SELECT id FROM ingestion.media_candidate WHERE id=${input.heroMediaCandidateId}::uuid AND root_event_id=${id}::uuid`);
    if (!media.rows.length) throw new Error("Choose a cover attached to this event");
  }
  if (input.venue) {
    const v = input.venue;
    await db.execute(sql`
      WITH current_event AS (SELECT venue_id FROM event.event WHERE id=${id}::uuid),
      matching AS (SELECT v.id FROM event.venue v WHERE v.name=${v.name} AND COALESCE(v.address_line1,'')=${v.address}
        AND COALESCE(v.city,'')=${v.city} AND COALESCE(v.region,'')=${v.region} AND COALESCE(v.country_code,'')=${v.countryCode} LIMIT 1),
      inserted AS (INSERT INTO event.venue(name,address_line1,city,region,country_code,timezone,data_origin)
        SELECT ${v.name},${v.address},${v.city},${v.region},${v.countryCode},${input.timezone},'LIVE'
        FROM current_event WHERE ${v.name}<>'' AND NOT EXISTS(SELECT 1 FROM matching) RETURNING id)
      UPDATE event.event SET venue_id=COALESCE((SELECT id FROM matching),(SELECT id FROM inserted)) WHERE id=${id}::uuid
    `);
  }
  await db.execute(sql`
    UPDATE event.event
    SET canonical_name=${input.title}, event_type=${input.eventType},
      start_at=${input.startAt}::timestamptz, end_at=${input.endAt}::timestamptz,
      timezone=${input.timezone}, official_url=${input.officialUrl || null},
      metadata=CASE WHEN ${input.heroMediaCandidateId !== undefined} THEN metadata || jsonb_build_object('heroMediaCandidateId',${input.heroMediaCandidateId ?? null}::text) ELSE metadata END
        || CASE WHEN ${input.organizerNames !== undefined} THEN jsonb_build_object('organizerNames',${JSON.stringify(input.organizerNames ?? [])}::jsonb) ELSE '{}'::jsonb END,
      updated_at=now()
    WHERE id=${id}::uuid
  `);

  const summaryResult = await db.execute(sql`
    UPDATE event.event_text
    SET value=${input.summary}, updated_at=now(), is_primary=true
    WHERE id=(
      SELECT id FROM event.event_text
      WHERE event_id=${id}::uuid AND field_type='SUMMARY'
      ORDER BY is_primary DESC, updated_at DESC LIMIT 1
    )
    RETURNING id
  `);
  if (!summaryResult.rows.length && input.summary) {
    await db.execute(sql`
      INSERT INTO event.event_text(event_id,locale,field_type,value,provider,confidence,is_primary)
      VALUES(${id}::uuid,'en','SUMMARY',${input.summary},'MANUAL',1,true)
    `);
  }

  const current = await db.execute(sql`SELECT status FROM event.event WHERE id=${id}::uuid`);
  if (current.rows[0]) await syncServingProjection(id, String(current.rows[0].status));
}

export async function setConsoleEventStatus(id: string, status: "PUBLISHED" | "DRAFT"): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE event.event SET status=${status}, updated_at=now() WHERE id=${id}::uuid
  `);
  await syncServingProjection(id, status);
}

export async function addConsoleEventRelation(id: string, entityId: string, relationType: string): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO event.event_entity(event_id,entity_id,relation_type,origin,confidence,pinned,status,updated_at)
    VALUES(${id}::uuid,${entityId}::uuid,${relationType},'MANUAL',1,true,'ACTIVE',now())
    ON CONFLICT(event_id,entity_id,relation_type) DO UPDATE
      SET status='ACTIVE', origin='MANUAL', pinned=true, updated_at=now()
  `);
}

export async function removeConsoleEventRelation(id: string, entityId: string, relationType: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE event.event_entity SET status='REMOVED', updated_at=now()
    WHERE event_id=${id}::uuid AND entity_id=${entityId}::uuid AND relation_type=${relationType}
  `);
}
