import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { getLatestResolutionStatus, listReviewCandidates } from "@/db/candidates";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, "console:read");
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const query = querySchema.parse({ status: url.searchParams.get("status") || undefined, limit: url.searchParams.get("limit") || undefined });
    const [candidates, resolution] = await Promise.all([listReviewCandidates(query.status, query.limit), getLatestResolutionStatus()]);
    return Response.json({ candidates, resolution });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Invalid candidate query" }, { status: 400 });
    console.error("[api/candidates] list failed", error);
    return Response.json({ error: "Could not load candidates" }, { status: 500 });
  }
}
