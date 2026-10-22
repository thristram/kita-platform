import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { reviewCrawlerSource } from "@/db/crawler";

const reviewSchema = z.object({
  approved: z.boolean(),
  reviewNote: z.string().trim().max(2_000),
  contactIdentity: z.string().trim().max(320),
  maxDepth: z.number().int().min(0).max(8).optional(),
  maxPagesPerRun: z.number().int().min(1).max(2_000).optional(),
  followOfficialSites: z.boolean().optional(),
  discoverLinkedEvents: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "sources:write");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "Invalid source id" }, { status: 400 });
  }
  try {
    const input = reviewSchema.parse(await request.json());
    const source = await reviewCrawlerSource(id, input);
    return Response.json({ source });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: error.issues[0]?.message || "Invalid policy review" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Could not review source";
    return Response.json({ error: message }, { status: message === "Source not found" ? 404 : 400 });
  }
}
