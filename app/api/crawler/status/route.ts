import { getCrawlerDashboardStatus } from "@/db/crawler";
import { requireApiAccess } from "@/lib/consoleApiAccess";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, "console:read");
  if (denied) return denied;
  try {
    return Response.json(await getCrawlerDashboardStatus(), {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    console.error("[api/crawler/status] query failed", { error: String(error) });
    return Response.json({ error: "Could not read crawler status" }, { status: 500 });
  }
}
