import { eventBundleSchema } from "@kita/contracts";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { z } from "zod";
import { saveCandidateDraft } from "@/db/candidates";

const uuidSchema = z.string().uuid();

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "candidates:review");
  if (denied) return denied;
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  try {
    const body = await request.json() as { bundle?: unknown };
    const bundle = eventBundleSchema.parse(body.bundle);
    return Response.json(await saveCandidateDraft(id, bundle));
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      return Response.json({ error: `${issue?.path.join(".") || "bundle"}: ${issue?.message || "Invalid candidate draft"}`, errorCode: "INVALID_CANDIDATE_DRAFT" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Could not save candidate draft";
    if (message === "CANDIDATE_NOT_FOUND") return Response.json({ error: "Candidate not found" }, { status: 404 });
    if (message === "CANDIDATE_NOT_PENDING") return Response.json({ error: "Candidate has already been reviewed" }, { status: 409 });
    const errorId = crypto.randomUUID();
    console.error("[api/candidates] draft save failed", { candidateId: id, errorId, error });
    return Response.json({ error: "Could not save candidate draft", errorCode: "CANDIDATE_DRAFT_SAVE_FAILED", errorId }, { status: 500 });
  }
}
