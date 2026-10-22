import { estimateModelTokens, type ResolutionDocument, type ResolutionInput } from "@kita/contracts";

export interface HydratedResolutionDocument extends ResolutionDocument {
  rawText: string;
}

type EvidenceKind = "assertions" | "chunks" | "media" | "rawText";

interface RankedEvidence {
  kind: EvidenceKind;
  document: HydratedResolutionDocument;
  key: string;
  score: number;
  value: unknown;
}

interface CompactedDocument {
  [key: string]: unknown;
  id: string;
  url: string;
  title: string;
  pageType: string;
  assertions: unknown[];
  chunks: unknown[];
  rawText: string;
  media: unknown[];
}

export interface EvidenceCompactionStats {
  tokenBudget: number;
  estimatedTokens: number;
  source: Record<EvidenceKind | "documents", number>;
  unique: Record<EvidenceKind | "documents", number>;
  selected: Record<EvidenceKind | "documents", number>;
  dropped: Record<EvidenceKind | "documents", number>;
}

export interface CompactedEventEvidence {
  evidence: {
    crawlRun: ResolutionInput["crawlRun"];
    documents: CompactedDocument[];
  };
  stats: EvidenceCompactionStats;
}

const pageWeight = (pageType: string): number => ({
  EVENT: 50,
  OVERVIEW: 45,
  ABOUT: 40,
  SCHEDULE: 38,
  GUESTS: 36,
  LOCATION: 34,
  SPONSORS: 30,
}[pageType.toUpperCase()] ?? 20);

const fieldWeight = (fieldPath: string): number => {
  const field = fieldPath.toLowerCase();
  if (/^(title|name|start_at|start_date|end_at|end_date|location|venue|official_url|url)$/.test(field)) return 80;
  if (/description|summary/.test(field)) return 72;
  if (/guest|performer|panel|screening|anime|manga|subject|character|sponsor|organizer/.test(field)) return 65;
  return 45;
};

const normalizeText = (value: string): string => value
  .normalize("NFKC")
  .toLocaleLowerCase()
  .replace(/https?:\/\/[^\s]+/g, (url) => {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      for (const key of [...parsed.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) parsed.searchParams.delete(key);
      }
      return parsed.toString();
    } catch {
      return url;
    }
  })
  .replace(/[\p{P}\p{S}\s]+/gu, " ")
  .trim();

const stableValue = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
};

const boundedValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return value.slice(0, 4_000);
  if (value === null || typeof value !== "object" || depth >= 3) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => boundedValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 30)
    .map(([key, item]) => [key, boundedValue(item, depth + 1)]));
};

const canonicalMediaKey = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|w|width|h|height|quality|format|fit)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$)/i, "");
    url.searchParams.sort();
    return url.toString();
  } catch {
    return rawUrl;
  }
};

const richerMedia = (left: ResolutionDocument["media"][number], right: ResolutionDocument["media"][number]): boolean => {
  const pixels = (value: ResolutionDocument["media"][number]) => (value.width || 0) * (value.height || 0);
  return left.score > right.score || (left.score === right.score && pixels(left) > pixels(right));
};

function rankedAssertions(documents: HydratedResolutionDocument[]): RankedEvidence[] {
  const unique = new Map<string, RankedEvidence>();
  for (const document of documents) {
    for (const assertion of document.assertions) {
      const normalized = assertion.normalizedValue ?? assertion.value;
      const normalizedItems = Array.isArray(normalized) ? normalized : [normalized];
      const rawItems = Array.isArray(assertion.value) ? assertion.value : [assertion.value];
      for (const [index, normalizedItem] of normalizedItems.entries()) {
        const rawItem = rawItems[index] ?? normalizedItem;
        const key = `${assertion.fieldPath.toLowerCase()}:${normalizeText(stableValue(normalizedItem))}`;
        const collectionValue = Array.isArray(normalized) ? [boundedValue(rawItem)] : boundedValue(rawItem);
        const collectionNormalized = Array.isArray(normalized) ? [boundedValue(normalizedItem)] : boundedValue(normalizedItem);
        const candidate: RankedEvidence = {
          kind: "assertions",
          document,
          key,
          score: 300 + fieldWeight(assertion.fieldPath) + pageWeight(document.pageType) + assertion.confidence * 40,
          value: {
            ...assertion,
            value: collectionValue,
            normalizedValue: collectionNormalized,
            locator: `${assertion.locator.slice(0, 460)}${Array.isArray(normalized) ? `[${index}]` : ""}`,
            excerpt: assertion.excerpt.slice(0, 1_000),
          },
        };
        const current = unique.get(key);
        if (!current || candidate.score > current.score) unique.set(key, candidate);
      }
    }
  }
  return [...unique.values()];
}

function rankedChunks(documents: HydratedResolutionDocument[]): RankedEvidence[] {
  const unique = new Map<string, RankedEvidence>();
  for (const document of documents) {
    for (const chunk of document.chunks) {
      const content = chunk.content.replace(/\s+/g, " ").trim().slice(0, 6_000);
      if (!content) continue;
      const normalized = normalizeText(content);
      const key = normalized.length > 2_000 ? `${normalized.slice(0, 1_000)}:${normalized.slice(-1_000)}` : normalized;
      const signal = /\b(20\d{2}|date|time|location|venue|guest|panel|screening|premiere|anime|manga|sponsor|exhibitor)\b/i.test(content) ? 20 : 0;
      const candidate: RankedEvidence = {
        kind: "chunks",
        document,
        key,
        score: 180 + pageWeight(document.pageType) + signal + Math.min(20, content.length / 300),
        value: { index: chunk.index, heading: chunk.heading.slice(0, 300), content },
      };
      const current = unique.get(key);
      if (!current || candidate.score > current.score) unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

function rankedMedia(documents: HydratedResolutionDocument[]): RankedEvidence[] {
  const unique = new Map<string, RankedEvidence & { value: ResolutionDocument["media"][number] }>();
  for (const document of documents) {
    for (const media of document.media) {
      if (/\b(icon|favicon|search|menu|arrow|social)\b/i.test(`${media.category} ${media.url}`)) continue;
      const key = canonicalMediaKey(media.url);
      const roleSignal = /hero|banner|poster|logo/i.test(media.category) ? 25 : 0;
      const candidate: RankedEvidence & { value: ResolutionDocument["media"][number] } = {
        kind: "media",
        document,
        key,
        score: 110 + pageWeight(document.pageType) + roleSignal + media.score * 30,
        value: media,
      };
      const current = unique.get(key);
      if (!current || richerMedia(media, current.value)) unique.set(key, candidate);
    }
  }
  return [...unique.values()].sort((left, right) => right.score - left.score || left.key.localeCompare(right.key)).slice(0, 40);
}

function fallbackRawText(documents: HydratedResolutionDocument[]): RankedEvidence[] {
  return documents.flatMap((document) => {
    if (document.assertions.length || document.chunks.length || !document.rawText.trim()) return [];
    const value = document.rawText.replace(/\s+/g, " ").trim().slice(0, 4_000);
    return [{
      kind: "rawText" as const,
      document,
      key: normalizeText(value),
      score: 60 + pageWeight(document.pageType),
      value,
    }];
  });
}

function emptyCounts(): Record<EvidenceKind | "documents", number> {
  return { documents: 0, assertions: 0, chunks: 0, media: 0, rawText: 0 };
}

/**
 * Selects deterministic, source-citable evidence before it crosses the
 * Resolution Agent -> Knowledge Service boundary.
 */
export function compactEventEvidence(input: ResolutionInput, documents: HydratedResolutionDocument[], tokenBudget: number): CompactedEventEvidence {
  const assertions = rankedAssertions(documents);
  const chunks = rankedChunks(documents);
  const media = rankedMedia(documents);
  const rawText = fallbackRawText(documents);
  const ranked = [...assertions, ...chunks, ...media, ...rawText]
    .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));

  const evidence: CompactedEventEvidence["evidence"] = { crawlRun: input.crawlRun, documents: [] };
  const selected = emptyCounts();
  const documentMap = new Map<string, CompactedDocument>();

  for (const item of ranked) {
    let compacted = documentMap.get(item.document.id);
    const created = !compacted;
    if (!compacted) {
      compacted = {
        id: item.document.id,
        url: item.document.canonicalUrl,
        title: item.document.title.slice(0, 500),
        pageType: item.document.pageType,
        assertions: [],
        chunks: [],
        rawText: "",
        media: [],
      };
      documentMap.set(item.document.id, compacted);
      evidence.documents.push(compacted);
    }

    const collection = item.kind === "rawText" ? null : compacted[item.kind];
    const previousRawText = compacted.rawText;
    if (collection) collection.push(item.value);
    else compacted.rawText = String(item.value);

    if (estimateModelTokens(evidence) > tokenBudget) {
      if (collection) collection.pop();
      else compacted.rawText = previousRawText;
      if (created) {
        documentMap.delete(item.document.id);
        evidence.documents.pop();
      }
      continue;
    }
    selected[item.kind] += 1;
  }

  if (!evidence.documents.length) {
    const document = documents[0];
    if (!document) throw new Error("Cannot compact an empty resolution input");
    evidence.documents.push({
      id: document.id,
      url: document.canonicalUrl,
      title: document.title.slice(0, 500),
      pageType: document.pageType,
      assertions: [],
      chunks: [],
      rawText: document.textPreview.slice(0, 1_000),
      media: [],
    });
    selected.rawText = document.textPreview ? 1 : 0;
  }

  evidence.documents.sort((left, right) => pageWeight(right.pageType) - pageWeight(left.pageType) || left.url.localeCompare(right.url));
  selected.documents = evidence.documents.length;

  const source = emptyCounts();
  source.documents = documents.length;
  source.assertions = documents.reduce((total, document) => total + document.assertions.reduce((count, assertion) => {
    const value = assertion.normalizedValue ?? assertion.value;
    return count + (Array.isArray(value) ? value.length : 1);
  }, 0), 0);
  source.chunks = documents.reduce((total, document) => total + document.chunks.length, 0);
  source.media = documents.reduce((total, document) => total + document.media.length, 0);
  source.rawText = documents.filter((document) => document.rawText.trim()).length;

  const unique = emptyCounts();
  unique.documents = new Set(ranked.map((item) => item.document.id)).size;
  unique.assertions = assertions.length;
  unique.chunks = chunks.length;
  unique.media = media.length;
  unique.rawText = rawText.length;

  const dropped = emptyCounts();
  for (const key of Object.keys(dropped) as Array<keyof typeof dropped>) dropped[key] = Math.max(0, source[key] - selected[key]);

  return {
    evidence,
    stats: {
      tokenBudget,
      estimatedTokens: estimateModelTokens(evidence),
      source,
      unique,
      selected,
      dropped,
    },
  };
}
