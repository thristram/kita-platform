import { z } from "zod";
import { getResolutionDocumentArtifact } from "@/db/resolutionAgent";
import { authorizeResolutionAgent } from "@/lib/resolutionAgentAuth";
import { createRawArtifactUrl } from "@/lib/r2";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  const unauthorized = authorizeResolutionAgent(request);
  if (unauthorized) return unauthorized;
  const { id, documentId } = await params;
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(documentId).success) {
    return Response.json({ error: "Invalid job or document id" }, { status: 400 });
  }
  const artifact = await getResolutionDocumentArtifact(id, documentId, request.headers.get("x-lease-token") || "");
  if (!artifact) return Response.json({ error: "Artifact is outside this lease" }, { status: 404 });
  const artifactMode = process.env.CRAWLER_ARTIFACT_MODE || ((process.env.R2_ENDPOINT_URL || process.env.R2_ENDPOINT) && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY ? "r2" : "local");
  if (artifactMode !== "local") {
    return Response.redirect(await createRawArtifactUrl(artifact.bucket, artifact.key), 302);
  }
  try {
    const [{ readFile }, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const root = path.resolve(process.cwd(), process.env.CRAWLER_ARTIFACT_ROOT || "var/crawler/artifacts");
    const rawRoot = path.resolve(root, "raw");
    const target = path.resolve(rawRoot, artifact.key);
    if (target !== rawRoot && !target.startsWith(`${rawRoot}${path.sep}`)) return Response.json({ error: "Invalid artifact path" }, { status: 400 });
    const bytes = await readFile(target);
    return new Response(bytes, { headers: { "Content-Type": artifact.mimeType, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[resolution-agent] local artifact read failed", error);
    return Response.json({ error: "Artifact is unavailable" }, { status: 404 });
  }
}
