import { z } from "zod";
import {
  canonicalReferenceSchema,
  eventBundleSchema,
  filenameSubjectMatchSchema,
  relatedSubjectSchema,
} from "./resolution-agent.js";

const targetPatchSchema = z.object({
  externalKey: z.string().min(1),
  subjectTargets: z.array(canonicalReferenceSchema).default([]),
  personTargets: z.array(canonicalReferenceSchema).default([]),
});

/**
 * The model returns only semantic enrichment. The service owns the full event
 * bundle and applies this bounded patch to deterministic crawler output.
 */
export const knowledgeEventEnrichmentSchema = z.object({
  event: z.object({
    description: z.string().max(4000).optional(),
    alternateNames: z.array(z.string().max(300)).max(20).optional(),
    organizerNames: z.array(z.string().max(300)).max(20).optional(),
  }).default({}),
  relatedSubjects: z.array(relatedSubjectSchema).max(40).default([]),
  relations: z.array(z.object({
    type: z.enum(["FEATURES_SUBJECT", "ORGANIZED_BY", "SPONSORED_BY", "GUEST_APPEARANCE", "RELATED_TO"]),
    target: canonicalReferenceSchema,
    label: z.string().max(300),
    confidence: z.number().min(0).max(1),
    evidenceDocumentIds: z.array(z.string().uuid()).min(1).max(10),
  })).max(80).default([]),
  sessions: z.array(targetPatchSchema).max(200).default([]),
  guests: z.array(targetPatchSchema.extend({ personTarget: canonicalReferenceSchema.nullable().default(null) })).max(200).default([]),
  activities: z.array(targetPatchSchema).max(300).default([]),
  warnings: z.array(z.string().max(500)).max(30).default([]),
});

export const knowledgeSubjectSearchRequestSchema = z.object({
  queries: z.array(z.string().min(1).max(500)).min(1).max(50),
  limit: z.number().int().min(1).max(50).default(10),
});

export const knowledgeSubjectSearchResponseSchema = z.object({
  knowledgeVersion: z.string(),
  matches: z.array(filenameSubjectMatchSchema.extend({
    query: z.string(),
  })),
});

export const knowledgeEventResolutionRequestSchema = z.object({
  baseline: eventBundleSchema,
  evidence: z.object({
    crawlRun: z.record(z.string(), z.unknown()),
    documents: z.array(z.record(z.string(), z.unknown())).min(1),
  }),
});

export const knowledgeModelMetadataSchema = z.object({
  provider: z.string(),
  name: z.string(),
  promptVersion: z.string(),
});

export const knowledgeEventResolutionResponseSchema = z.object({
  result: eventBundleSchema,
  knowledgeVersion: z.string(),
  model: knowledgeModelMetadataSchema,
  metrics: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    mentionInputTokens: z.number().int().nonnegative().optional(),
    estimatedInputTokens: z.number().int().nonnegative(),
    evidenceTokens: z.number().int().nonnegative(),
    baselineTokens: z.number().int().nonnegative().optional(),
    baselineSourceTokens: z.number().int().nonnegative().optional(),
    knowledgeCandidates: z.number().int().nonnegative(),
  }),
});

export const knowledgeStatusSchema = z.object({
  service: z.literal("anime-knowledge-service"),
  ready: z.boolean(),
  kbReady: z.boolean(),
  modelConfigured: z.boolean(),
  modelReady: z.boolean(),
  activeVersion: z.string().nullable(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  model: z.object({ provider: z.string(), name: z.string() }),
});

export const knowledgeImportRecordSchema = z.object({
  version: z.string(),
  status: z.enum(["DISCOVERED", "INDEXING", "ACTIVE", "FAILED", "AVAILABLE"]),
  discoveredAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});

export const knowledgeImportsResponseSchema = z.object({
  activeVersion: z.string().nullable(),
  imports: z.array(knowledgeImportRecordSchema),
});

export type KnowledgeSubjectSearchRequest = z.infer<typeof knowledgeSubjectSearchRequestSchema>;
export type KnowledgeSubjectSearchResponse = z.infer<typeof knowledgeSubjectSearchResponseSchema>;
export type KnowledgeEventResolutionRequest = z.infer<typeof knowledgeEventResolutionRequestSchema>;
export type KnowledgeEventResolutionResponse = z.infer<typeof knowledgeEventResolutionResponseSchema>;
export type KnowledgeEventEnrichment = z.infer<typeof knowledgeEventEnrichmentSchema>;
export type KnowledgeModelMetadata = z.infer<typeof knowledgeModelMetadataSchema>;
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;
export type KnowledgeImportRecord = z.infer<typeof knowledgeImportRecordSchema>;
