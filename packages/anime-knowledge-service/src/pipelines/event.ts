import { z } from "zod";
import {
  compactEventBaselineForPrompt,
  estimateChatTokens,
  estimateModelTokens,
  eventBundleSchema,
  eventPromptBaselineTokenBudget,
  knowledgeEventEnrichmentSchema,
  knowledgeEventResolutionResponseSchema,
  type EventBundle,
  type KnowledgeEventResolutionRequest,
  type KnowledgeEventResolutionResponse,
} from "@kita/contracts";
import type { BangumiStore } from "../kb/store.js";
import type { JsonLlm } from "../llm/client.js";
import { log } from "../logger.js";

export class ContextBudgetError extends Error {}

const genericTerms = new Set(["anime expo", "schedule", "panel", "guest", "guests", "event", "events", "tickets", "exhibitors", "updates", "news"]);

function deterministicQueries(input: KnowledgeEventResolutionRequest): string[] {
  const values: string[] = [
    ...input.baseline.event.alternateNames,
    ...input.baseline.event.organizerNames,
    ...input.baseline.exhibitors.flatMap((item) => [item.name, ...item.organizationNames]),
    ...input.baseline.sessions.flatMap((item) => [item.title, ...item.organizationNames, ...item.tags]),
    ...input.baseline.guests.flatMap((item) => [item.name, ...item.organizationNames]),
    ...input.baseline.updates.map((item) => item.title),
  ];
  for (const document of input.evidence.documents) {
    const assertions = Array.isArray(document.assertions) ? document.assertions : [];
    for (const assertion of assertions) {
      if (!assertion || typeof assertion !== "object") continue;
      const record = assertion as Record<string, unknown>;
      for (const key of ["normalizedValue", "value"]) {
        const value = record[key];
        if (typeof value === "string") values.push(value);
        else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string"));
      }
    }
  }
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const normalized = value.toLocaleLowerCase();
    if (value.length < 2 || value.length > 160 || genericTerms.has(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, 80);
}

function resolutionSystem(baseline: EventBundle): string {
  return `Act as an evidence-bound event enrichment engine. Return only one JSON object matching the supplied JSON Schema. The crawler already created the event; do not repeat its full bundle. Return only semantic enrichments: corrected description/aliases/organizers when directly supported, Bangumi relatedSubjects and relations, and subject/person targets for existing sessions, guests, and activities. Match collection patches by externalKey. Use only knowledgeCandidates supplied by this request and copy every Bangumi identity field exactly. Never treat encodedId as globally unique. Never invent attendance, popularity, booth numbers, times, people, organizations, or claims. Use source document IDs already present in the baseline or evidence. Do not include reasoning or markdown. Bounded baseline: ${JSON.stringify(baseline)}`;
}

function assertWithinBudget(label: string, system: string, user: string, budget: number): number {
  const estimated = estimateChatTokens(system, user);
  if (estimated > budget) throw new ContextBudgetError(`${label} requires approximately ${estimated} tokens, exceeding the configured ${budget}-token prompt budget`);
  return estimated;
}

const merge = <T>(baseline: T[], additions: T[], key: (value: T) => string): T[] => {
  const values = new Map(baseline.map((item) => [key(item), item]));
  for (const item of additions) values.set(key(item), item);
  return [...values.values()];
};

export async function resolveEventWithKnowledge(
  input: KnowledgeEventResolutionRequest,
  store: BangumiStore,
  llm: JsonLlm,
  knowledgeVersion: string,
  promptTokenBudget: number,
): Promise<KnowledgeEventResolutionResponse> {
  if (!store.size) throw new Error("Bangumi knowledge base is not ready");
  if (!llm.enabled) throw new Error("Local LLM is not configured");

  const queries = deterministicQueries(input);
  const candidateMap = new Map<string, ReturnType<BangumiStore["search"]>[number] & { query: string; graph: ReturnType<BangumiStore["expandSubject"]> }>();
  for (const query of queries) {
    for (const match of store.search(query, 3)) {
      if (match.score < 0.42) continue;
      const graph = store.expandSubject(match.subject.rawId);
      const candidate = { query, ...match, graph: { relatedSubjects: graph.relatedSubjects.slice(0, 8), people: graph.people.slice(0, 8) } };
      const current = candidateMap.get(match.subject.canonicalKey);
      if (!current || candidate.score > current.score) candidateMap.set(match.subject.canonicalKey, candidate);
    }
  }

  const baselineCompaction = compactEventBaselineForPrompt(input.baseline, eventPromptBaselineTokenBudget(promptTokenBudget));
  const system = resolutionSystem(baselineCompaction.baseline);
  const knowledge: Array<(typeof candidateMap extends Map<string, infer Candidate> ? Candidate : never)> = [];
  const rankedKnowledge = [...candidateMap.values()].sort((left, right) => right.score - left.score || left.subject.canonicalKey.localeCompare(right.subject.canonicalKey));
  let user = JSON.stringify({ evidence: input.evidence, knowledgeCandidates: knowledge });
  assertWithinBudget("Event resolution prompt without knowledge candidates", system, user, promptTokenBudget);
  for (const candidate of rankedKnowledge) {
    const tentative = [...knowledge, candidate];
    const tentativeUser = JSON.stringify({ evidence: input.evidence, knowledgeCandidates: tentative });
    if (estimateChatTokens(system, tentativeUser) > promptTokenBudget) continue;
    knowledge.push(candidate);
    user = tentativeUser;
  }

  const estimatedInputTokens = assertWithinBudget("Event resolution prompt", system, user, promptTokenBudget);
  log("info", "Prepared bounded single-pass event enrichment", {
    promptTokenBudget,
    estimatedInputTokens,
    evidenceTokens: estimateModelTokens(input.evidence),
    baselineSourceTokens: baselineCompaction.stats.sourceTokens,
    baselineTokens: baselineCompaction.stats.estimatedTokens,
    baselineSelected: baselineCompaction.stats.selected,
    baselineDropped: baselineCompaction.stats.dropped,
    deterministicEntityQueries: queries.length,
    retrievedKnowledgeCandidates: candidateMap.size,
    selectedKnowledgeCandidates: knowledge.length,
  });

  const response = await llm.json(system, user, {
    maxOutputTokens: 4_096,
    schema: z.toJSONSchema(knowledgeEventEnrichmentSchema, { target: "draft-7" }) as Record<string, unknown>,
  });
  const patch = knowledgeEventEnrichmentSchema.parse(response.value);
  const sessionPatches = new Map(patch.sessions.map((item) => [item.externalKey, item]));
  const guestPatches = new Map(patch.guests.map((item) => [item.externalKey, item]));
  const activityPatches = new Map(patch.activities.map((item) => [item.externalKey, item]));
  const result = eventBundleSchema.parse({
    ...input.baseline,
    event: { ...input.baseline.event, ...patch.event },
    sessions: input.baseline.sessions.map((item) => ({ ...item, ...sessionPatches.get(item.externalKey) })),
    guests: input.baseline.guests.map((item) => ({ ...item, ...guestPatches.get(item.externalKey) })),
    activities: input.baseline.activities.map((item) => ({ ...item, ...activityPatches.get(item.externalKey) })),
    relatedSubjects: merge(input.baseline.relatedSubjects, patch.relatedSubjects, (item) => item.target.canonicalKey),
    relations: merge(input.baseline.relations, patch.relations, (item) => `${item.type}:${item.target.canonicalKey}`),
    warnings: [...new Set([...input.baseline.warnings, ...patch.warnings])]
      .filter((warning) => !warning.startsWith("Generated by deterministic fallback")),
  });
  return knowledgeEventResolutionResponseSchema.parse({
    result,
    knowledgeVersion,
    model: { provider: llm.providerName, name: llm.modelName, promptVersion: "event-enrichment-patch-v6" },
    metrics: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      estimatedInputTokens,
      evidenceTokens: estimateModelTokens(input.evidence),
      baselineTokens: baselineCompaction.stats.estimatedTokens,
      baselineSourceTokens: baselineCompaction.stats.sourceTokens,
      knowledgeCandidates: knowledge.length,
    },
  });
}
