import { sql } from "drizzle-orm";
import { eventBundleSchema, type EventBundle } from "@kita/contracts";
import { getDb } from "./index";

export type CandidateStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface CandidateAssertion {
  id: string;
  fieldPath: string;
  value: unknown;
  normalizedValue: unknown;
  confidence: number;
  locator: string;
  excerpt: string;
}

export interface CandidateEventDraft {
  title: string;
  eventType: string;
  startAt: string;
  endAt: string;
  timezone: string;
  officialUrl: string;
  summary: string;
  venueName: string;
  addressLine1: string;
  city: string;
  region: string;
  countryCode: string;
  postalCode: string;
}

export interface ReviewCandidateSummary {
  id: string;
  candidateType: string;
  status: string;
  confidence: number;
  createdAt: string;
  publishedEventId: string | null;
  sourceName: string;
  sourceTrust: string;
  documentTitle: string;
  canonicalUrl: string;
  pageType: string;
  proposedTitle: string;
  proposedStartAt: string;
  proposedLocation: string;
  processingMode: "LLM_KB" | "DETERMINISTIC_FALLBACK" | "DETERMINISTIC_ONLY" | "MANUAL" | "MANUAL_JSON";
}

export interface CandidateReviewFailure {
  action: "MATERIALIZE" | "LINK" | "REJECT";
  errorCode: string;
  errorId: string;
  message: string;
  occurredAt: string;
}

export interface CandidateProcessingInfo {
  mode: ReviewCandidateSummary["processingMode"];
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  warnings: string[];
  jobId: string | null;
  crawlRunId: string | null;
  documentCount: number;
  lastReviewFailure: CandidateReviewFailure | null;
}

export interface ReviewCandidateDetail extends ReviewCandidateSummary {
  rawDocumentId: string;
  payload: unknown;
  assertions: CandidateAssertion[];
  chunks: Array<{ id: string; index: number; heading: string; content: string }>;
  media: Array<{ id: string; url: string; category: string; score: number; width: number | null; height: number | null }>;
  draft: CandidateEventDraft;
  existingEvents: Array<{ id: string; title: string; startAt: string | null; status: string }>;
  processing: CandidateProcessingInfo;
  bundle: EventBundle;
  draftRevision: number;
  draftSavedAt: string | null;
}

export interface ReviewResolutionStatus {
  jobId: string;
  crawlRunId: string;
  sourceName: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  documentCount: number;
  candidateId: string | null;
  lastError: string;
}

export type MaterializeCandidateInput = CandidateEventDraft;

const iso = (value: unknown): string => value ? new Date(String(value)).toISOString() : "";
const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && "name" in (value as Record<string, unknown>)) return String((value as Record<string, unknown>).name || "");
  return "";
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const nullableNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const processingMode = (provider: string, warnings: string[], imported = false, manual = false): ReviewCandidateSummary["processingMode"] => {
  if (imported) return "MANUAL_JSON";
  if (manual) return "MANUAL";
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider && normalizedProvider !== "deterministic" && normalizedProvider !== "unknown") return "LLM_KB";
  return warnings.some((warning) => /knowledge service|deterministic fallback/i.test(warning)) ? "DETERMINISTIC_FALLBACK" : "DETERMINISTIC_ONLY";
};
const draftEventType = (value: string): string => value === "POPUP" ? "POP_UP" : value;

function processingFromPayload(payload: unknown, row: Record<string, unknown>): CandidateProcessingInfo {
  const completion = record(payload);
  const model = record(completion.model);
  const metrics = record(completion.metrics);
  const result = record(completion.result);
  const review = record(completion.review);
  const failure = record(review.lastFailure);
  const warnings = stringArray(result.warnings);
  const modelProvider = scalar(model.provider) || "unknown";
  const hasFailure = Boolean(failure.errorCode && failure.errorId && failure.occurredAt);
  return {
    mode: processingMode(modelProvider, warnings, Boolean(review.importedAt), Boolean(review.createdManually)),
    modelProvider,
    modelName: scalar(model.name) || "unknown",
    promptVersion: scalar(model.promptVersion) || "unknown",
    inputTokens: nullableNumber(metrics.inputTokens),
    outputTokens: nullableNumber(metrics.outputTokens),
    durationMs: nullableNumber(metrics.durationMs),
    warnings,
    jobId: row.job_id ? String(row.job_id) : null,
    crawlRunId: row.crawl_run_id ? String(row.crawl_run_id) : review.crawlRunId ? String(review.crawlRunId) : null,
    documentCount: Number(row.document_count || 0),
    lastReviewFailure: hasFailure ? {
      action: scalar(failure.action) as CandidateReviewFailure["action"],
      errorCode: scalar(failure.errorCode),
      errorId: scalar(failure.errorId),
      message: scalar(failure.message),
      occurredAt: iso(failure.occurredAt),
    } : null,
  };
}

const assertionValue = (assertions: CandidateAssertion[], field: string): unknown =>
  assertions.find((item) => item.fieldPath === field)?.normalizedValue ??
  assertions.find((item) => item.fieldPath === field)?.value;

const mapAssertions = (rows: Record<string, unknown>[]): CandidateAssertion[] => rows.map((row) => ({
  id: String(row.id),
  fieldPath: String(row.field_path),
  value: row.value_json,
  normalizedValue: row.normalized_value_json,
  confidence: Number(row.confidence || 0),
  locator: String(row.evidence_locator || ""),
  excerpt: String(row.evidence_excerpt || ""),
}));

function locationDraft(value: unknown) {
  if (!value || typeof value !== "object") {
    return { venueName: scalar(value), addressLine1: "", city: "", region: "", countryCode: "", postalCode: "" };
  }
  const location = value as Record<string, unknown>;
  const address = location.address && typeof location.address === "object" ? location.address as Record<string, unknown> : {};
  const country = address.addressCountry;
  const countryCode = typeof country === "object" && country ? scalar((country as Record<string, unknown>).name) : scalar(country);
  return {
    venueName: scalar(location.name),
    addressLine1: scalar(address.streetAddress),
    city: scalar(address.addressLocality),
    region: scalar(address.addressRegion),
    countryCode,
    postalCode: scalar(address.postalCode),
  };
}

function inferredTimezone(sourceTimezone: string, location: ReturnType<typeof locationDraft>): string {
  if (sourceTimezone && sourceTimezone !== "UTC") return sourceTimezone;
  if (location.countryCode.toUpperCase() !== "US") return sourceTimezone || "UTC";
  const pacific = new Set(["CA", "WA", "OR", "NV"]);
  const mountain = new Set(["AZ", "CO", "ID", "MT", "NM", "UT", "WY"]);
  const central = new Set(["AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI"]);
  const region = location.region.toUpperCase();
  if (pacific.has(region)) return "America/Los_Angeles";
  if (mountain.has(region)) return region === "AZ" ? "America/Phoenix" : "America/Denver";
  if (central.has(region)) return "America/Chicago";
  return region ? "America/New_York" : sourceTimezone || "UTC";
}

export async function listReviewCandidates(status: CandidateStatus = "PENDING", limit = 100): Promise<ReviewCandidateSummary[]> {
  const result = await getDb().execute(sql`
    SELECT c.id,c.candidate_type,c.status,c.confidence,c.created_at,c.published_event_id,
      rd.title AS document_title,rd.canonical_url,rd.page_type,s.name AS source_name,s.trust_level,
      c.payload#>>'{model,provider}' AS model_provider,c.payload#>'{result,warnings}' AS warnings,
      c.payload#>>'{review,importedAt}' AS imported_at,c.payload#>>'{review,createdManually}' AS created_manually,
      COALESCE(to_jsonb(c.payload#>>'{review,draftBundle,event,name}'),to_jsonb(c.payload#>>'{result,event,name}'),title.value_json) AS proposed_title,
      COALESCE(to_jsonb(c.payload#>>'{review,draftBundle,event,startDate}'),to_jsonb(c.payload#>>'{result,event,startDate}'),start_date.value_json) AS proposed_start_at,
      location.value_json AS proposed_location
    FROM ingestion.candidate c
    LEFT JOIN ingestion.raw_document rd ON rd.id=c.raw_document_id
    LEFT JOIN ingestion.source s ON s.id=rd.source_id
    LEFT JOIN LATERAL (SELECT value_json FROM ingestion.assertion WHERE raw_document_id=c.raw_document_id AND field_path='title' ORDER BY confidence DESC NULLS LAST LIMIT 1) title ON true
    LEFT JOIN LATERAL (SELECT value_json FROM ingestion.assertion WHERE raw_document_id=c.raw_document_id AND field_path='start_at' ORDER BY confidence DESC NULLS LAST LIMIT 1) start_date ON true
    LEFT JOIN LATERAL (SELECT value_json FROM ingestion.assertion WHERE raw_document_id=c.raw_document_id AND field_path IN ('location','venue') ORDER BY CASE WHEN field_path='location' THEN 0 ELSE 1 END,confidence DESC NULLS LAST LIMIT 1) location ON true
    WHERE c.status=${status} AND c.candidate_type='EVENT_RESOLUTION'
      AND (c.status<>'PENDING' OR c.published_event_id IS NULL)
    ORDER BY (title.value_json IS NOT NULL) DESC,c.confidence DESC NULLS LAST,c.created_at DESC
    LIMIT ${Math.max(1, Math.min(limit, 250))}
  `);
  return result.rows.map((row) => ({
    id: String(row.id), candidateType: String(row.candidate_type), status: String(row.status),
    confidence: Number(row.confidence || 0), createdAt: iso(row.created_at),
    publishedEventId: row.published_event_id ? String(row.published_event_id) : null,
    sourceName: String(row.source_name || "Unknown source"), sourceTrust: String(row.trust_level || "UNKNOWN"),
    documentTitle: String(row.document_title || "Untitled document"), canonicalUrl: String(row.canonical_url || ""),
    pageType: String(row.page_type || "OTHER"), proposedTitle: scalar(row.proposed_title) || String(row.document_title || ""),
    proposedStartAt: scalar(row.proposed_start_at), proposedLocation: scalar(row.proposed_location),
    processingMode: processingMode(String(row.model_provider || "unknown"), stringArray(row.warnings), Boolean(row.imported_at), row.created_manually === true || row.created_manually === "true"),
  }));
}

export async function getLatestResolutionStatus(): Promise<ReviewResolutionStatus | null> {
  const result = await getDb().execute(sql`
    SELECT j.id,j.crawl_run_id,s.name AS source_name,j.status,j.created_at,j.started_at,j.completed_at,
      COALESCE((j.payload->>'documentCount')::int,(SELECT count(*)::int FROM ingestion.raw_document d WHERE d.crawl_run_id=j.crawl_run_id)) AS document_count,
      c.id AS candidate_id,COALESCE(j.last_error_message_redacted,j.last_error,'') AS last_error
    FROM ingestion.job j
    JOIN ingestion.source s ON s.id=j.source_id
    LEFT JOIN ingestion.candidate c ON c.job_id=j.id
    WHERE j.job_type='EVENT_RESOLUTION'
    ORDER BY j.created_at DESC LIMIT 1
  `);
  const row = result.rows[0];
  return row ? {
    jobId: String(row.id), crawlRunId: String(row.crawl_run_id), sourceName: String(row.source_name), status: String(row.status),
    createdAt: iso(row.created_at), startedAt: row.started_at ? iso(row.started_at) : null,
    completedAt: row.completed_at ? iso(row.completed_at) : null, documentCount: Number(row.document_count || 0),
    candidateId: row.candidate_id ? String(row.candidate_id) : null, lastError: String(row.last_error || ""),
  } : null;
}

export async function getReviewCandidate(id: string): Promise<ReviewCandidateDetail | null> {
  const db = getDb();
  const [candidateResult, assertionResult, chunkResult, mediaResult, eventResult] = await Promise.all([
    db.execute(sql`
      SELECT c.id,c.candidate_type,c.status,c.confidence,c.created_at,c.published_event_id,c.payload,c.job_id,j.crawl_run_id,
        COALESCE((SELECT count(*)::int FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=c.id),CASE WHEN c.raw_document_id IS NULL THEN 0 ELSE 1 END) AS document_count,
        rd.id AS raw_document_id,rd.title AS document_title,rd.canonical_url,rd.page_type,
        s.name AS source_name,s.trust_level,s.timezone,s.base_url
      FROM ingestion.candidate c
      LEFT JOIN ingestion.job j ON j.id=c.job_id
      LEFT JOIN ingestion.raw_document rd ON rd.id=c.raw_document_id
      LEFT JOIN ingestion.source s ON s.id=rd.source_id
      WHERE c.id=${id}::uuid LIMIT 1
    `),
    db.execute(sql`SELECT id,field_path,value_json,normalized_value_json,confidence,evidence_locator,evidence_excerpt FROM ingestion.assertion WHERE raw_document_id IN (SELECT raw_document_id FROM ingestion.candidate_evidence WHERE candidate_id=${id}::uuid UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${id}::uuid) ORDER BY field_path,confidence DESC NULLS LAST`),
    db.execute(sql`SELECT id,chunk_index,heading_path,content FROM ingestion.document_chunk WHERE raw_document_id IN (SELECT raw_document_id FROM ingestion.candidate_evidence WHERE candidate_id=${id}::uuid UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${id}::uuid) ORDER BY raw_document_id,chunk_index LIMIT 100`),
    db.execute(sql`SELECT id,resolved_url,category,classification_score,width,height FROM ingestion.media_candidate WHERE raw_document_id IN (SELECT raw_document_id FROM ingestion.candidate_evidence WHERE candidate_id=${id}::uuid UNION SELECT raw_document_id FROM ingestion.candidate WHERE id=${id}::uuid) ORDER BY classification_score DESC LIMIT 48`),
    db.execute(sql`SELECT id,canonical_name,start_at,status FROM event.event ORDER BY updated_at DESC LIMIT 100`),
  ]);
  const row = candidateResult.rows[0];
  if (!row) return null;
  const assertions = mapAssertions(assertionResult.rows as Record<string, unknown>[]);
  const completionPayload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  const reviewPayload = record(completionPayload.review);
  const bundleResult = eventBundleSchema.safeParse(reviewPayload.draftBundle ?? completionPayload.result);
  const bundleEvent = bundleResult.success ? bundleResult.data.event : null;
  const location = bundleEvent ? {
    venueName: bundleEvent.venue.name,addressLine1: bundleEvent.venue.addressLine1,city: bundleEvent.venue.city,
    region: bundleEvent.venue.region,countryCode: bundleEvent.venue.countryCode,postalCode: bundleEvent.venue.postalCode,
  } : locationDraft(assertionValue(assertions, "location") ?? assertionValue(assertions, "venue"));
  const summary = bundleEvent?.description || scalar(assertionValue(assertions, "description"));
  const title = bundleEvent?.name || scalar(assertionValue(assertions, "title")) || String(row.document_title || "");
  const timezone = bundleEvent?.timezone || inferredTimezone(String(row.timezone || "UTC"), location);
  const draft: CandidateEventDraft = {
    title, eventType: draftEventType(bundleEvent?.eventType || "CONVENTION"), startAt: bundleEvent?.startDate || scalar(assertionValue(assertions, "start_at")),
    endAt: bundleEvent?.endDate || scalar(assertionValue(assertions, "end_at")), timezone,
    officialUrl: bundleEvent?.officialUrl || scalar(assertionValue(assertions, "official_url")) || String(row.base_url || row.canonical_url || ""),
    summary, ...location,
  };
  if (!bundleResult.success) return null;
  return {
    id: String(row.id), candidateType: String(row.candidate_type), status: String(row.status),
    confidence: Number(row.confidence || 0), createdAt: iso(row.created_at),
    publishedEventId: row.published_event_id ? String(row.published_event_id) : null,
    sourceName: String(row.source_name || "Unknown source"), sourceTrust: String(row.trust_level || "UNKNOWN"),
    documentTitle: String(row.document_title || "Untitled document"), canonicalUrl: String(row.canonical_url || ""),
    pageType: String(row.page_type || "OTHER"), proposedTitle: title,
    proposedStartAt: draft.startAt, proposedLocation: draft.venueName,
    processingMode: processingFromPayload(row.payload, row as Record<string, unknown>).mode,
    rawDocumentId: String(row.raw_document_id), payload: row.payload, assertions, draft,
    chunks: chunkResult.rows.map((item) => ({ id: String(item.id), index: Number(item.chunk_index), heading: String(item.heading_path || ""), content: String(item.content) })),
    media: mediaResult.rows.map((item) => ({ id: String(item.id), url: String(item.resolved_url), category: String(item.category), score: Number(item.classification_score || 0), width: item.width === null ? null : Number(item.width), height: item.height === null ? null : Number(item.height) })),
    existingEvents: eventResult.rows.map((item) => ({ id: String(item.id), title: String(item.canonical_name), startAt: item.start_at ? iso(item.start_at) : null, status: String(item.status) })),
    processing: processingFromPayload(row.payload, row as Record<string, unknown>),
    bundle: bundleResult.data,
    draftRevision: Number(reviewPayload.draftRevision || 0),
    draftSavedAt: reviewPayload.draftSavedAt ? iso(reviewPayload.draftSavedAt) : null,
  };
}

export async function saveCandidateDraft(id: string, input: unknown): Promise<{ bundle: EventBundle; revision: number; savedAt: string }> {
  const bundle = eventBundleSchema.parse(input);
  const savedAt = new Date().toISOString();
  const result = await getDb().execute(sql`
    UPDATE ingestion.candidate
    SET payload=jsonb_set(
      payload,
      '{review}',
      COALESCE(payload->'review','{}'::jsonb) || jsonb_build_object(
        'draftBundle',${JSON.stringify(bundle)}::jsonb,
        'draftRevision',COALESCE((payload#>>'{review,draftRevision}')::int,0)+1,
        'draftSavedAt',${savedAt}::text
      ),
      true
    ),updated_at=now()
    WHERE id=${id}::uuid AND status='PENDING' AND published_event_id IS NULL
    RETURNING (payload#>>'{review,draftRevision}')::int AS revision
  `);
  if (!result.rows[0]) {
    const current = await currentCandidateEvent(id);
    if (!current) throw new Error("CANDIDATE_NOT_FOUND");
    throw new Error("CANDIDATE_NOT_PENDING");
  }
  return { bundle, revision: Number(result.rows[0].revision || 1), savedAt };
}

export async function enqueueCandidateResolutionRetry(id: string): Promise<{ jobId: string; crawlRunId: string; status: string }> {
  const result = await getDb().execute(sql`
    WITH candidate_scope AS (
      SELECT c.id,c.status,j.crawl_run_id,j.source_id,r.root_event_id,
        (SELECT count(*)::int FROM ingestion.raw_document d WHERE d.crawl_run_id=j.crawl_run_id) AS document_count
      FROM ingestion.candidate c
      JOIN ingestion.job j ON j.id=c.job_id
      JOIN ingestion.crawl_run r ON r.id=j.crawl_run_id
      WHERE c.id=${id}::uuid AND c.status='PENDING' AND c.published_event_id IS NULL
    ), inserted AS (
      INSERT INTO ingestion.job(job_type,required_capability,status,priority,dedupe_key,payload,source_id,crawl_run_id,available_at,not_before,max_attempts)
      SELECT 'EVENT_RESOLUTION','EVENT_RESOLUTION_V1','QUEUED','HIGH',
        'event-resolution:manual-llm:' || id::text || ':' || ${crypto.randomUUID()},
        jsonb_build_object('crawlRunId',crawl_run_id,'sourceId',source_id,'knownEventId',root_event_id,'documentCount',document_count,'resolutionMode','LLM_REQUIRED','retryOfCandidateId',id),
        source_id,crawl_run_id,now(),now(),4
      FROM candidate_scope
      RETURNING id,crawl_run_id,status
    ) SELECT * FROM inserted
  `);
  const row = result.rows[0];
  if (!row) throw new Error("CANDIDATE_NOT_PENDING");
  return { jobId: String(row.id), crawlRunId: String(row.crawl_run_id), status: String(row.status) };
}

export async function recordCandidateReviewFailure(id: string, failure: CandidateReviewFailure): Promise<void> {
  await getDb().execute(sql`
    UPDATE ingestion.candidate
    SET payload=jsonb_set(
      payload,
      '{review}',
      COALESCE(payload->'review','{}'::jsonb) || jsonb_build_object('lastFailure',${JSON.stringify(failure)}::jsonb),
      true
    ),updated_at=now()
    WHERE id=${id}::uuid
  `);
}

export async function clearCandidateReviewFailure(id: string): Promise<void> {
  await getDb().execute(sql`UPDATE ingestion.candidate SET payload=payload#-'{review,lastFailure}',updated_at=now() WHERE id=${id}::uuid`);
}

async function currentCandidateEvent(id: string): Promise<{ status: string; eventId: string | null } | null> {
  const result = await getDb().execute(sql`SELECT status,published_event_id FROM ingestion.candidate WHERE id=${id}::uuid`);
  const row = result.rows[0];
  return row ? { status: String(row.status), eventId: row.published_event_id ? String(row.published_event_id) : null } : null;
}

async function materializeEventContent(candidateId: string, eventId: string): Promise<void> {
  const candidate = await getDb().execute(sql`SELECT payload FROM ingestion.candidate WHERE id=${candidateId}::uuid`);
  const payload = candidate.rows[0]?.payload;
  const completion = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const review = record(completion.review);
  const parsed = eventBundleSchema.safeParse(review.draftBundle ?? completion.result);
  if (!parsed.success) return;
  const bundle = parsed.data;
  const db = getDb();
  const links = bundle.links.map((item) => ({ link_type: item.type, provider: "RESOLUTION_AGENT", url: item.url, label: item.label, source_document_ids: item.sourceDocumentIds, confidence: item.confidence }));
  const facts = bundle.facts.map((item) => ({ fact_type: item.type, label: item.label, value_json: item.value, unit: item.unit, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));
  const tickets = bundle.ticketOffers.map((item) => ({ external_key: item.externalKey, name: item.name, description: item.description, purchase_url: item.purchaseUrl, price_text: item.priceText, availability: item.availability, valid_from: item.validFrom, valid_through: item.validThrough, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));
  const exhibitors = bundle.exhibitors.map((item) => ({ external_key: item.externalKey, name: item.name, description: item.description, booth: item.booth, categories: item.categories, featured: item.featured, website_url: item.websiteUrl, organization_names: item.organizationNames, logo_media_candidate_id: item.logoMediaCandidateId, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));
  const sessions = bundle.sessions.map((item) => ({ external_key: item.externalKey, title: item.title, session_type: item.sessionType, description: item.description, start_at: item.startDate, end_at: item.endDate, timezone: item.timezone, venue_name: item.venueName, room: item.room, age_rating: item.ageRating, organization_names: item.organizationNames, subject_targets: item.subjectTargets, person_targets: item.personTargets, image_media_candidate_id: item.imageMediaCandidateId, tags: item.tags, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));
  const guests = bundle.guests.map((item) => ({ external_key: item.externalKey, name: item.name, description: item.description, role: item.role, organization_names: item.organizationNames, person_target: item.personTarget, subject_targets: item.subjectTargets, image_media_candidate_id: item.imageMediaCandidateId, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));
  const updates = bundle.updates.map((item) => ({ external_key: item.externalKey, title: item.title, summary: item.summary, published_at: item.publishedAt, category: item.category, source_name: item.sourceName, source_url: item.sourceUrl, image_media_candidate_id: item.imageMediaCandidateId, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));
  const activities = bundle.activities.map((item) => ({ external_key: item.externalKey, activity_type: item.activityType, title: item.title, description: item.description, start_at: item.startDate, end_at: item.endDate, location: item.location, exhibitor_external_key: item.exhibitorExternalKey, session_external_key: item.sessionExternalKey, organization_names: item.organizationNames, subject_targets: item.subjectTargets, person_targets: item.personTargets, media_candidate_ids: item.mediaCandidateIds, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));
  const relatedSubjects = bundle.relatedSubjects.map((item) => ({ canonical_key: item.target.canonicalKey, provider: item.target.provider, entity_type: item.target.entityType, raw_id: item.target.rawId, encoded_id: item.target.encodedId, label: item.label, description: item.description, featured: item.featured, confidence: item.confidence, source_document_ids: item.sourceDocumentIds }));

  await db.execute(sql`INSERT INTO event.event_link(event_id,link_type,provider,url,affiliate_metadata)
    SELECT ${eventId}::uuid,r.link_type,r.provider,r.url,jsonb_build_object('label',r.label,'source_document_ids',r.source_document_ids,'confidence',r.confidence)
    FROM jsonb_to_recordset(${JSON.stringify(links)}::jsonb) AS r(link_type text,provider text,url text,label text,source_document_ids uuid[],confidence numeric)
    ON CONFLICT(event_id,link_type,url) DO UPDATE SET provider=EXCLUDED.provider,affiliate_metadata=EXCLUDED.affiliate_metadata,active=true,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.event_fact(event_id,fact_type,label,value_json,unit,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.fact_type,r.label,r.value_json,r.unit,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(facts)}::jsonb) AS r(fact_type text,label text,value_json jsonb,unit text,confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,fact_type,label) DO UPDATE SET value_json=EXCLUDED.value_json,unit=EXCLUDED.unit,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.ticket_offer(event_id,external_key,name,description,purchase_url,price_text,availability,valid_from,valid_through,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.external_key,r.name,r.description,r.purchase_url,r.price_text,r.availability,NULLIF(r.valid_from,'')::timestamptz,NULLIF(r.valid_through,'')::timestamptz,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(tickets)}::jsonb) AS r(external_key text,name text,description text,purchase_url text,price_text text,availability text,valid_from text,valid_through text,confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,external_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,purchase_url=EXCLUDED.purchase_url,price_text=EXCLUDED.price_text,availability=EXCLUDED.availability,valid_from=EXCLUDED.valid_from,valid_through=EXCLUDED.valid_through,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.exhibitor(event_id,external_key,name,description,booth,categories,featured,website_url,organization_names,logo_media_candidate_id,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.external_key,r.name,r.description,r.booth,r.categories,r.featured,r.website_url,r.organization_names,NULLIF(r.logo_media_candidate_id,'')::uuid,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(exhibitors)}::jsonb) AS r(external_key text,name text,description text,booth text,categories text[],featured boolean,website_url text,organization_names text[],logo_media_candidate_id text,confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,external_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,booth=EXCLUDED.booth,categories=EXCLUDED.categories,featured=EXCLUDED.featured,website_url=EXCLUDED.website_url,organization_names=EXCLUDED.organization_names,logo_media_candidate_id=EXCLUDED.logo_media_candidate_id,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.session(event_id,external_key,title,session_type,description,start_at,end_at,timezone,venue_name,room,age_rating,organization_names,subject_targets,person_targets,image_media_candidate_id,tags,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.external_key,r.title,r.session_type,r.description,NULLIF(r.start_at,'')::timestamptz,NULLIF(r.end_at,'')::timestamptz,r.timezone,r.venue_name,r.room,r.age_rating,r.organization_names,r.subject_targets,r.person_targets,NULLIF(r.image_media_candidate_id,'')::uuid,r.tags,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(sessions)}::jsonb) AS r(external_key text,title text,session_type text,description text,start_at text,end_at text,timezone text,venue_name text,room text,age_rating text,organization_names text[],subject_targets jsonb,person_targets jsonb,image_media_candidate_id text,tags text[],confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,external_key) DO UPDATE SET title=EXCLUDED.title,session_type=EXCLUDED.session_type,description=EXCLUDED.description,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,timezone=EXCLUDED.timezone,venue_name=EXCLUDED.venue_name,room=EXCLUDED.room,age_rating=EXCLUDED.age_rating,organization_names=EXCLUDED.organization_names,subject_targets=EXCLUDED.subject_targets,person_targets=EXCLUDED.person_targets,image_media_candidate_id=EXCLUDED.image_media_candidate_id,tags=EXCLUDED.tags,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.guest(event_id,external_key,name,description,role,organization_names,person_target,subject_targets,image_media_candidate_id,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.external_key,r.name,r.description,r.role,r.organization_names,r.person_target,r.subject_targets,NULLIF(r.image_media_candidate_id,'')::uuid,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(guests)}::jsonb) AS r(external_key text,name text,description text,role text,organization_names text[],person_target jsonb,subject_targets jsonb,image_media_candidate_id text,confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,external_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,role=EXCLUDED.role,organization_names=EXCLUDED.organization_names,person_target=EXCLUDED.person_target,subject_targets=EXCLUDED.subject_targets,image_media_candidate_id=EXCLUDED.image_media_candidate_id,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.event_update(event_id,external_key,title,summary,published_at,category,source_name,source_url,image_media_candidate_id,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.external_key,r.title,r.summary,NULLIF(r.published_at,'')::timestamptz,r.category,r.source_name,r.source_url,NULLIF(r.image_media_candidate_id,'')::uuid,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS r(external_key text,title text,summary text,published_at text,category text,source_name text,source_url text,image_media_candidate_id text,confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,external_key) DO UPDATE SET title=EXCLUDED.title,summary=EXCLUDED.summary,published_at=EXCLUDED.published_at,category=EXCLUDED.category,source_name=EXCLUDED.source_name,source_url=EXCLUDED.source_url,image_media_candidate_id=EXCLUDED.image_media_candidate_id,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.activity(event_id,external_key,activity_type,title,description,start_at,end_at,location,exhibitor_external_key,session_external_key,organization_names,subject_targets,person_targets,media_candidate_ids,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.external_key,r.activity_type,r.title,r.description,NULLIF(r.start_at,'')::timestamptz,NULLIF(r.end_at,'')::timestamptz,r.location,r.exhibitor_external_key,r.session_external_key,r.organization_names,r.subject_targets,r.person_targets,r.media_candidate_ids,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(activities)}::jsonb) AS r(external_key text,activity_type text,title text,description text,start_at text,end_at text,location text,exhibitor_external_key text,session_external_key text,organization_names text[],subject_targets jsonb,person_targets jsonb,media_candidate_ids uuid[],confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,external_key) DO UPDATE SET activity_type=EXCLUDED.activity_type,title=EXCLUDED.title,description=EXCLUDED.description,start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,location=EXCLUDED.location,exhibitor_external_key=EXCLUDED.exhibitor_external_key,session_external_key=EXCLUDED.session_external_key,organization_names=EXCLUDED.organization_names,subject_targets=EXCLUDED.subject_targets,person_targets=EXCLUDED.person_targets,media_candidate_ids=EXCLUDED.media_candidate_ids,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
  await db.execute(sql`INSERT INTO event.related_subject(event_id,canonical_key,provider,entity_type,raw_id,encoded_id,label,description,featured,confidence,source_document_ids)
    SELECT ${eventId}::uuid,r.canonical_key,r.provider,r.entity_type,r.raw_id,r.encoded_id,r.label,r.description,r.featured,r.confidence,r.source_document_ids
    FROM jsonb_to_recordset(${JSON.stringify(relatedSubjects)}::jsonb) AS r(canonical_key text,provider text,entity_type text,raw_id bigint,encoded_id bigint,label text,description text,featured boolean,confidence numeric,source_document_ids uuid[])
    ON CONFLICT(event_id,canonical_key) DO UPDATE SET label=EXCLUDED.label,description=EXCLUDED.description,featured=EXCLUDED.featured,confidence=EXCLUDED.confidence,source_document_ids=EXCLUDED.source_document_ids,updated_at=now()`);
}

export async function materializeCandidate(id: string, input: MaterializeCandidateInput): Promise<{ eventId: string; reused: boolean }> {
  const before = await currentCandidateEvent(id);
  if (!before) throw new Error("CANDIDATE_NOT_FOUND");
  if (before.eventId) {
    await materializeEventContent(id, before.eventId);
    return { eventId: before.eventId, reused: true };
  }
  if (before.status !== "PENDING") throw new Error("CANDIDATE_NOT_PENDING");

  const result = await getDb().execute(sql`
    WITH locked AS (
      SELECT c.id,c.raw_document_id,rd.source_id
      FROM ingestion.candidate c JOIN ingestion.raw_document rd ON rd.id=c.raw_document_id
      WHERE c.id=${id}::uuid AND c.status='PENDING' AND c.published_event_id IS NULL
      FOR UPDATE OF c
    ), matching_venue AS (
      SELECT v.id FROM event.venue v,locked
      WHERE ${input.venueName}<>'' AND lower(v.name)=lower(${input.venueName})
        AND lower(COALESCE(v.city,''))=lower(${input.city})
      ORDER BY v.updated_at DESC LIMIT 1
    ), inserted_venue AS (
      INSERT INTO event.venue(name,address_line1,city,region,country_code,postal_code,timezone,metadata,data_origin)
      SELECT ${input.venueName},NULLIF(${input.addressLine1},''),NULLIF(${input.city},''),NULLIF(${input.region},''),
        NULLIF(upper(${input.countryCode}),''),NULLIF(${input.postalCode},''),${input.timezone},
        jsonb_build_object('materialized_from_candidate_id',${id}::uuid),'LIVE'
      FROM locked WHERE ${input.venueName}<>'' AND NOT EXISTS(SELECT 1 FROM matching_venue)
      RETURNING id
    ), inserted_event AS (
      INSERT INTO event.event(event_type,canonical_name,start_at,end_at,timezone,venue_id,official_url,status,metadata,data_origin,enrichment_state)
      SELECT ${input.eventType},${input.title},NULLIF(${input.startAt},'')::timestamptz,NULLIF(${input.endAt},'')::timestamptz,
        ${input.timezone},COALESCE((SELECT id FROM matching_venue),(SELECT id FROM inserted_venue)),NULLIF(${input.officialUrl},''),
        'REVIEW',jsonb_build_object('materialized_from_candidate_id',${id}::uuid,'tone','slate','short',upper(left(${input.title},2))),'LIVE','NEEDS_REVIEW'
      FROM locked RETURNING id
    ), candidate_update AS (
      UPDATE ingestion.candidate c SET status='APPROVED',published_event_id=e.id,reviewed_at=now(),updated_at=now()
      FROM inserted_event e WHERE c.id=${id}::uuid RETURNING e.id,c.id AS candidate_id,c.raw_document_id
    ), event_source_insert AS (
      INSERT INTO ingestion.event_source(event_id,source_id,relation_type,confidence,status)
      SELECT DISTINCT cu.id,rd.source_id,'EVIDENCE',COALESCE((SELECT confidence FROM ingestion.candidate WHERE id=${id}::uuid),0),'ACTIVE'
      FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      JOIN ingestion.raw_document rd ON rd.id=docs.raw_document_id
      ON CONFLICT(event_id,source_id,relation_type) DO UPDATE SET confidence=EXCLUDED.confidence,status='ACTIVE',updated_at=now()
    ), evidence_insert AS (
      INSERT INTO event.event_evidence(event_id,raw_document_id,evidence_type,confidence,is_primary)
      SELECT cu.id,docs.raw_document_id,'CANDIDATE',COALESCE((SELECT confidence FROM ingestion.candidate WHERE id=${id}::uuid),0),docs.raw_document_id=cu.raw_document_id
      FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE NOT EXISTS(SELECT 1 FROM event.event_evidence ee WHERE ee.event_id=cu.id AND ee.raw_document_id=docs.raw_document_id)
    ), summary_insert AS (
      INSERT INTO event.event_text(event_id,locale,field_type,value,provider,confidence,is_primary)
      SELECT cu.id,'en','SUMMARY',${input.summary},'CANDIDATE_REVIEW',1,true FROM candidate_update cu WHERE ${input.summary}<>''
    ), assertion_update AS (
      UPDATE ingestion.assertion a SET subject_id=cu.id,updated_at=now()
      FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE a.raw_document_id=docs.raw_document_id AND a.subject_id IS NULL
    ), document_update AS (
      UPDATE ingestion.raw_document rd SET root_event_id=cu.id
      FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE rd.id=docs.raw_document_id
    ), media_update AS (
      UPDATE ingestion.media_candidate mc SET root_event_id=cu.id
      FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE mc.raw_document_id=docs.raw_document_id
    )
    SELECT id FROM candidate_update
  `);
  const eventId = result.rows[0]?.id ? String(result.rows[0].id) : (await currentCandidateEvent(id))?.eventId;
  if (!eventId) throw new Error("CANDIDATE_NOT_PENDING");
  await materializeEventContent(id, eventId);
  return { eventId, reused: false };
}

export async function linkCandidateToEvent(id: string, eventId: string): Promise<{ eventId: string; reused: boolean }> {
  const before = await currentCandidateEvent(id);
  if (!before) throw new Error("CANDIDATE_NOT_FOUND");
  if (before.eventId) {
    await materializeEventContent(id, before.eventId);
    return { eventId: before.eventId, reused: true };
  }
  if (before.status !== "PENDING") throw new Error("CANDIDATE_NOT_PENDING");
  const result = await getDb().execute(sql`
    WITH locked AS (
      SELECT c.id,c.raw_document_id,rd.source_id FROM ingestion.candidate c
      JOIN ingestion.raw_document rd ON rd.id=c.raw_document_id
      JOIN event.event e ON e.id=${eventId}::uuid
      WHERE c.id=${id}::uuid AND c.status='PENDING' AND c.published_event_id IS NULL
      FOR UPDATE OF c
    ), candidate_update AS (
      UPDATE ingestion.candidate c SET status='APPROVED',published_event_id=${eventId}::uuid,reviewed_at=now(),updated_at=now()
      FROM locked l WHERE c.id=l.id RETURNING c.id AS candidate_id,c.raw_document_id
    ), event_source_insert AS (
      INSERT INTO ingestion.event_source(event_id,source_id,relation_type,confidence,status)
      SELECT DISTINCT ${eventId}::uuid,rd.source_id,'EVIDENCE',COALESCE((SELECT confidence FROM ingestion.candidate WHERE id=${id}::uuid),0),'ACTIVE'
      FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      JOIN ingestion.raw_document rd ON rd.id=docs.raw_document_id
      ON CONFLICT(event_id,source_id,relation_type) DO UPDATE SET confidence=GREATEST(ingestion.event_source.confidence,EXCLUDED.confidence),status='ACTIVE',updated_at=now()
    ), evidence_insert AS (
      INSERT INTO event.event_evidence(event_id,raw_document_id,evidence_type,confidence,is_primary)
      SELECT ${eventId}::uuid,docs.raw_document_id,'CANDIDATE',COALESCE((SELECT confidence FROM ingestion.candidate WHERE id=${id}::uuid),0),false FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE NOT EXISTS(SELECT 1 FROM event.event_evidence ee WHERE ee.event_id=${eventId}::uuid AND ee.raw_document_id=docs.raw_document_id)
    ), assertion_update AS (
      UPDATE ingestion.assertion a SET subject_id=${eventId}::uuid,updated_at=now() FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE a.raw_document_id=docs.raw_document_id AND a.subject_id IS NULL
    ), document_update AS (
      UPDATE ingestion.raw_document rd SET root_event_id=${eventId}::uuid FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE rd.id=docs.raw_document_id
    ), media_update AS (
      UPDATE ingestion.media_candidate mc SET root_event_id=${eventId}::uuid FROM candidate_update cu
      JOIN LATERAL (SELECT cu.raw_document_id UNION SELECT ce.raw_document_id FROM ingestion.candidate_evidence ce WHERE ce.candidate_id=cu.candidate_id) docs ON true
      WHERE mc.raw_document_id=docs.raw_document_id
    ) SELECT ${eventId}::uuid AS id FROM candidate_update
  `);
  const linked = result.rows[0]?.id ? String(result.rows[0].id) : (await currentCandidateEvent(id))?.eventId;
  if (!linked) throw new Error("EVENT_OR_CANDIDATE_NOT_FOUND");
  await materializeEventContent(id, linked);
  return { eventId: linked, reused: false };
}

export async function rejectCandidate(id: string): Promise<void> {
  const result = await getDb().execute(sql`
    UPDATE ingestion.candidate SET status='REJECTED',reviewed_at=now(),updated_at=now()
    WHERE id=${id}::uuid AND status='PENDING' AND published_event_id IS NULL RETURNING id
  `);
  if (result.rows.length) return;
  const current = await currentCandidateEvent(id);
  if (!current) throw new Error("CANDIDATE_NOT_FOUND");
  if (current.status === "REJECTED") return;
  throw new Error("CANDIDATE_NOT_PENDING");
}
