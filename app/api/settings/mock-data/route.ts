import { getConsumerMockDataVisibility, setConsumerMockDataVisibility } from "../../../../db/serving";

export async function GET() {
  return Response.json({ enabled: await getConsumerMockDataVisibility() });
}

export async function POST(request: Request) {
  const payload = (await request.json()) as { enabled?: unknown };
  if (typeof payload.enabled !== "boolean") {
    return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  await setConsumerMockDataVisibility(payload.enabled);
  return Response.json({ enabled: payload.enabled });
}
