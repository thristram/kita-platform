import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { getConsoleEventDetail, setConsoleEventStatus, updateConsoleEvent } from "@/db/events";

const eventUpdateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  eventType: z.enum(["CONVENTION", "CONCERT", "COSPLAY", "MEETUP", "POP_UP", "EXHIBITION", "DOUJIN", "SCREENING", "PANEL", "SIGNING", "OTHER"]),
  startAt: z.string().datetime().nullable(),
  endAt: z.string().datetime().nullable(),
  timezone: z.string().trim().min(1).max(120),
  officialUrl: z.union([z.literal(""), z.string().url().max(2_000)]),
  summary: z.string().trim().max(5_000),
  organizerNames: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  heroMediaCandidateId: z.string().uuid().nullable().optional(),
  venue: z.object({ name: z.string().trim().max(240), address: z.string().trim().max(500), city: z.string().trim().max(160), region: z.string().trim().max(160), countryCode: z.string().trim().max(2) }).optional(),
}).superRefine((value,context)=>{
  try { new Intl.DateTimeFormat("en",{timeZone:value.timezone}); } catch { context.addIssue({code:"custom",path:["timezone"],message:"Enter a valid timezone"}); }
  if (value.startAt && value.endAt && new Date(value.endAt)<new Date(value.startAt)) context.addIssue({code:"custom",path:["endAt"],message:"End must be after start"});
});

const statusSchema = z.object({ status: z.enum(["PUBLISHED", "DRAFT"]) });
const uuidSchema = z.string().uuid();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "events:write");
  if (denied) return denied;
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return Response.json({ error: "Invalid event id" }, { status: 400 });

  console.log("[api/events] incoming update", { eventId: id });
  try {
    const body: unknown = await request.json();
    const status = statusSchema.safeParse(body);
    if (status.success && typeof body === "object" && body !== null && Object.keys(body).length === 1) {
      await setConsoleEventStatus(id, status.data.status);
    } else {
      const update = eventUpdateSchema.parse(body);
      await updateConsoleEvent(id, update);
    }
    const event = await getConsoleEventDetail(id);
    if (!event) return Response.json({ error: "Event not found" }, { status: 404 });
    console.log("[api/events] update completed", { eventId: id, status: event.status });
    return Response.json({ event });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: error.issues[0]?.message || "Invalid event data" }, { status: 400 });
    }
    console.error("[api/events] update failed", { eventId: id, error: String(error) });
    return Response.json({ error: "Could not update event" }, { status: 500 });
  }
}
