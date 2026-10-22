import { cookies } from "next/headers";
import { permissionSet, type ConsolePermission } from "@/db/consoleAccess";
import { appOrigin } from "./consoleOidc";
import { readSession, SESSION_COOKIE } from "./consoleSession";

export async function requireApiAccess(request: Request, permission: ConsolePermission): Promise<Response | null> {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return Response.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin !== appOrigin(request.url)) return Response.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  }
  try {
    const permissions = await permissionSet(session);
    if (!permissions?.has(permission)) return Response.json({ error: "PERMISSION_DENIED" }, { status: 403 });
  } catch (error) {
    console.error("[console-auth] API access check failed", error);
    return Response.json({ error: "ACCESS_UNAVAILABLE" }, { status: 503 });
  }
  return null;
}
