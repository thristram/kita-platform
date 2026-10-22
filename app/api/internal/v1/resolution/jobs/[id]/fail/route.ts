import { failureRequestSchema } from "@kita/contracts";
import { failResolutionJob } from "@/db/resolutionAgent";
import { authorizeResolutionAgent } from "@/lib/resolutionAgentAuth";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = authorizeResolutionAgent(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const parsed = failureRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid failure payload" }, { status: 400 });
  try {
    const result = await failResolutionJob(id, parsed.data.leaseToken, parsed.data.errorCode, parsed.data.message, parsed.data.retryable);
    return result ? Response.json(result) : Response.json({ error: "Lease is missing, invalid, or expired" }, { status: 409 });
  } catch (error) {
    console.error("[resolution-agent] failure reporting failed", error);
    return Response.json({ error: "Could not report job failure" }, { status: 500 });
  }
}
