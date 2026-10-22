import { z } from "zod";
import { requireApiAccess } from "@/lib/consoleApiAccess";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/index";
import { getConsoleEventDetail } from "@/db/events";
import { contentEditSchema, eventContentConfigs } from "@/lib/eventContentEdit";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiAccess(request, "events:write");
  if (denied) return denied;
  const { id }=await params;
  if (!z.string().uuid().safeParse(id).success) return Response.json({error:"Invalid event ID"},{status:400});
  try {
    const {collection,id:recordId,changes}=contentEditSchema.parse(await request.json());
    const config=eventContentConfigs[collection];
    const fields=config.fields as Record<string,string>;
    const entries=Object.entries(changes);
    if (!entries.length) return Response.json({error:"No changes supplied"},{status:400});
    if ("timezone" in changes) { try { new Intl.DateTimeFormat("en",{timeZone:String(changes.timezone)}); } catch { return Response.json({error:"Enter a valid timezone"},{status:400}); } }
    const db=getDb();
    const identity=collection === "relatedSubjects" ? sql`canonical_key=${recordId}` : sql`id=${recordId}::uuid`;
    const row=await db.execute(sql`SELECT * FROM ${sql.identifier("event")}.${sql.identifier(config.table)} WHERE event_id=${id}::uuid AND ${identity}`);
    if (!row.rows[0]) return Response.json({error:"This record does not belong to the event"},{status:404});
    const values={...row.rows[0],...Object.fromEntries(entries.map(([key,value])=>[fields[key],value]))};
    for (const [start,end] of [["start_at","end_at"],["valid_from","valid_through"]]) {
      if (values[start] && values[end] && new Date(String(values[end])) < new Date(String(values[start]))) return Response.json({error:"End must be after start"},{status:400});
    }
    const mediaIds=entries.flatMap(([key,value]) => key.endsWith("MediaCandidateId") && value ? [String(value)] : key === "mediaCandidateIds" && Array.isArray(value) ? value as string[] : []);
    if (mediaIds.length) {
      const result=await db.execute(sql`SELECT id FROM ingestion.media_candidate WHERE root_event_id=${id}::uuid AND id IN (${sql.join(mediaIds.map((m)=>sql`${m}::uuid`),sql`,`)})`);
      if (result.rows.length !== new Set(mediaIds).size) return Response.json({error:"Choose media attached to this event"},{status:400});
    }
    const assignments=entries.map(([key,value])=> {
      const column=sql.identifier(fields[key]);
      if (key === "value") return sql`${column}=${JSON.stringify(value)}::jsonb`;
      if (Array.isArray(value)) return sql`${column}=ARRAY[${sql.join(value.map((v)=>sql`${v}::text`),sql`, `)}]::${key === "mediaCandidateIds" ? sql.raw("uuid[]") : sql.raw("text[]")}`;
      return sql`${column}=${value}`;
    });
    await db.execute(sql`UPDATE ${sql.identifier("event")}.${sql.identifier(config.table)} SET ${sql.join(assignments,sql`, `)},updated_at=now(),metadata=metadata || '{"editorialOverride":true}'::jsonb WHERE event_id=${id}::uuid AND ${identity}`);
    return Response.json({event:await getConsoleEventDetail(id)});
  } catch(error) {
    if (error instanceof z.ZodError) return Response.json({error:error.issues[0]?.message || "Invalid content"},{status:400});
    console.error("[api/events/content] update failed",{eventId:id,error});
    return Response.json({error:"Could not save event content"},{status:500});
  }
}
