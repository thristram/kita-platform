import type { EventBundle } from "./resolution-agent.js";
import { estimateModelTokens } from "./token-budget.js";

export const EVENT_PROMPT_NON_EVIDENCE_RESERVE_TOKENS = 7_000;

export function eventPromptBaselineTokenBudget(promptTokenBudget: number): number {
  return Math.max(2_000, Math.min(8_000, Math.floor(promptTokenBudget * 0.35)));
}

export interface EventPromptBaselineStats {
  tokenBudget: number;
  sourceTokens: number;
  estimatedTokens: number;
  selected: Record<string, number>;
  dropped: Record<string, number>;
}

const shorten = (value: string, limit: number): string => value.slice(0, limit);
const sourced = <T extends { sourceDocumentIds: string[]; confidence: number }>(value: T): T => ({
  ...value,
  sourceDocumentIds: value.sourceDocumentIds.slice(0, 1),
});

/**
 * Builds a valid but bounded Event Bundle for an LLM prompt. The caller keeps
 * the complete deterministic bundle and restores records omitted here after
 * inference, so large media/evidence/activity collections never consume the
 * whole model context window.
 */
export function compactEventBaselineForPrompt(input: EventBundle, tokenBudget: number): {
  baseline: EventBundle;
  stats: EventPromptBaselineStats;
} {
  const firstEvidence = input.evidence[0];
  const baseline: EventBundle = {
    schemaVersion: "event-content-bundle/v2",
    event: {
      ...input.event,
      alternateNames: input.event.alternateNames.slice(0, 12).map((value) => shorten(value, 200)),
      description: shorten(input.event.description, 1_200),
      organizerNames: input.event.organizerNames.slice(0, 12).map((value) => shorten(value, 200)),
    },
    links: [],
    facts: [],
    ticketOffers: [],
    exhibitors: [],
    sessions: [],
    guests: [],
    updates: [],
    activities: [],
    relatedSubjects: [],
    relations: [],
    media: [],
    evidence: [{ ...firstEvidence, quote: shorten(firstEvidence.quote, 240) }],
    conflicts: [],
    warnings: [],
    confidence: input.confidence,
  };

  const selected: Record<string, number> = { evidence: 1 };
  const dropped: Record<string, number> = {};
  const add = <K extends keyof EventBundle>(key: K, value: EventBundle[K] extends Array<infer Item> ? Item : never): void => {
    const collection = baseline[key] as unknown as unknown[];
    collection.push(value);
    if (estimateModelTokens(baseline) > tokenBudget) {
      collection.pop();
      dropped[String(key)] = (dropped[String(key)] || 0) + 1;
    } else {
      selected[String(key)] = (selected[String(key)] || 0) + 1;
    }
  };

  const collections = {
    facts: input.facts.map((value) => ({ ...sourced(value), label: shorten(value.label, 200), value: typeof value.value === "string" ? shorten(value.value, 500) : value.value })),
    exhibitors: input.exhibitors.map((value) => ({ ...sourced(value), description: shorten(value.description, 320), categories: value.categories.slice(0, 8), organizationNames: value.organizationNames.slice(0, 8) })),
    sessions: input.sessions.map((value) => ({ ...sourced(value), description: shorten(value.description, 320), organizationNames: value.organizationNames.slice(0, 8), subjectTargets: value.subjectTargets.slice(0, 8), personTargets: value.personTargets.slice(0, 8), tags: value.tags.slice(0, 8) })),
    guests: input.guests.map((value) => ({ ...sourced(value), description: shorten(value.description, 320), organizationNames: value.organizationNames.slice(0, 8), subjectTargets: value.subjectTargets.slice(0, 8) })),
    updates: input.updates.map((value) => ({ ...sourced(value), summary: shorten(value.summary, 320) })),
    ticketOffers: input.ticketOffers.map((value) => ({ ...sourced(value), description: shorten(value.description, 320) })),
    relatedSubjects: input.relatedSubjects.map((value) => ({ ...sourced(value), description: shorten(value.description, 320) })),
    relations: input.relations.map((value) => ({ ...value, label: shorten(value.label, 200), evidenceDocumentIds: value.evidenceDocumentIds.slice(0, 1) })),
    activities: input.activities.map((value) => ({ ...sourced(value), description: shorten(value.description, 240), organizationNames: value.organizationNames.slice(0, 6), subjectTargets: value.subjectTargets.slice(0, 6), personTargets: value.personTargets.slice(0, 6), mediaCandidateIds: value.mediaCandidateIds.slice(0, 3) })),
    links: input.links.map((value) => ({ ...sourced(value), label: shorten(value.label, 200) })),
    media: input.media,
    evidence: input.evidence.slice(1).map((value) => ({ ...value, quote: shorten(value.quote, 240) })),
    conflicts: input.conflicts.map((value) => ({ ...value, values: value.values.slice(0, 3), resolution: shorten(value.resolution, 240) })),
  };
  const order = Object.keys(collections) as Array<keyof typeof collections>;
  let remaining = true;
  for (let index = 0; remaining; index += 1) {
    remaining = false;
    for (const key of order) {
      const value = collections[key][index] as never;
      if (value === undefined) continue;
      remaining = true;
      add(key, value);
    }
  }

  for (const key of ["links", "facts", "ticketOffers", "exhibitors", "sessions", "guests", "updates", "activities", "relatedSubjects", "relations", "media", "evidence", "conflicts"] as const) {
    dropped[key] = Math.max(dropped[key] || 0, input[key].length - (selected[key] || 0));
  }

  return {
    baseline,
    stats: {
      tokenBudget,
      sourceTokens: estimateModelTokens(input),
      estimatedTokens: estimateModelTokens(baseline),
      selected,
      dropped,
    },
  };
}
