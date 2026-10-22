import { sql } from "drizzle-orm";
import { getDb } from "./index";
import type { ConsoleSession } from "@/lib/consoleSession";

export const PERMISSIONS = ["console:read", "events:write", "candidates:review", "sources:write", "jobs:write", "settings:write", "access:manage"] as const;
export type ConsolePermission = typeof PERMISSIONS[number];

type PrincipalRow = { id: string; email: string | null; status: string };
type GroupRow = { key: string; name: string; description: string; permissions: string[] };

export async function registerConsoleIdentity(identity: { issuer: string; subject: string; email: string; name: string }): Promise<ConsoleSession> {
  const db = getDb();
  let rows = (await db.execute<PrincipalRow>(sql`
    SELECT p.id, p.email, p.status FROM admin.principal_identity i
    JOIN admin.principal p ON p.id = i.principal_id
    WHERE i.auth_issuer = ${identity.issuer} AND i.auth_subject = ${identity.subject}
  `)).rows;
  if (!rows.length) {
    const created = (await db.execute<PrincipalRow>(sql`
      INSERT INTO admin.principal (auth_issuer, auth_subject, email, role, status, last_seen_at)
      VALUES (${identity.issuer}, ${identity.subject}, ${identity.email}, 'NONE', 'ACTIVE', now())
      ON CONFLICT (auth_issuer, auth_subject) DO UPDATE SET email = EXCLUDED.email, last_seen_at = now()
      RETURNING id, email, status
    `)).rows;
    await db.execute(sql`
      INSERT INTO admin.principal_identity (auth_issuer, auth_subject, principal_id)
      VALUES (${identity.issuer}, ${identity.subject}, ${created[0].id}) ON CONFLICT DO NOTHING
    `);
    rows = (await db.execute<PrincipalRow>(sql`
      SELECT p.id, p.email, p.status FROM admin.principal_identity i
      JOIN admin.principal p ON p.id = i.principal_id
      WHERE i.auth_issuer = ${identity.issuer} AND i.auth_subject = ${identity.subject}
    `)).rows;
  }
  const principal = rows[0];
  if (!principal || principal.status !== "ACTIVE") throw new Error("CONSOLE_ACCOUNT_DISABLED");
  await db.execute(sql`UPDATE admin.principal SET email = ${identity.email}, last_seen_at = now(), updated_at = now() WHERE id = ${principal.id}::uuid`);
  return { principalId: principal.id, issuer: identity.issuer, subject: identity.subject, email: identity.email, name: identity.name };
}

export async function permissionSet(session: ConsoleSession): Promise<Set<string> | null> {
  if (session.issuer !== process.env.KITA_AUTH_ISSUER?.trim()) return null;
  const db = getDb();
  const rows = (await db.execute<{ status: string; auth_subject: string; permissions: string[] | null }>(sql`
    SELECT p.status, i.auth_subject, COALESCE(array_agg(DISTINCT permission.value) FILTER (WHERE permission.value IS NOT NULL), ARRAY[]::text[]) AS permissions
    FROM admin.principal p
    JOIN admin.principal_identity i ON i.principal_id = p.id AND i.auth_issuer = ${session.issuer} AND i.auth_subject = ${session.subject}
    LEFT JOIN admin.principal_group pg ON pg.principal_id = p.id
    LEFT JOIN admin.permission_group g ON g.id = pg.group_id
    LEFT JOIN LATERAL unnest(g.permissions) AS permission(value) ON true
    WHERE p.id = ${session.principalId}::uuid
    GROUP BY p.id, i.auth_subject
  `)).rows;
  if (!rows[0] || rows[0].status !== "ACTIVE") return null;
  return new Set(rows[0].permissions ?? []);
}

export async function listAccessControl() {
  const db = getDb();
  const [groups, principals] = await Promise.all([
    db.execute<GroupRow>(sql`SELECT key, name, description, permissions FROM admin.permission_group ORDER BY name`).then((result) => result.rows),
    db.execute<{ id: string; email: string | null; status: string; last_seen_at: string | null; groups: string[] }>(sql`
      SELECT p.id, p.email, p.status, p.last_seen_at,
        COALESCE(array_agg(g.key ORDER BY g.key) FILTER (WHERE g.key IS NOT NULL), ARRAY[]::text[]) AS groups
      FROM admin.principal p
      LEFT JOIN admin.principal_group pg ON pg.principal_id = p.id
      LEFT JOIN admin.permission_group g ON g.id = pg.group_id
      GROUP BY p.id ORDER BY p.last_seen_at DESC NULLS LAST, p.email
    `).then((result) => result.rows),
  ]);
  return { groups, principals };
}

export async function setPrincipalGroup(actorId: string, principalId: string, groupKey: string, enabled: boolean) {
  const db = getDb();
  const rows = (await db.execute<{ error: string | null }>(sql`
    SELECT admin.set_permission_group(${actorId}::uuid, ${principalId}::uuid, ${groupKey}, ${enabled}) AS error
  `)).rows;
  return rows[0]?.error ?? null;
}
