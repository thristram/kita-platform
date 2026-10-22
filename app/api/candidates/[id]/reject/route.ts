import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { recordCandidateReviewFailure, rejectCandidate } from "@/db/candidates";
import { candidateReviewFailure, reviewFailureResponse } from "@/lib/reviewErrors";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "candidates:review");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  try {
    await rejectCandidate(id);
    return Response.json({ status: "REJECTED" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "CANDIDATE_NOT_FOUND") return Response.json({ error: "Candidate not found" }, { status: 404 });
    if (message === "CANDIDATE_NOT_PENDING") return Response.json({ error: "Candidate has already been reviewed" }, { status: 409 });
    const failure = candidateReviewFailure("REJECT", error);
    await recordCandidateReviewFailure(id, failure).catch((persistenceError) => console.error("[api/candidates] could not persist reject failure", { candidateId: id, errorId: failure.errorId, persistenceError }));
    console.error("[api/candidates] reject failed", { candidateId: id, ...failure, error });
    return reviewFailureResponse(failure, "Could not reject candidate");
  }
}
