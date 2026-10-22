import { enqueueSourceCrawl } from "@/db/crawler";
import { requireApiAccess } from "@/lib/consoleApiAccess";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "jobs:write");
  if (denied) return denied;
  const { id } = await context.params;
  try {
    return Response.json(await enqueueSourceCrawl(id), { status: 202 });
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } } | null)?.cause;
    console.error("[api/crawler/sources/:id/run] enqueue failed", {
      sourceId: id,
      error: cause?.message || (error instanceof Error ? error.message : "Unknown error"),
      code: cause?.code,
    });
    const message = error instanceof Error && [
      "Source not found",
      "Source is disabled. Review and enable its policy first.",
      "Source terms must be REVIEWED_ALLOWED before crawling.",
      "Source has no seed URL",
    ].includes(error.message) ? error.message : "Unable to queue this crawl. Check the server log for the database error.";
    return Response.json({ error: message }, { status: message === "Source not found" ? 404 : 400 });
  }
}
