import { listAccessControl } from "@/db/consoleAccess";
import { requireApiAccess } from "@/lib/consoleApiAccess";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, "access:manage");
  if (denied) return denied;
  try { return Response.json(await listAccessControl(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { console.error("[access] list failed", error); return Response.json({ error: "ACCESS_UNAVAILABLE" }, { status: 503 }); }
}
