import { z } from "zod";

/** Exact compatibility transform from AnimeReactDownloadHelper uniqueIdHelper.js. */
export function encodeLegacyBangumiId(rawId: number): number {
  if (!Number.isInteger(rawId) || rawId < 1 || rawId > 999_999_999) throw new RangeError("Bangumi id must be an integer between 1 and 999999999");
  const prime = BigInt(1_000_000_007);
  let encoded = (BigInt(rawId) * BigInt(1_580_030_173) + BigInt(59_260_789)) % prime;
  if (encoded === BigInt(0)) encoded = BigInt(1);
  return Number(encoded);
}

export const resolutionCapabilitySchema = z.enum([
  "EVENT_RESOLUTION_V1",
  "BANGUMI_LINKING_V1",
  "FILENAME_RESOLUTION_V1",
]);

export const leaseRequestSchema = z.object({
  agentId: z.string().min(1).max(120),
  agentVersion: z.string().min(1).max(60),
  capabilities: z.array(resolutionCapabilitySchema).min(1),
  leaseSeconds: z.number().int().min(60).max(1800).default(600),
});

export const leasedJobSchema = z.object({
  id: z.string().uuid(),
  type: z.literal("EVENT_RESOLUTION"),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  leaseToken: z.string().min(20),
  leaseExpiresAt: z.string().datetime(),
  input: z.object({
    crawlRunId: z.string().uuid(),
    sourceId: z.string().uuid(),
    documentIds: z.array(z.string().uuid()),
    knownEventId: z.string().uuid().nullable(),
    resolutionMode: z.enum(["AUTO", "LLM_REQUIRED"]).default("AUTO"),
  }),
});

export const leaseResponseSchema = z.object({
  contractVersion: z.literal("1.0"),
  job: leasedJobSchema.nullable(),
  retryAfterMs: z.number().int().min(250).max(60_000).optional(),
});

export const assertionInputSchema = z.object({
  id: z.string().uuid(),
  fieldPath: z.string(),
  value: z.unknown(),
  normalizedValue: z.unknown(),
  confidence: z.number().min(0).max(1),
  locator: z.string(),
  excerpt: z.string(),
});

export const resolutionDocumentSchema = z.object({
  id: z.string().uuid(),
  canonicalUrl: z.string().url(),
  title: z.string(),
  pageType: z.string(),
  mimeType: z.string(),
  fetchedAt: z.string().datetime(),
  contentHash: z.string().min(8).optional(),
  textPreview: z.string(),
  contentUrl: z.string().url(),
  assertions: z.array(assertionInputSchema),
  chunks: z.array(z.object({
    index: z.number().int().nonnegative(),
    heading: z.string(),
    content: z.string(),
  })),
  media: z.array(z.object({
    id: z.string().uuid(),
    url: z.string().url(),
    category: z.string(),
    score: z.number(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    mimeType: z.string().nullable(),
  })),
});

export const resolutionInputSchema = z.object({
  contractVersion: z.literal("1.0"),
  jobId: z.string().uuid(),
  crawlRun: z.object({
    id: z.string().uuid(),
    sourceId: z.string().uuid(),
    sourceName: z.string(),
    rootUrl: z.string().url(),
    rootEventId: z.string().uuid().nullable(),
  }),
  documents: z.array(resolutionDocumentSchema).min(1),
});

export const canonicalReferenceSchema = z.object({
  provider: z.literal("bangumi"),
  entityType: z.enum(["subject", "person", "character", "episode"]),
  rawId: z.number().int().positive(),
  encodedId: z.number().int().positive(),
  canonicalKey: z.string().regex(/^bangumi:(subject|person|character|episode):\d+$/),
}).superRefine((value, context) => {
  const expectedKey = `bangumi:${value.entityType}:${value.rawId}`;
  if (value.canonicalKey !== expectedKey) context.addIssue({ code: "custom", path: ["canonicalKey"], message: `Expected ${expectedKey}` });
  if (value.encodedId !== encodeLegacyBangumiId(value.rawId)) context.addIssue({ code: "custom", path: ["encodedId"], message: "encodedId does not match the legacy compatibility transform" });
});

export const fieldEvidenceSchema = z.object({
  field: z.string().min(1),
  sourceDocumentId: z.string().uuid(),
  method: z.enum(["json-ld", "dom", "crawler-assertion", "knowledge-base", "llm-inference", "human"]),
  quote: z.string().max(1000),
  confidence: z.number().min(0).max(1),
});

const sourcedRecordSchema = z.object({
  sourceDocumentIds: z.array(z.string().uuid()).min(1),
  confidence: z.number().min(0).max(1),
});

export const eventLinkSchema = sourcedRecordSchema.extend({
  type: z.enum(["OFFICIAL", "TICKETS", "SCHEDULE", "EXHIBITORS", "MAP", "UPDATES", "POLICY", "OTHER"]),
  label: z.string().default(""),
  url: z.string().url(),
});

export const eventFactSchema = sourcedRecordSchema.extend({
  type: z.enum(["FIRST_HELD", "ATTENDANCE", "COUNTRIES_REPRESENTED", "DURATION_DAYS", "TRAVEL_RELEVANCE", "OTHER"]),
  label: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().nullable().default(null),
});

export const eventTicketOfferSchema = sourcedRecordSchema.extend({
  externalKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  purchaseUrl: z.string().url().nullable().default(null),
  priceText: z.string().default(""),
  availability: z.enum(["ANNOUNCED", "ON_SALE", "SOLD_OUT", "ENDED", "UNKNOWN"]).default("UNKNOWN"),
  validFrom: z.string().nullable().default(null),
  validThrough: z.string().nullable().default(null),
});

export const eventExhibitorSchema = sourcedRecordSchema.extend({
  externalKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  booth: z.string().default(""),
  categories: z.array(z.string()).default([]),
  featured: z.boolean().default(false),
  websiteUrl: z.string().url().nullable().default(null),
  logoMediaCandidateId: z.string().uuid().nullable().default(null),
  organizationNames: z.array(z.string()).default([]),
});

export const eventSessionSchema = sourcedRecordSchema.extend({
  externalKey: z.string().min(1),
  title: z.string().min(1),
  sessionType: z.enum(["CEREMONY", "PANEL", "CONCERT", "SIGNING", "WORKSHOP", "SCREENING", "COSPLAY", "MEETUP", "GUEST_APPEARANCE", "OTHER"]),
  description: z.string().default(""),
  startDate: z.string().nullable().default(null),
  endDate: z.string().nullable().default(null),
  timezone: z.string().default("UTC"),
  venueName: z.string().default(""),
  room: z.string().default(""),
  ageRating: z.string().default(""),
  organizationNames: z.array(z.string()).default([]),
  subjectTargets: z.array(canonicalReferenceSchema).default([]),
  personTargets: z.array(canonicalReferenceSchema).default([]),
  imageMediaCandidateId: z.string().uuid().nullable().default(null),
  tags: z.array(z.string()).default([]),
});

export const eventGuestSchema = sourcedRecordSchema.extend({
  externalKey: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  role: z.string().default(""),
  organizationNames: z.array(z.string()).default([]),
  personTarget: canonicalReferenceSchema.nullable().default(null),
  subjectTargets: z.array(canonicalReferenceSchema).default([]),
  imageMediaCandidateId: z.string().uuid().nullable().default(null),
});

export const eventUpdateSchema = sourcedRecordSchema.extend({
  externalKey: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  publishedAt: z.string().nullable().default(null),
  category: z.enum(["OFFICIAL", "EXHIBITOR", "GUEST", "TICKET", "MEDIA", "POLICY", "SCHEDULE", "OTHER"]),
  sourceName: z.string().default(""),
  sourceUrl: z.string().url().nullable().default(null),
  imageMediaCandidateId: z.string().uuid().nullable().default(null),
});

export const eventActivitySchema = sourcedRecordSchema.extend({
  externalKey: z.string().min(1),
  activityType: z.enum(["OFFICIAL_BOOTH", "PANEL", "COSPLAY_GATHERING", "SCREENING", "MERCH_DROP", "FAN_MEETUP", "GUEST_APPEARANCE", "CONCERT", "SIGNING", "WORKSHOP", "OTHER"]),
  title: z.string().min(1),
  description: z.string().default(""),
  startDate: z.string().nullable().default(null),
  endDate: z.string().nullable().default(null),
  location: z.string().default(""),
  exhibitorExternalKey: z.string().nullable().default(null),
  sessionExternalKey: z.string().nullable().default(null),
  organizationNames: z.array(z.string()).default([]),
  subjectTargets: z.array(canonicalReferenceSchema).default([]),
  personTargets: z.array(canonicalReferenceSchema).default([]),
  mediaCandidateIds: z.array(z.string().uuid()).default([]),
});

export const relatedSubjectSchema = sourcedRecordSchema.extend({
  target: canonicalReferenceSchema,
  label: z.string().min(1),
  description: z.string().default(""),
  featured: z.boolean().default(false),
});

export const eventBundleSchema = z.object({
  schemaVersion: z.literal("event-content-bundle/v2"),
  event: z.object({
    name: z.string().min(1),
    alternateNames: z.array(z.string()).default([]),
    eventType: z.enum(["CONVENTION", "CONCERT", "COSPLAY", "MEETUP", "POPUP", "EXHIBITION", "DOUJIN", "SCREENING", "PANEL", "SIGNING", "OTHER"]),
    description: z.string().default(""),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    timezone: z.string().default("UTC"),
    venue: z.object({
      name: z.string().default(""),
      addressLine1: z.string().default(""),
      city: z.string().default(""),
      region: z.string().default(""),
      postalCode: z.string().default(""),
      countryCode: z.string().default(""),
    }),
    officialUrl: z.string().url(),
    organizerNames: z.array(z.string()).default([]),
  }),
  links: z.array(eventLinkSchema).default([]),
  facts: z.array(eventFactSchema).default([]),
  ticketOffers: z.array(eventTicketOfferSchema).default([]),
  exhibitors: z.array(eventExhibitorSchema).default([]),
  sessions: z.array(eventSessionSchema).default([]),
  guests: z.array(eventGuestSchema).default([]),
  updates: z.array(eventUpdateSchema).default([]),
  activities: z.array(eventActivitySchema).default([]),
  relatedSubjects: z.array(relatedSubjectSchema).default([]),
  relations: z.array(z.object({
    type: z.enum(["FEATURES_SUBJECT", "ORGANIZED_BY", "SPONSORED_BY", "GUEST_APPEARANCE", "RELATED_TO"]),
    target: canonicalReferenceSchema,
    label: z.string(),
    confidence: z.number().min(0).max(1),
    evidenceDocumentIds: z.array(z.string().uuid()).min(1),
  })).default([]),
  media: z.array(z.object({
    sourceDocumentId: z.string().uuid(),
    mediaCandidateId: z.string().uuid(),
    url: z.string().url(),
    role: z.enum(["EVENT_HERO", "EVENT_POSTER", "EVENT_LOGO", "VENUE", "GUEST", "SPONSOR", "OTHER"]),
    confidence: z.number().min(0).max(1),
    method: z.enum(["crawler-signals", "metadata", "ocr", "embedding", "vision-llm"]),
  })).default([]),
  evidence: z.array(fieldEvidenceSchema).min(1),
  conflicts: z.array(z.object({
    field: z.string(),
    values: z.array(z.object({ value: z.unknown(), sourceDocumentId: z.string().uuid() })).min(2),
    resolution: z.string(),
  })).default([]),
  warnings: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const completionRequestSchema = z.object({
  contractVersion: z.literal("1.0"),
  leaseToken: z.string().min(20),
  result: eventBundleSchema,
  model: z.object({
    provider: z.string(),
    name: z.string(),
    promptVersion: z.string(),
  }),
  metrics: z.object({
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
});

export const heartbeatRequestSchema = z.object({
  leaseToken: z.string().min(20),
  extendBySeconds: z.number().int().min(60).max(900).default(300),
});

export const failureRequestSchema = z.object({
  leaseToken: z.string().min(20),
  errorCode: z.string().min(1).max(100),
  message: z.string().min(1).max(1000),
  retryable: z.boolean(),
});

export const filenameResolutionRequestSchema = z.object({
  value: z.string().min(1).max(2000),
});

export const filenameSubjectMatchSchema = z.object({
  subject: canonicalReferenceSchema,
  name: z.string(),
  nameCn: z.string(),
  score: z.number().min(0).max(1),
});

export const filenameResolutionSchema = z.object({
  input: z.string(),
  normalizedTitle: z.string().min(1),
  season: z.number().int().positive().nullable(),
  episode: z.number().nonnegative().nullable(),
  selectedMatch: filenameSubjectMatchSchema.nullable(),
  matches: z.array(filenameSubjectMatchSchema),
  resolutionMethod: z.literal("llm-kb"),
  confidence: z.number().min(0).max(1),
});

export type ResolutionCapability = z.infer<typeof resolutionCapabilitySchema>;
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;
export type LeaseResponse = z.infer<typeof leaseResponseSchema>;
export type LeasedJob = z.infer<typeof leasedJobSchema>;
export type ResolutionInput = z.infer<typeof resolutionInputSchema>;
export type ResolutionDocument = z.infer<typeof resolutionDocumentSchema>;
export type EventBundle = z.infer<typeof eventBundleSchema>;
export type CompletionRequest = z.infer<typeof completionRequestSchema>;
export type FilenameResolution = z.infer<typeof filenameResolutionSchema>;
