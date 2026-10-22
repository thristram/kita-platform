import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { searchConsole } from "@/db/consoleSearch";

const querySchema = z.string().trim().min(2).max(160);

export async function GET(request: Request) {
  const denied = await requireApiAccess(request, "console:read");
  if (denied) return denied;

  const query = querySchema.safeParse(new URL(request.url).searchParams.get("q"));
  if (!query.success) return Response.json({ error: "Search query must be 2–160 characters" }, { status: 400 });

  try {
    return Response.json({ results: await searchConsole(query.data) });
  } catch (error) {
    console.error("[api/search] failed", error);
    return Response.json({ error: "Could not search the Console" }, { status: 500 });
  }
}
