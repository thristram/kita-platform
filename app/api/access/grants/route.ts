import { cookies } from "next/headers";
import { z } from "zod";
import { setPrincipalGroup } from "@/db/consoleAccess";
import { readSession, SESSION_COOKIE } from "@/lib/consoleSession";
import { requireApiAccess } from "@/lib/consoleApiAccess";

const input = z.object({ principalId: z.uuid(), groupKey: z.enum(["owner", "editor", "reviewer", "operator", "viewer"]), enabled: z.boolean() });

export async function POST(request: Request) {
  const denied = await requireApiAccess(request, "access:manage");
  if (denied) return denied;
  const actor = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!actor) return Response.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "INVALID_GRANT" }, { status: 400 });
  try {
    const failure = await setPrincipalGroup(actor.principalId, parsed.data.principalId, parsed.data.groupKey, parsed.data.enabled);
    return failure ? Response.json({ error: failure }, { status: 409 }) : Response.json({ ok: true });
  } catch (error) {
    console.error("[access] grant failed", error);
    return Response.json({ error: "GRANT_FAILED" }, { status: 503 });
  }
}
