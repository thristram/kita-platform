import { heartbeatRequestSchema } from "@kita/contracts";
import { heartbeatResolutionJob } from "@/db/resolutionAgent";
import { authorizeResolutionAgent } from "@/lib/resolutionAgentAuth";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = authorizeResolutionAgent(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const parsed = heartbeatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid heartbeat request" }, { status: 400 });
  try {
    const result = await heartbeatResolutionJob(id, parsed.data.leaseToken, parsed.data.extendBySeconds);
    return result ? Response.json(result) : Response.json({ error: "Lease is missing, invalid, or expired" }, { status: 409 });
  } catch (error) {
    console.error("[resolution-agent] heartbeat failed", error);
    return Response.json({ error: "Could not extend lease" }, { status: 500 });
  }
}
