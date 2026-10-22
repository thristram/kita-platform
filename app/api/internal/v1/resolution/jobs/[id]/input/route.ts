import { z } from "zod";
import { getResolutionJobInput } from "@/db/resolutionAgent";
import { authorizeResolutionAgent } from "@/lib/resolutionAgentAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = authorizeResolutionAgent(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid job id" }, { status: 400 });
  const leaseToken = request.headers.get("x-lease-token") || "";
  try {
    const input = await getResolutionJobInput(id, leaseToken, new URL(request.url).origin);
    return input ? Response.json(input, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Lease is missing, invalid, or expired" }, { status: 409 });
  } catch (error) {
    console.error("[resolution-agent] input failed", error);
    return Response.json({ error: "Could not load resolution input" }, { status: 500 });
  }
}
