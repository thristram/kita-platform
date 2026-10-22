import { filenameResolutionSchema, type FilenameResolution } from "@kita/contracts";
import { z } from "zod";
import type { BangumiSearchMatch, BangumiStore } from "../kb/store.js";
import type { JsonLlm } from "../llm/client.js";

const releaseTags = /\[[^\]]*\]/g;
const technicalTail = /\b(?:web[- .]?dl|webrip|bluray|bdrip|hevc|x26[45]|av1|aac|flac|1080p|2160p|720p|10bit|assx?\d*)\b.*$/i;

export interface FilenameRetrievalContext {
  input: string;
  titleQuery: string;
  seasonHint: number | null;
  episodeHint: number | null;
  matches: BangumiSearchMatch[];
}

const filenameDecisionSchema = z.object({
  normalizedTitle: z.string().min(1).max(500),
  season: z.number().int().positive().nullable(),
  episode: z.number().nonnegative().nullable(),
  selectedCanonicalKey: z.string().regex(/^bangumi:subject:\d+$/).nullable(),
  confidence: z.number().min(0).max(1),
});

export function retrieveReleaseFilenameContext(value: string, store: BangumiStore, limit: number): FilenameRetrievalContext {
  const base = value.replace(/\.(?:mkv|mp4|avi|mov|webm)$/i, "").replace(releaseTags, " ").replace(technicalTail, " ").replace(/[._]+/g, " ").trim();
  const seasonMatch = base.match(/(?:\bS(?:eason)?\s*|第\s*)(\d{1,2})(?:\s*季|\b)/i);
  const episodePatterns = [/(?:\bS\d{1,2}\s*)?E(?:P)?\s*(\d+(?:\.\d+)?)/i, /(?:^|\s)-\s*(\d+(?:\.\d+)?)(?:\s|$)/, /第\s*(\d+(?:\.\d+)?)\s*[话話集]/];
  const episodeMatch = episodePatterns.map((pattern) => base.match(pattern)).find(Boolean);
  let title = base;
  if (seasonMatch?.index !== undefined) title = title.slice(0, seasonMatch.index);
  if (episodeMatch?.index !== undefined) title = title.slice(0, episodeMatch.index);
  title = title.replace(/[-–—\s]+$/g, "").trim();
  return { input: value, titleQuery: title, seasonHint: seasonMatch ? Number(seasonMatch[1]) : null, episodeHint: episodeMatch ? Number(episodeMatch[1]) : null, matches: store.search(title, limit) };
}

export async function resolveReleaseFilename(value: string, store: BangumiStore, llm: JsonLlm, maxCandidates: number): Promise<FilenameResolution> {
  if (!store.size) throw new Error("Bangumi knowledge base is not ready");
  if (!llm.enabled) throw new Error("Local LLM is not configured");
  const context = retrieveReleaseFilenameContext(value, store, maxCandidates);
  const response = await llm.json(
    "Resolve one anime release filename using only the supplied Bangumi candidates. Return exactly one JSON object with normalizedTitle, season, episode, selectedCanonicalKey, and confidence. selectedCanonicalKey must exactly match one supplied candidate canonicalKey, or be null when none is supported. Do not invent IDs, candidates, seasons, or episode numbers. Use null when absent. Do not include reasoning, explanations, markdown, or extra fields.",
    JSON.stringify({ filename: context.input, retrievalHint: { title: context.titleQuery, season: context.seasonHint, episode: context.episodeHint }, bangumiCandidates: context.matches.map((match) => ({ canonicalKey: match.subject.canonicalKey, rawId: match.subject.rawId, name: match.name, nameCn: match.nameCn, retrievalScore: match.score })) }),
    { maxOutputTokens: 1_024 },
  );
  const decision = filenameDecisionSchema.parse(response.value);
  const selectedMatch = decision.selectedCanonicalKey ? context.matches.find((match) => match.subject.canonicalKey === decision.selectedCanonicalKey) || null : null;
  if (decision.selectedCanonicalKey && !selectedMatch) throw new Error(`LLM selected a Bangumi subject outside the retrieved candidates: ${decision.selectedCanonicalKey}`);
  return filenameResolutionSchema.parse({ input: value, normalizedTitle: decision.normalizedTitle, season: decision.season, episode: decision.episode, selectedMatch, matches: context.matches, resolutionMethod: "llm-kb", confidence: decision.confidence });
}
