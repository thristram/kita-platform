import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { importCandidateBundle } from "@/db/candidateTransfer";

const bodySchema = z.object({ bundle: z.unknown(), filename: z.string().max(240).optional() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "candidates:review");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  try {
    const body = bodySchema.parse(await request.json());
    const result = await importCandidateBundle(id, body.bundle, body.filename);
    return Response.json({ ...result, processingMode: "MANUAL_JSON" });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: error.issues[0]?.message || "JSON does not match Event Content Bundle v2" }, { status: 400 });
    const message = error instanceof Error ? error.message : "Could not import JSON";
    const status = /NOT_PENDING/.test(message) ? 409 : /UNKNOWN_SOURCE_DOCUMENT_IDS/.test(message) ? 422 : 500;
    console.error("[api/candidates] JSON import failed", { candidateId: id, error });
    return Response.json({ error: message }, { status });
  }
}
