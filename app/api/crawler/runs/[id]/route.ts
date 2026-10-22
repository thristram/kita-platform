import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { getCrawlRunDetail } from "@/db/crawlerEvidence";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(_request, "console:read");
  if (denied) return denied;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid crawl run id" }, { status: 400 });
  const detail = await getCrawlRunDetail(id);
  return detail ? Response.json(detail, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Crawl run not found" }, { status: 404 });
}
