import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { enqueueCandidateResolutionRetry } from "@/db/candidates";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "candidates:review");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  try {
    return Response.json(await enqueueCandidateResolutionRetry(id), { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue LLM resolution";
    if (message === "CANDIDATE_NOT_PENDING") return Response.json({ error: "Candidate is no longer available for resolution" }, { status: 409 });
    console.error("[api/candidates] LLM retry failed", { candidateId: id, error });
    return Response.json({ error: "Could not queue LLM resolution" }, { status: 500 });
  }
}
