export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ service: "kita-resolution-control", status: "ok", contractVersion: "1.0" }, { headers: { "Cache-Control": "no-store" } });
}
