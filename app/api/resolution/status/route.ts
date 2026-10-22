import { getResolutionDashboardStatus } from "@/db/resolutionDashboard";
import { requireApiAccess } from "@/lib/consoleApiAccess";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, "console:read");
  if (denied) return denied;
  try {
    return Response.json(await getResolutionDashboardStatus());
  } catch (error) {
    console.error("[api/resolution/status] failed", error);
    return Response.json({ error: "Could not load resolution jobs" }, { status: 500 });
  }
}
