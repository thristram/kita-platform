import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { getReviewCandidate } from "@/db/candidates";

const uuidSchema = z.string().uuid();

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "console:read");
  if (denied) return denied;
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return Response.json({ error: "Invalid candidate id" }, { status: 400 });
  try {
    const candidate = await getReviewCandidate(id);
    if (!candidate) return Response.json({ error: "Candidate not found" }, { status: 404 });
    return Response.json({ candidate });
  } catch (error) {
    console.error("[api/candidates] detail failed", { candidateId: id, error });
    return Response.json({ error: "Could not load candidate" }, { status: 500 });
  }
}
