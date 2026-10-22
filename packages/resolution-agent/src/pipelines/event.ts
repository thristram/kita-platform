import {
  compactEventBaselineForPrompt,
  EVENT_PROMPT_NON_EVIDENCE_RESERVE_TOKENS,
  eventBundleSchema,
  eventPromptBaselineTokenBudget,
  type EventBundle,
  type KnowledgeModelMetadata,
  type LeasedJob,
  type ResolutionDocument,
  type ResolutionInput,
} from "@kita/contracts";
import { applyPreparedEvidence, prepareResolutionEvidence } from "@kita/evidence-pipeline";
import type { AgentConfig } from "../config.js";
import type { ResolutionControlClient } from "../client.js";
import type { KnowledgeServiceClient } from "../knowledge/client.js";
import { log } from "../logger.js";
import { compactEventEvidence, type HydratedResolutionDocument } from "./evidence-compactor.js";

interface SelectedValue { value: unknown; documentId: string; confidence: number; excerpt: string }
interface SourcedValue { value: Record<string, unknown>; documentId: string; confidence: number }

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (typeof value === "object" && "name" in value) return scalar((value as Record<string, unknown>).name);
  return "";
};

const stripHtml = (value: string): string => value
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ")
  .trim();

function selectAssertion(documents: ResolutionDocument[], paths: string[]): SelectedValue | null {
  const candidates = documents.flatMap((document) => document.assertions
    .filter((assertion) => paths.includes(assertion.fieldPath))
    .map((assertion) => ({
      value: assertion.normalizedValue ?? assertion.value,
      documentId: document.id,
      confidence: assertion.confidence,
      excerpt: assertion.excerpt,
    })));
  if (!candidates.length) return null;
  const groups = new Map<string, SelectedValue[]>();
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate.value);
    groups.set(key, [...(groups.get(key) || []), candidate]);
  }
  return [...groups.values()].sort((left, right) => {
    const score = (values: SelectedValue[]) => values.reduce((sum, item) => sum + item.confidence, 0) + values.length * 0.15;
    return score(right) - score(left);
  })[0]?.sort((left, right) => right.confidence - left.confidence)[0] || null;
}

function sourcedRecords(documents: ResolutionDocument[], path: string): SourcedValue[] {
  const records = documents.flatMap((document) => document.assertions
    .filter((assertion) => assertion.fieldPath === path)
    .flatMap((assertion) => {
      const value = assertion.normalizedValue ?? assertion.value;
      return Array.isArray(value) ? value : [];
    })
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    .map((value) => ({ value, documentId: document.id, confidence: Math.max(0, Math.min(1, document.assertions.find((item) => item.fieldPath === path)?.confidence || 0.7)) })));
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = scalar(record.value.externalKey) || `${scalar(record.value.name || record.value.title).toLowerCase()}|${scalar(record.value.startDate || record.value.url)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const optionalUrl = (value: unknown): string | null => {
  const candidate = scalar(value);
  try { return candidate ? new URL(candidate).toString() : null; } catch { return null; }
};
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.map(scalar).filter(Boolean) : [];
const externalKey = (value: Record<string, unknown>, prefix: string): string => scalar(value.externalKey) || `${prefix}:${scalar(value.name || value.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const mediaIdFor = (documents: ResolutionDocument[], documentId: string, value: Record<string, unknown>, fields: string[]): string | null => {
  const urls = fields.map((field) => scalar(value[field])).filter(Boolean);
  if (!urls.length) return null;
  return documents.find((document) => document.id === documentId)?.media.find((media) => urls.includes(media.url))?.id || null;
};
const sessionType = (value: Record<string, unknown>): EventBundle["sessions"][number]["sessionType"] => {
  const text = `${scalar(value.sessionType)} ${scalar(value.title || value.name)} ${scalar(value.description)}`.toLowerCase();
  if (/opening|closing|ceremony/.test(text)) return "CEREMONY";
  if (/concert|live|music|symphony/.test(text)) return "CONCERT";
  if (/signing|autograph/.test(text)) return "SIGNING";
  if (/workshop/.test(text)) return "WORKSHOP";
  if (/screening|premiere/.test(text)) return "SCREENING";
  if (/cosplay/.test(text)) return "COSPLAY";
  if (/meetup|gathering/.test(text)) return "MEETUP";
  if (/guest/.test(text)) return "GUEST_APPEARANCE";
  if (/panel|talk/.test(text)) return "PANEL";
  return "OTHER";
};
const activityTypeForSession = (value: EventBundle["sessions"][number]["sessionType"]): EventBundle["activities"][number]["activityType"] => ({
  PANEL: "PANEL", CONCERT: "CONCERT", SIGNING: "SIGNING", WORKSHOP: "WORKSHOP", SCREENING: "SCREENING",
  COSPLAY: "COSPLAY_GATHERING", MEETUP: "FAN_MEETUP", GUEST_APPEARANCE: "GUEST_APPEARANCE",
  CEREMONY: "OTHER", OTHER: "OTHER",
})[value] as EventBundle["activities"][number]["activityType"];

function deterministicContent(input: ResolutionInput, timezone: string): Pick<EventBundle, "links" | "facts" | "ticketOffers" | "exhibitors" | "sessions" | "guests" | "updates" | "activities" | "relatedSubjects"> {
  const links = sourcedRecords(input.documents, "content.links").flatMap(({ value, documentId, confidence }) => {
    const url = optionalUrl(value.url);
    const type = scalar(value.type).toUpperCase();
    return url ? [{ type: (["OFFICIAL", "TICKETS", "SCHEDULE", "EXHIBITORS", "MAP", "UPDATES", "POLICY"].includes(type) ? type : "OTHER") as EventBundle["links"][number]["type"], label: scalar(value.label), url, sourceDocumentIds: [documentId], confidence }] : [];
  });
  const facts = sourcedRecords(input.documents, "content.facts").flatMap(({ value, documentId, confidence }) => {
    const raw = value.value;
    if (!["string", "number", "boolean"].includes(typeof raw)) return [];
    const type = scalar(value.type).toUpperCase();
    return [{ type: (["FIRST_HELD", "ATTENDANCE", "COUNTRIES_REPRESENTED", "DURATION_DAYS", "TRAVEL_RELEVANCE"].includes(type) ? type : "OTHER") as EventBundle["facts"][number]["type"], label: scalar(value.label) || type, value: raw as string | number | boolean, unit: scalar(value.unit) || null, sourceDocumentIds: [documentId], confidence }];
  });
  const ticketOffers = sourcedRecords(input.documents, "content.ticket_offers").map(({ value, documentId, confidence }) => {
    const availability = scalar(value.availability).toUpperCase().replace(/[^A-Z_]/g, "_");
    return { externalKey: externalKey(value, "ticket"), name: scalar(value.name) || "Tickets", description: scalar(value.description), purchaseUrl: optionalUrl(value.purchaseUrl || value.url), priceText: scalar(value.priceText), availability: (["ANNOUNCED", "ON_SALE", "SOLD_OUT", "ENDED"].includes(availability) ? availability : "UNKNOWN") as EventBundle["ticketOffers"][number]["availability"], validFrom: scalar(value.validFrom) || null, validThrough: scalar(value.validThrough) || null, sourceDocumentIds: [documentId], confidence };
  });
  const exhibitors = sourcedRecords(input.documents, "content.exhibitors").map(({ value, documentId, confidence }) => ({
    externalKey: externalKey(value, "exhibitor"), name: scalar(value.name || value.title), description: scalar(value.description), booth: scalar(value.booth), categories: stringArray(value.categories), featured: Boolean(value.featured), websiteUrl: optionalUrl(value.websiteUrl || value.url), logoMediaCandidateId: mediaIdFor(input.documents, documentId, value, ["logoUrl", "imageUrl"]), organizationNames: stringArray(value.organizationNames), sourceDocumentIds: [documentId], confidence,
  })).filter((item) => item.name);
  const sessions = sourcedRecords(input.documents, "content.sessions").map(({ value, documentId, confidence }) => ({
    externalKey: externalKey(value, "session"), title: scalar(value.title || value.name), sessionType: sessionType(value), description: scalar(value.description), startDate: scalar(value.startDate) || null, endDate: scalar(value.endDate) || null, timezone, venueName: scalar(value.venueName), room: scalar(value.room), ageRating: scalar(value.ageRating), organizationNames: stringArray(value.organizationNames), subjectTargets: [], personTargets: [], imageMediaCandidateId: mediaIdFor(input.documents, documentId, value, ["imageUrl"]), tags: stringArray(value.tags), sourceDocumentIds: [documentId], confidence,
  })).filter((item) => item.title);
  const guests = sourcedRecords(input.documents, "content.guests").map(({ value, documentId, confidence }) => ({
    externalKey: externalKey(value, "guest"), name: scalar(value.name || value.title), description: scalar(value.description), role: scalar(value.role), organizationNames: stringArray(value.organizationNames), personTarget: null, subjectTargets: [], imageMediaCandidateId: mediaIdFor(input.documents, documentId, value, ["imageUrl"]), sourceDocumentIds: [documentId], confidence,
  })).filter((item) => item.name);
  const updates = sourcedRecords(input.documents, "content.updates").map(({ value, documentId, confidence }) => {
    const rawCategory = scalar(value.category).toUpperCase();
    const category = (["OFFICIAL", "EXHIBITOR", "GUEST", "TICKET", "MEDIA", "POLICY", "SCHEDULE"].includes(rawCategory) ? rawCategory : "OTHER") as EventBundle["updates"][number]["category"];
    return { externalKey: externalKey(value, "update"), title: scalar(value.title || value.name), summary: scalar(value.summary || value.description), publishedAt: scalar(value.publishedAt) || null, category, sourceName: scalar(value.sourceName), sourceUrl: optionalUrl(value.sourceUrl || value.url), imageMediaCandidateId: mediaIdFor(input.documents, documentId, value, ["imageUrl"]), sourceDocumentIds: [documentId], confidence };
  }).filter((item) => item.title);
  const activities: EventBundle["activities"] = [
    ...sessions.map((item) => ({ externalKey: `activity:${item.externalKey}`, activityType: activityTypeForSession(item.sessionType), title: item.title, description: item.description, startDate: item.startDate, endDate: item.endDate, location: [item.venueName, item.room].filter(Boolean).join(" · "), exhibitorExternalKey: null, sessionExternalKey: item.externalKey, organizationNames: item.organizationNames, subjectTargets: [], personTargets: [], mediaCandidateIds: item.imageMediaCandidateId ? [item.imageMediaCandidateId] : [], sourceDocumentIds: item.sourceDocumentIds, confidence: item.confidence })),
    ...exhibitors.map((item) => ({ externalKey: `activity:${item.externalKey}`, activityType: "OFFICIAL_BOOTH" as const, title: item.name, description: item.description, startDate: null, endDate: null, location: item.booth, exhibitorExternalKey: item.externalKey, sessionExternalKey: null, organizationNames: item.organizationNames.length ? item.organizationNames : [item.name], subjectTargets: [], personTargets: [], mediaCandidateIds: item.logoMediaCandidateId ? [item.logoMediaCandidateId] : [], sourceDocumentIds: item.sourceDocumentIds, confidence: item.confidence })),
  ];
  return { links, facts, ticketOffers, exhibitors, sessions, guests, updates, activities, relatedSubjects: [] };
}

function venueFrom(value: unknown) {
  if (!value || typeof value !== "object") return { name: scalar(value), addressLine1: "", city: "", region: "", postalCode: "", countryCode: "" };
  const location = value as Record<string, unknown>;
  const address = location.address && typeof location.address === "object" ? location.address as Record<string, unknown> : {};
  const country = address.addressCountry;
  return {
    name: scalar(location.name),addressLine1: scalar(address.streetAddress),city: scalar(address.addressLocality),
    region: scalar(address.addressRegion),postalCode: scalar(address.postalCode),
    countryCode: typeof country === "object" && country ? scalar((country as Record<string, unknown>).name) : scalar(country),
  };
}

function inferTimezone(venue: ReturnType<typeof venueFrom>): string {
  const region = venue.region.toUpperCase();
  if (venue.countryCode.toUpperCase() === "US") {
    if (["CA", "WA", "OR", "NV"].includes(region)) return "America/Los_Angeles";
    if (["AZ"].includes(region)) return "America/Phoenix";
    if (["CO", "ID", "MT", "NM", "UT", "WY"].includes(region)) return "America/Denver";
    if (["AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI"].includes(region)) return "America/Chicago";
    return "America/New_York";
  }
  return "UTC";
}

function deterministicBundle(input: ResolutionInput): EventBundle {
  const title = selectAssertion(input.documents, ["title", "name"]);
  const start = selectAssertion(input.documents, ["start_at", "start_date"]);
  const end = selectAssertion(input.documents, ["end_at", "end_date"]);
  const description = selectAssertion(input.documents, ["description", "summary"]);
  const location = selectAssertion(input.documents, ["location", "venue"]);
  const officialUrl = selectAssertion(input.documents, ["official_url", "url"]);
  const selected = [title, start, end, description, location, officialUrl].filter((item): item is SelectedValue => Boolean(item));
  const venue = venueFrom(location?.value);
  const timezone = inferTimezone(venue);
  const content = deterministicContent(input, timezone);
  const fallbackDocument = input.documents[0];
  if (!fallbackDocument) throw new Error("Resolution input has no documents");
  const warnings = ["Generated by deterministic fallback; relationships and ambiguous fields require review."];
  const startYear = scalar(start?.value).match(/\b(20\d{2})\b/)?.[1];
  const descriptionYears = [...scalar(description?.value).matchAll(/\b(20\d{2})\b/g)].map((match) => match[1]);
  if (startYear && descriptionYears.some((year) => year !== startYear)) warnings.push(`Description contains a year that conflicts with the selected ${startYear} event date.`);
  const evidence: EventBundle["evidence"] = selected.map((item) => ({
    field: item === title ? "event.name" : item === start ? "event.startDate" : item === end ? "event.endDate" : item === description ? "event.description" : item === location ? "event.venue" : "event.officialUrl",
    sourceDocumentId: item.documentId,method: "crawler-assertion" as const,quote: item.excerpt.slice(0, 1000),confidence: item.confidence,
  }));
  if (!evidence.length) evidence.push({ field: "event.name",sourceDocumentId: fallbackDocument.id,method: "dom",quote: fallbackDocument.title,confidence: 0.3 });
  const seenMediaUrls = new Set<string>();
  const media = input.documents.flatMap((document) => document.media.map((item) => ({ ...item, documentId: document.id })))
    .filter((item) => {
      if (item.score < 0.65 || /(?:ico-|icon|search|menu|arrow|social)/i.test(item.url) || seenMediaUrls.has(item.url)) return false;
      seenMediaUrls.add(item.url);
      return true;
    }).slice(0, 12).map((item) => ({
      sourceDocumentId: item.documentId,mediaCandidateId: item.id,url: item.url,
      role: (/logo/i.test(item.category) ? "EVENT_LOGO" : /poster/i.test(item.category) ? "EVENT_POSTER" : /hero|banner/i.test(item.category) ? "EVENT_HERO" : "OTHER") as "EVENT_LOGO" | "EVENT_POSTER" | "EVENT_HERO" | "OTHER",
      confidence: Math.max(0, Math.min(1, item.score)),method: "crawler-signals" as const,
    }));
  return eventBundleSchema.parse({
    schemaVersion: "event-content-bundle/v2",
    event: {
      name: scalar(title?.value) || fallbackDocument.title || input.crawlRun.sourceName,
      alternateNames: [],eventType: "CONVENTION",description: scalar(description?.value),
      startDate: scalar(start?.value) || null,endDate: scalar(end?.value) || null,
      timezone,venue,
      officialUrl: scalar(officialUrl?.value) || input.crawlRun.rootUrl,
      organizerNames: [],
    },
    ...content,relations: [],media,evidence,conflicts: [],
    warnings,
    confidence: selected.length ? selected.reduce((sum, item) => sum + item.confidence, 0) / selected.length : 0.3,
  });
}

async function hydrateDocuments(config: AgentConfig, client: ResolutionControlClient, job: LeasedJob, input: ResolutionInput): Promise<HydratedResolutionDocument[]> {
  let remaining = config.maxContextChars;
  const hydrated: HydratedResolutionDocument[] = [];
  const prioritized = [...input.documents].sort((left, right) => {
    const weight = (pageType: string) => ({ EVENT: 0, OVERVIEW: 1, ABOUT: 2, SCHEDULE: 3, GUESTS: 4 }[pageType] ?? 10);
    return weight(left.pageType) - weight(right.pageType);
  });
  for (const document of prioritized) {
    let rawText = "";
    if (remaining > 0 && document.mimeType.includes("html")) {
      try {
        const content = stripHtml(await client.documentContent(job, document.contentUrl));
        rawText = content.slice(0, remaining);
        remaining -= rawText.length;
      } catch {
        rawText = "";
      }
    }
    hydrated.push({ ...document, rawText });
  }
  return hydrated;
}

export async function resolveEvent(
  config: AgentConfig,
  client: ResolutionControlClient,
  knowledge: KnowledgeServiceClient,
  job: LeasedJob,
  input: ResolutionInput,
): Promise<{ result: EventBundle; model: KnowledgeModelMetadata; inputTokens?: number; outputTokens?: number }> {
  const preparedEvidence = prepareResolutionEvidence(input);
  const preparedInput = applyPreparedEvidence(input, preparedEvidence);
  log("info", "Prepared run evidence", {
    jobId: job.id,
    pipelineVersion: preparedEvidence.pipelineVersion,
    inputHash: preparedEvidence.inputHash,
    stats: preparedEvidence.stats,
    conflicts: preparedEvidence.conflicts.length,
  });
  const fallback = deterministicBundle(preparedInput);
  const deterministicModel = { provider: "deterministic", name: "deterministic", promptVersion: "event-resolution-fallback-v1" };
  if (!knowledge.enabled) {
    if (job.input.resolutionMode === "LLM_REQUIRED") throw new Error("LLM_REQUIRED_BUT_KNOWLEDGE_SERVICE_IS_NOT_CONFIGURED");
    return { result: fallback, model: deterministicModel };
  }
  const documents = await hydrateDocuments(config, client, job, preparedInput);
  const promptBaseline = compactEventBaselineForPrompt(
    fallback,
    eventPromptBaselineTokenBudget(config.knowledgePromptTokenBudget),
  );
  const availableEvidenceTokens = config.knowledgePromptTokenBudget
    - promptBaseline.stats.estimatedTokens
    - EVENT_PROMPT_NON_EVIDENCE_RESERVE_TOKENS;
  if (availableEvidenceTokens < 1_000) {
    throw new Error(`EVENT_PROMPT_BUDGET_EXHAUSTED: ${promptBaseline.stats.estimatedTokens} baseline tokens leave only ${availableEvidenceTokens} tokens for crawler evidence`);
  }
  const adaptiveBudget = Math.min(config.evidenceTokenBudget, availableEvidenceTokens);
  const compacted = compactEventEvidence(preparedInput, documents, adaptiveBudget);
  log("info", "Compacted event context", {
    jobId: job.id,
    promptTokenBudget: config.knowledgePromptTokenBudget,
    baseline: promptBaseline.stats,
    evidence: compacted.stats,
    reservedTokens: EVENT_PROMPT_NON_EVIDENCE_RESERVE_TOKENS,
  });
  try {
    // The service needs the complete deterministic bundle so it can apply the
    // small LLM enrichment patch without losing records omitted from the prompt.
    const response = await knowledge.resolveEvent({ baseline: fallback, evidence: compacted.evidence });
    const merge = <T>(baseline: T[], enriched: T[], key: (value: T) => string): T[] => {
      const values = new Map(baseline.map((item) => [key(item), item]));
      for (const item of enriched) values.set(key(item), item);
      return [...values.values()];
    };
    const result = eventBundleSchema.parse({
      ...response.result,
      links: merge(fallback.links, response.result.links, (item) => item.url),
      facts: merge(fallback.facts, response.result.facts, (item) => `${item.type}:${item.label}`),
      ticketOffers: merge(fallback.ticketOffers, response.result.ticketOffers, (item) => item.externalKey),
      exhibitors: merge(fallback.exhibitors, response.result.exhibitors, (item) => item.externalKey),
      sessions: merge(fallback.sessions, response.result.sessions, (item) => item.externalKey),
      guests: merge(fallback.guests, response.result.guests, (item) => item.externalKey),
      updates: merge(fallback.updates, response.result.updates, (item) => item.externalKey),
      activities: merge(fallback.activities, response.result.activities, (item) => item.externalKey),
      relatedSubjects: merge(fallback.relatedSubjects, response.result.relatedSubjects, (item) => item.target.canonicalKey),
    });
    return { result, model: response.model, inputTokens: response.metrics.inputTokens, outputTokens: response.metrics.outputTokens };
  } catch (error) {
    if (job.input.resolutionMode === "LLM_REQUIRED") throw error;
    fallback.warnings.push(`Anime Knowledge Service result was unavailable and deterministic fallback was used: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
    return { result: fallback, model: deterministicModel };
  }
}
