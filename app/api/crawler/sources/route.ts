import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { createCrawlerSource } from "@/db/crawler";

const sourceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: z.string().url().max(2_000),
  connectorKey: z.enum(["website", "animecons"]).default("website"),
  trustLevel: z.enum(["OFFICIAL", "VERIFIED", "COMMUNITY"]),
  policyApproved: z.boolean(),
  reviewNote: z.string().trim().max(2_000),
  contactIdentity: z.string().trim().max(320),
  rootEventId: z.string().uuid().optional(),
  followOfficialSites: z.boolean().optional(),
  discoverLinkedEvents: z.boolean().optional(),
});

export async function POST(request: Request) {
  const denied = await requireApiAccess(request, "sources:write");
  if (denied) return denied;
  try {
    const input = sourceSchema.parse(await request.json());
    const source = await createCrawlerSource(input);
    return Response.json({ source }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: error.issues[0]?.message || "Invalid source" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Could not create source";
    const status = message.includes("already exists") ? 409 : 400;
    console.error("[api/crawler/sources] create failed", { error: message });
    return Response.json({ error: message }, { status });
  }
}
