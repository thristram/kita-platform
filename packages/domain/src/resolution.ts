import type { ManualOverrideMode } from "../../contracts/src";

export interface Assertion<T> {
  value: T;
  trust: number;
  confidence: number;
  observedAt: Date;
  sourceId: string;
}

export interface ManualOverride<T> {
  value: T;
  mode: ManualOverrideMode;
}

export interface Resolution<T> {
  value: T;
  origin: "AUTO" | "PREFERRED" | "PINNED";
  sourceId?: string;
  conflict: boolean;
}

export function resolveCanonicalField<T>(assertions: Assertion<T>[], override?: ManualOverride<T>): Resolution<T> | undefined {
  const ordered = [...assertions].sort((a, b) => (b.trust * b.confidence) - (a.trust * a.confidence) || b.observedAt.getTime() - a.observedAt.getTime());
  const best = ordered[0];
  if (override) {
    const conflict = Boolean(best && JSON.stringify(best.value) !== JSON.stringify(override.value));
    return { value: override.value, origin: override.mode, conflict };
  }
  if (!best) return undefined;
  return { value: best.value, origin: "AUTO", sourceId: best.sourceId, conflict: false };
}

export interface MediaCandidate {
  id: string;
  role: string;
  trust: number;
  width: number;
  height: number;
  classificationConfidence: number;
  pinned?: boolean;
}

export function resolveInternalCover(candidates: MediaCandidate[]): MediaCandidate | undefined {
  const roleWeight: Record<string, number> = { EVENT_HERO: 100, EVENT_POSTER: 92, PROVIDER: 78, FANDOM_POSTER: 65, ORGANIZATION_LOGO: 35 };
  return [...candidates].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const score = (item: MediaCandidate) => (roleWeight[item.role] ?? 20) + item.trust * 20 + item.classificationConfidence * 10 + Math.min(item.width * item.height / 1_000_000, 8);
    return score(b) - score(a);
  })[0];
}
