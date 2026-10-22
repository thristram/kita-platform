import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { permissionSet, type ConsolePermission } from "@/db/consoleAccess";
import { readSession, SESSION_COOKIE } from "./consoleSession";

export async function requireConsolePage(permission: ConsolePermission = "console:read") {
  const session = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/sign-in");
  const permissions = await permissionSet(session);
  if (!permissions?.has(permission)) redirect("/access-denied");
  return { session, permissions: [...permissions] };
}
