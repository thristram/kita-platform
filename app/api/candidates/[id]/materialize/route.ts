import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { clearCandidateReviewFailure, materializeCandidate, recordCandidateReviewFailure } from "@/db/candidates";
import { candidateReviewFailure, reviewFailureResponse } from "@/lib/reviewErrors";

const schema = z.object({
  title: z.string().trim().min(1).max(240),
  eventType: z.enum(["CONVENTION", "CONCERT", "COSPLAY", "MEETUP", "POP_UP", "EXHIBITION", "DOUJIN", "SCREENING", "PANEL", "SIGNING", "OTHER"]),
  startAt: z.union([z.literal(""), z.string().datetime({ offset: true })]),
  endAt: z.union([z.literal(""), z.string().datetime({ offset: true })]),
  timezone: z.string().trim().min(1).max(120),
  officialUrl: z.union([z.literal(""), z.string().url().max(2_000)]),
  summary: z.string().trim().max(5_000),
  venueName: z.string().trim().max(240),
  addressLine1: z.string().trim().max(500),
  city: z.string().trim().max(160),
  region: z.string().trim().max(160),
  countryCode: z.string().trim().max(2),
  postalCode: z.string().trim().max(40),
}).superRefine((value, context) => {
  if (value.startAt && value.endAt && new Date(value.endAt) < new Date(value.startAt)) {
    context.addIssue({ code: "custom", path: ["endAt"], message: "End date must be after start date" });
  }
});

const uuidSchema = z.string().uuid();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "candidates:review");
  if (denied) return denied;
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  try {
    const input = schema.parse(await request.json());
    const result = await materializeCandidate(id, input);
    await clearCandidateReviewFailure(id).catch((error) => console.error("[api/candidates] could not clear prior materialize failure", { candidateId: id, error }));
    return Response.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: error.issues[0]?.message || "Invalid event data" }, { status: 400 });
    const message = error instanceof Error ? error.message : "";
    if (message === "CANDIDATE_NOT_FOUND") return Response.json({ error: "Candidate not found" }, { status: 404 });
    if (message === "CANDIDATE_NOT_PENDING") return Response.json({ error: "Candidate has already been reviewed" }, { status: 409 });
    const failure = candidateReviewFailure("MATERIALIZE", error);
    await recordCandidateReviewFailure(id, failure).catch((persistenceError) => console.error("[api/candidates] could not persist materialize failure", { candidateId: id, errorId: failure.errorId, persistenceError }));
    console.error("[api/candidates] materialize failed", { candidateId: id, ...failure, error });
    return reviewFailureResponse(failure, "Could not create review event");
  }
}
