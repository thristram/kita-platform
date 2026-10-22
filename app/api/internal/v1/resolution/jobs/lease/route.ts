import { leaseRequestSchema } from "@kita/contracts";
import { leaseResolutionJob } from "@/db/resolutionAgent";
import { authorizeResolutionAgent } from "@/lib/resolutionAgentAuth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = authorizeResolutionAgent(request);
  if (unauthorized) return unauthorized;
  const parsed = leaseRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid lease request", details: parsed.error.flatten() }, { status: 400 });
  try {
    const job = await leaseResolutionJob(parsed.data);
    return Response.json({ contractVersion: "1.0", job, ...(job ? {} : { retryAfterMs: 10_000 }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[resolution-agent] lease failed", error);
    return Response.json({ error: "Could not lease a resolution job" }, { status: 500 });
  }
}
