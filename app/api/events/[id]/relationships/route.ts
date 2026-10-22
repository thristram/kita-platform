import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { addConsoleEventRelation, getConsoleEventDetail, removeConsoleEventRelation } from "@/db/events";

const relationSchema = z.object({
  entityId: z.string().uuid(),
  relationType: z.enum(["FEATURES", "ORGANIZED_BY", "SPONSORED_BY", "APPEARANCE"]),
});

async function mutate(
  request: Request,
  params: Promise<{ id: string }>,
  operation: "add" | "remove",
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid event id" }, { status: 400 });

  try {
    const relation = relationSchema.parse(await request.json());
    if (operation === "add") await addConsoleEventRelation(id, relation.entityId, relation.relationType);
    else await removeConsoleEventRelation(id, relation.entityId, relation.relationType);
    const event = await getConsoleEventDetail(id);
    if (!event) return Response.json({ error: "Event not found" }, { status: 404 });
    return Response.json({ event });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: error.issues[0]?.message || "Invalid relationship" }, { status: 400 });
    }
    console.error("[api/events/relationships] mutation failed", { eventId: id, operation, error: String(error) });
    return Response.json({ error: "Could not update relationship" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "events:write");
  if (denied) return denied;
  return mutate(request, params, "add");
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "events:write");
  if (denied) return denied;
  return mutate(request, params, "remove");
}
