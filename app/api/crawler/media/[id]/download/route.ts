import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { getMediaArtifactMetadata } from "@/db/crawlerEvidence";
import { createArtifactUrl } from "@/lib/r2";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "console:read");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid media asset id" }, { status: 400 });
  const artifact = await getMediaArtifactMetadata(id);
  if (!artifact) return Response.json({ error: "Media artifact not found" }, { status: 404 });
  try { return Response.redirect(await createArtifactUrl(artifact.bucket, artifact.key), 302); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not sign artifact" }, { status: 503 }); }
}
