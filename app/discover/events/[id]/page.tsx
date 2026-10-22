import { notFound } from "next/navigation";
import { getConsoleEventDetail } from "@/db/events";
import { EventPresentation } from "@/app/EventPresentation";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export default async function EventPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidPattern.test(id)) notFound();
  const event = await getConsoleEventDetail(id);
  if (!event) notFound();
  return <EventPresentation event={event}/>;
}
