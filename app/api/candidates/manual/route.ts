import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { createManualCandidate } from "@/db/candidateTransfer";

const bodySchema = z.object({ sourceId: z.string().uuid(), name: z.string().trim().min(1).max(240), bundle: z.unknown().optional() });

export async function POST(request: Request) {
  const denied = await requireApiAccess(request, "events:write");
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await request.json());
    return Response.json(await createManualCandidate(body), { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: error.issues[0]?.message || "Invalid manual event" }, { status: 400 });
    const message = error instanceof Error ? error.message : "Could not create manual event draft";
    const status = /SOURCE_NOT_FOUND/.test(message) ? 404 : /SOURCE_HAS_NO|UNKNOWN_SOURCE_DOCUMENT_IDS/.test(message) ? 422 : 500;
    console.error("[api/candidates] manual candidate failed", error);
    return Response.json({ error: message }, { status });
  }
}
