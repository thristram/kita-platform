import type { ResolutionDocument, ResolutionInput } from "@kita/contracts";

export const EVIDENCE_BUNDLE_VERSION = "candidate-evidence-bundle/v2" as const;
export const EVIDENCE_PIPELINE_VERSION = "evidence-preparation/v1" as const;

const normalizedText = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
const stableValue = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(",")}}`;
};
const fingerprint = (value: string): string => {
  let hash = 2166136261;
  for (const character of value) { hash ^= character.codePointAt(0) || 0; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
};
const omitKeys = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as K))) as Omit<T, K>;

export const canonicalMediaUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid|mc_|w|width|h|height|quality|format|fit)/i.test(key)) url.searchParams.delete(key);
    url.pathname = url.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$)/i, "");
    url.searchParams.sort();
    return url.toString();
  } catch { return raw; }
};

type PreparedAssertion = ResolutionDocument["assertions"][number] & { sourceDocumentIds: string[]; occurrences: number };
type PreparedChunk = ResolutionDocument["chunks"][number] & { sourceDocumentIds: string[]; occurrences: number };
type PreparedMedia = ResolutionDocument["media"][number] & { sourceDocumentIds: string[]; aliases: string[]; occurrences: number };

export interface EvidencePreparationStats {
  input: { documents: number; assertions: number; chunks: number; media: number };
  prepared: { documents: number; assertions: number; chunks: number; media: number; collections: number };
  removed: { documents: number; assertions: number; chunks: number; media: number };
}

export interface PreparedEvidence {
  schemaVersion: typeof EVIDENCE_BUNDLE_VERSION;
  pipelineVersion: typeof EVIDENCE_PIPELINE_VERSION;
  preparedAt: string;
  inputHash: string;
  stats: EvidencePreparationStats;
  documentGroups: Array<{ canonicalDocumentId: string; documentIds: string[]; canonicalUrl: string; title: string; pageType: string }>;
  assertions: PreparedAssertion[];
  chunks: PreparedChunk[];
  media: PreparedMedia[];
  collections: Record<string, Array<Record<string, unknown> & { sourceDocumentIds: string[]; occurrences: number }>>;
  conflicts: Array<{ fieldPath: string; values: Array<{ value: unknown; sourceDocumentIds: string[] }> }>;
  warnings: string[];
}

function richerMedia(left: ResolutionDocument["media"][number], right: ResolutionDocument["media"][number]): boolean {
  const pixels = (item: ResolutionDocument["media"][number]) => (item.width || 0) * (item.height || 0);
  return left.score > right.score || (left.score === right.score && pixels(left) > pixels(right));
}

function collectionKey(value: Record<string, unknown>): string {
  const explicit = value.externalKey ?? value.id ?? value.uuid;
  if (explicit) return normalizedText(String(explicit));
  return normalizedText([value.name ?? value.title, value.startDate ?? value.start, value.room ?? value.booth ?? value.location].filter(Boolean).join("|"));
}

export function prepareResolutionEvidence(input: ResolutionInput, now = new Date().toISOString()): PreparedEvidence {
  const documentGroups = new Map<string, PreparedEvidence["documentGroups"][number]>();
  const assertionMap = new Map<string, PreparedAssertion>();
  const chunkMap = new Map<string, PreparedChunk>();
  const mediaMap = new Map<string, PreparedMedia>();
  const collections = new Map<string, Map<string, Record<string, unknown> & { sourceDocumentIds: string[]; occurrences: number }>>();
  const fieldValues = new Map<string, Map<string, { value: unknown; sourceDocumentIds: string[] }>>();

  for (const document of input.documents) {
    const documentKey = document.contentHash ? `sha256:${document.contentHash}` : fingerprint(`${document.canonicalUrl}|${normalizedText(document.textPreview || document.title)}`);
    const group = documentGroups.get(documentKey);
    if (group) group.documentIds.push(document.id);
    else documentGroups.set(documentKey, { canonicalDocumentId: document.id, documentIds: [document.id], canonicalUrl: document.canonicalUrl, title: document.title, pageType: document.pageType });

    for (const assertion of document.assertions) {
      const value = assertion.normalizedValue ?? assertion.value;
      const key = `${assertion.fieldPath.toLocaleLowerCase()}:${fingerprint(normalizedText(stableValue(value)))}`;
      const existing = assertionMap.get(key);
      if (existing) {
        if (!existing.sourceDocumentIds.includes(document.id)) existing.sourceDocumentIds.push(document.id);
        existing.occurrences += 1;
        if (assertion.confidence > existing.confidence) Object.assign(existing, assertion, { sourceDocumentIds: existing.sourceDocumentIds, occurrences: existing.occurrences });
      } else assertionMap.set(key, { ...assertion, sourceDocumentIds: [document.id], occurrences: 1 });

      const values = fieldValues.get(assertion.fieldPath) || new Map();
      const valueKey = fingerprint(normalizedText(stableValue(value)));
      const source = values.get(valueKey);
      if (source) { if (!source.sourceDocumentIds.includes(document.id)) source.sourceDocumentIds.push(document.id); }
      else values.set(valueKey, { value, sourceDocumentIds: [document.id] });
      fieldValues.set(assertion.fieldPath, values);

      if (assertion.fieldPath.startsWith("content.") && Array.isArray(value)) {
        const records = collections.get(assertion.fieldPath) || new Map();
        for (const item of value) {
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const recordKey = collectionKey(record);
          if (!recordKey) continue;
          const current = records.get(recordKey);
          if (current) {
            for (const [field, fieldValue] of Object.entries(record)) if ((current[field] === undefined || current[field] === "" || current[field] === null) && fieldValue !== undefined) current[field] = fieldValue;
            if (!current.sourceDocumentIds.includes(document.id)) current.sourceDocumentIds.push(document.id);
            current.occurrences += 1;
          } else records.set(recordKey, { ...record, sourceDocumentIds: [document.id], occurrences: 1 });
        }
        collections.set(assertion.fieldPath, records);
      }
    }

    for (const chunk of document.chunks) {
      const content = chunk.content.replace(/\s+/g, " ").trim();
      if (!content) continue;
      const normalized = normalizedText(content).replace(/\b\d{1,2}:\d{2}\b/g, "<time>");
      const key = fingerprint(`${normalized.slice(0, 2_000)}|${normalized.slice(-500)}`);
      const existing = chunkMap.get(key);
      if (existing) { if (!existing.sourceDocumentIds.includes(document.id)) existing.sourceDocumentIds.push(document.id); existing.occurrences += 1; }
      else chunkMap.set(key, { ...chunk, content, sourceDocumentIds: [document.id], occurrences: 1 });
    }

    for (const media of document.media) {
      const key = canonicalMediaUrl(media.url);
      const existing = mediaMap.get(key);
      if (existing) {
        if (!existing.sourceDocumentIds.includes(document.id)) existing.sourceDocumentIds.push(document.id);
        if (!existing.aliases.includes(media.url)) existing.aliases.push(media.url);
        existing.occurrences += 1;
        if (richerMedia(media, existing)) Object.assign(existing, media, { sourceDocumentIds: existing.sourceDocumentIds, aliases: existing.aliases, occurrences: existing.occurrences });
      } else mediaMap.set(key, { ...media, url: key, sourceDocumentIds: [document.id], aliases: media.url === key ? [] : [media.url], occurrences: 1 });
    }
  }

  const counts = {
    documents: input.documents.length,
    assertions: input.documents.reduce((sum, document) => sum + document.assertions.length, 0),
    chunks: input.documents.reduce((sum, document) => sum + document.chunks.length, 0),
    media: input.documents.reduce((sum, document) => sum + document.media.length, 0),
  };
  const preparedCollections = Object.fromEntries([...collections].sort(([a], [b]) => a.localeCompare(b)).map(([field, values]) => [field, [...values.values()]]));
  const preparedCounts = { documents: documentGroups.size, assertions: assertionMap.size, chunks: chunkMap.size, media: mediaMap.size, collections: Object.values(preparedCollections).reduce((sum, records) => sum + records.length, 0) };
  const conflicts = [...fieldValues].filter(([field, values]) => values.size > 1 && !field.startsWith("content.")).map(([fieldPath, values]) => ({ fieldPath, values: [...values.values()] }));
  const inputHash = fingerprint(input.documents.map((document) => `${document.id}:${document.canonicalUrl}:${document.assertions.length}:${document.chunks.length}:${document.media.length}`).join("|"));
  return {
    schemaVersion: EVIDENCE_BUNDLE_VERSION,
    pipelineVersion: EVIDENCE_PIPELINE_VERSION,
    preparedAt: now,
    inputHash,
    stats: { input: counts, prepared: preparedCounts, removed: { documents: counts.documents - preparedCounts.documents, assertions: counts.assertions - preparedCounts.assertions, chunks: counts.chunks - preparedCounts.chunks, media: counts.media - preparedCounts.media } },
    documentGroups: [...documentGroups.values()], assertions: [...assertionMap.values()], chunks: [...chunkMap.values()], media: [...mediaMap.values()], collections: preparedCollections, conflicts,
    warnings: [...documentGroups.values()].filter((group) => group.documentIds.length > 1).map((group) => `Collapsed ${group.documentIds.length} equivalent documents for ${group.canonicalUrl}`),
  };
}

export function applyPreparedEvidence(input: ResolutionInput, prepared: PreparedEvidence): ResolutionInput {
  const canonicalDocuments = new Map(prepared.documentGroups.map((group) => [group.canonicalDocumentId, group]));
  return {
    ...input,
    documents: input.documents.filter((document) => canonicalDocuments.has(document.id)).map((document) => {
      const group = canonicalDocuments.get(document.id)!;
      const assertions = prepared.assertions.filter((item) => !item.fieldPath.startsWith("content.") && item.sourceDocumentIds.some((id) => group.documentIds.includes(id))).map((item) => omitKeys(item, ["sourceDocumentIds", "occurrences"] as const));
      for (const [fieldPath, records] of Object.entries(prepared.collections)) {
        const selected = records.filter((record) => record.sourceDocumentIds.some((id) => group.documentIds.includes(id)));
        if (!selected.length) continue;
        const source = prepared.assertions.find((item) => item.fieldPath === fieldPath && item.sourceDocumentIds.some((id) => group.documentIds.includes(id)));
        if (!source) continue;
        const values = selected.map((record) => omitKeys(record, ["sourceDocumentIds", "occurrences"] as const));
        assertions.push({ ...omitKeys(source, ["sourceDocumentIds", "occurrences"] as const), value: values, normalizedValue: values });
      }
      return {
        ...document,
        assertions,
        chunks: prepared.chunks.filter((item) => item.sourceDocumentIds.some((id) => group.documentIds.includes(id))).map((item) => omitKeys(item, ["sourceDocumentIds", "occurrences"] as const)),
        media: prepared.media.filter((item) => item.sourceDocumentIds.some((id) => group.documentIds.includes(id))).map((item) => omitKeys(item, ["sourceDocumentIds", "aliases", "occurrences"] as const)),
      };
    }),
  };
}
