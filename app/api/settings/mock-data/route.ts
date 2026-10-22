import { getConsumerMockDataVisibility, setConsumerMockDataVisibility } from "../../../../db/serving";
import { requireApiAccess } from "@/lib/consoleApiAccess";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, "console:read");
  if (denied) return denied;
  return Response.json({ enabled: await getConsumerMockDataVisibility() });
}

export async function POST(request: Request) {
  const denied = await requireApiAccess(request, "settings:write");
  if (denied) return denied;
  const payload = (await request.json()) as { enabled?: unknown };
  if (typeof payload.enabled !== "boolean") {
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  await setConsumerMockDataVisibility(payload.enabled);
  return Response.json({ enabled: payload.enabled });
}
