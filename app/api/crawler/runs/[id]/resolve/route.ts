import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { enqueueCrawlRunResolution } from "@/db/crawlerEvidence";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "jobs:write");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid crawl run id" }, { status: 400 });
  try { return Response.json(await enqueueCrawlRunResolution(id), { status: 202 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not enqueue resolution" }, { status: 400 }); }
}
