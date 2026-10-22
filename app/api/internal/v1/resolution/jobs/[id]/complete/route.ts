import { completionRequestSchema } from "@kita/contracts";
import { completeResolutionJob } from "@/db/resolutionAgent";
import { authorizeResolutionAgent } from "@/lib/resolutionAgentAuth";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = authorizeResolutionAgent(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const parsed = completionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid completion payload", details: parsed.error.flatten() }, { status: 400 });
  try {
    const result = await completeResolutionJob(id, parsed.data);
    return result ? Response.json(result) : Response.json({ error: "Lease is missing, invalid, or expired" }, { status: 409 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RESULT_")) return Response.json({ error: error.message }, { status: 422 });
    console.error("[resolution-agent] completion failed", error);
    return Response.json({ error: "Could not persist resolution result" }, { status: 500 });
  }
}
