import { enqueueSourceCrawl } from "@/db/crawler";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return Response.json(await enqueueSourceCrawl(id), { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to queue source" }, { status: 400 });
  }
}
