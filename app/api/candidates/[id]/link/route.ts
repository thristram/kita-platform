import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { clearCandidateReviewFailure, linkCandidateToEvent, recordCandidateReviewFailure } from "@/db/candidates";
import { candidateReviewFailure, reviewFailureResponse } from "@/lib/reviewErrors";

const schema = z.object({ eventId: z.string().uuid() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "candidates:review");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  try {
    const { eventId } = schema.parse(await request.json());
    const result = await linkCandidateToEvent(id, eventId);
    await clearCandidateReviewFailure(id).catch((error) => console.error("[api/candidates] could not clear prior link failure", { candidateId: id, error }));
    return Response.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Choose a valid event" }, { status: 400 });
    const message = error instanceof Error ? error.message : "";
    if (message === "CANDIDATE_NOT_FOUND" || message === "EVENT_OR_CANDIDATE_NOT_FOUND") return Response.json({ error: "Candidate or event not found" }, { status: 404 });
    if (message === "CANDIDATE_NOT_PENDING") return Response.json({ error: "Candidate has already been reviewed" }, { status: 409 });
    const failure = candidateReviewFailure("LINK", error);
    await recordCandidateReviewFailure(id, failure).catch((persistenceError) => console.error("[api/candidates] could not persist link failure", { candidateId: id, errorId: failure.errorId, persistenceError }));
    console.error("[api/candidates] link failed", { candidateId: id, ...failure, error });
    return reviewFailureResponse(failure, "Could not link candidate");
  }
}
