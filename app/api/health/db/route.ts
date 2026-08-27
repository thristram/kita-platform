import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export async function GET() {
  try {
    const result = await getDb().execute(sql`
      SELECT
        1 AS connected,
        current_database() AS database,
        current_schema() AS schema
    `);
    const row = result.rows[0];
    return Response.json({
      status: "ok",
      service: "neon-postgres",
      branch: process.env.NEON_BRANCH ?? "unknown",
      database: row?.database,
      schema: row?.schema,
    });
  } catch {
    return Response.json(
      { status: "error", service: "neon-postgres" },
      { status: 503 },
    );
  }
}
