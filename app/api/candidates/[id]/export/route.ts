import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { eventBundleSchema } from "@kita/contracts";
import { prepareResolutionEvidence } from "@kita/evidence-pipeline";
import { getCandidateExportScope } from "@/db/candidateTransfer";
import { readCrawlerArtifact } from "@/lib/crawlerArtifacts";
import { CODEX_EVENT_RESOLUTION_PROMPT } from "@/lib/codexEventPrompt";
import { createZip, type ZipEntry } from "@/lib/zip";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();
const stringify = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
const safe = (value: unknown): string => String(value || "document").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
const extension = (mime: unknown): string => {
  const value = String(mime || "").toLowerCase();
  if (value.includes("html")) return "html";
  if (value.includes("json")) return "json";
  if (value.includes("pdf")) return "pdf";
  if (value.includes("xml")) return "xml";
  return "txt";
};

async function mapConcurrent<T, R>(items: T[], concurrency: number, transform: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await transform(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "console:read");
  if (denied) return denied;
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  const scope = await getCandidateExportScope(id);
  if (!scope) return Response.json({ error: "Candidate not found" }, { status: 404 });
  const exportedDocuments = await mapConcurrent(scope.documents as Array<Record<string, unknown>>, 16, async (document, index) => {
    const filename = `documents/${String(index + 1).padStart(3, "0")}-${safe(document.title || document.id)}-${document.id}.${extension(document.mime_type)}`;
    const publicDocument = { ...document };
    delete publicDocument.r2_bucket;
    delete publicDocument.r2_key;
    try {
      return {
        entry: { name: filename, data: await readCrawlerArtifact(String(document.r2_bucket), String(document.r2_key)) } satisfies ZipEntry,
        manifest: { ...publicDocument, documentFile: filename, artifactAvailable: true },
      };
    } catch (error) {
      const errorFile = `${filename}.unavailable.txt`;
      return {
        entry: { name: errorFile, data: `Raw artifact could not be included: ${error instanceof Error ? error.message : String(error)}` } satisfies ZipEntry,
        manifest: { ...publicDocument, documentFile: errorFile, artifactAvailable: false },
      };
    }
  });
  const entries: ZipEntry[] = exportedDocuments.map((item) => item.entry);
  const manifestDocuments: Array<Record<string, unknown>> = exportedDocuments.map((item) => item.manifest);

  const candidate = scope.candidate as Record<string, unknown>;
  const assertions = scope.assertions as Array<Record<string, unknown>>;
  const chunks = scope.chunks as Array<Record<string, unknown>>;
  const media = scope.media as Array<Record<string, unknown>>;
  const resolutionInput = {
    contractVersion: "1.0" as const,
    jobId: String(candidate.job_id),
    crawlRun: {
      id: String(candidate.crawl_run_id), sourceId: String(candidate.source_id), sourceName: String(candidate.source_name || "Unknown source"),
      rootUrl: String(candidate.base_url), rootEventId: null,
    },
    documents: manifestDocuments.map((document) => {
      const documentId = String(document.id);
      return {
        id: documentId, canonicalUrl: String(document.canonical_url), title: String(document.title || ""), pageType: String(document.page_type || "OTHER"),
        mimeType: String(document.mime_type || "application/octet-stream"), fetchedAt: new Date(String(document.fetched_at)).toISOString(), contentHash: document.content_hash ? String(document.content_hash) : undefined, textPreview: String(document.text_preview || ""),
        contentUrl: `https://kitacon.invalid/evidence/${documentId}`,
        assertions: assertions.filter((item) => String(item.raw_document_id) === documentId).map((item) => ({
          id: String(item.id), fieldPath: String(item.field_path), value: item.value_json, normalizedValue: item.normalized_value_json,
          confidence: Number(item.confidence || 0), locator: String(item.evidence_locator || ""), excerpt: String(item.evidence_excerpt || ""),
        })),
        chunks: chunks.filter((item) => String(item.raw_document_id) === documentId).map((item) => ({ index: Number(item.chunk_index), heading: String(item.heading_path || ""), content: String(item.content || "") })),
        media: media.filter((item) => String(item.raw_document_id) === documentId).map((item) => ({
          id: String(item.id), url: String(item.resolved_url), category: String(item.category || "OTHER"), score: Number(item.classification_score || 0),
          width: item.width === null ? null : Number(item.width), height: item.height === null ? null : Number(item.height), mimeType: item.mime_type ? String(item.mime_type) : null,
        })),
      };
    }),
  };
  const preparedEvidence = prepareResolutionEvidence(resolutionInput);
  const manifest = {
    exportVersion: preparedEvidence.schemaVersion,
    evidencePipelineVersion: preparedEvidence.pipelineVersion,
    evidenceInputHash: preparedEvidence.inputHash,
    exportedAt: new Date().toISOString(),
    candidate: {
      id: String(candidate.id),createdAt: candidate.created_at,confidence: candidate.confidence,jobId: candidate.job_id,
      crawlRunId: candidate.crawl_run_id,sourceId: candidate.source_id,sourceName: candidate.source_name,sourceUrl: candidate.base_url,
    },
    instructions: "Upload this ZIP to Codex. Read prepared/summary.json and prepared/collections.json first; open raw documents only to resolve gaps or verify provenance. Paste PROMPT.md and return event-bundle.json to KitaCon's Import JSON action.",
    documents: manifestDocuments,
    preparationStats: preparedEvidence.stats,
    structuredFiles: ["prepared/summary.json", "prepared/collections.json", "prepared/conflicts.json", "structured/assertions.json", "structured/chunks.json", "structured/media.json"],
    resolutionFiles: ["resolution/original-result.json", "event-bundle.schema.json"],
  };
  entries.unshift(
    { name: "README.md", data: "# KitaCon Candidate Evidence Bundle v2\n\nThis archive is lossless: `documents/` contains the original captured artifacts. The deterministic evidence-preparation stage creates deduplicated, provenance-preserving indexes under `prepared/`.\n\n1. Upload this ZIP to Codex.\n2. Paste the contents of `PROMPT.md`.\n3. Codex should read `prepared/summary.json` and `prepared/collections.json` first, then open only the raw files needed to fill gaps or verify claims.\n4. Save the JSON-only response as `event-bundle.json`.\n5. In KitaCon, open the Candidate and choose **Import JSON**.\n" },
    { name: "PROMPT.md", data: CODEX_EVENT_RESOLUTION_PROMPT },
    { name: "manifest.json", data: stringify(manifest) },
    { name: "event-bundle.schema.json", data: stringify(z.toJSONSchema(eventBundleSchema, { target: "draft-7" })) },
    { name: "prepared/summary.json", data: stringify({ schemaVersion: preparedEvidence.schemaVersion, pipelineVersion: preparedEvidence.pipelineVersion, preparedAt: preparedEvidence.preparedAt, inputHash: preparedEvidence.inputHash, stats: preparedEvidence.stats, documentGroups: preparedEvidence.documentGroups, assertions: preparedEvidence.assertions, chunks: preparedEvidence.chunks, media: preparedEvidence.media, warnings: preparedEvidence.warnings }) },
    { name: "prepared/collections.json", data: stringify(preparedEvidence.collections) },
    { name: "prepared/conflicts.json", data: stringify(preparedEvidence.conflicts) },
    { name: "structured/assertions.json", data: stringify(scope.assertions) },
    { name: "structured/chunks.json", data: stringify(scope.chunks) },
    { name: "structured/media.json", data: stringify(scope.media) },
    { name: "resolution/original-result.json", data: stringify(candidate.payload) },
  );
  const zip = createZip(entries);
  const responseBody = new Uint8Array(zip.byteLength);
  responseBody.set(zip);
  const title = safe((candidate.payload as { result?: { event?: { name?: string } } } | null)?.result?.event?.name || candidate.source_name || id);
  return new Response(responseBody.buffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${title}-candidate-evidence.zip"`,
      "Cache-Control": "private, no-store",
      "Content-Length": String(zip.byteLength),
    },
  });
}
