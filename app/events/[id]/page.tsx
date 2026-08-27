import { notFound } from "next/navigation";
import { KitaConsole } from "../../KitaConsole";
import { getConsoleSnapshot } from "@/db/console";
import { getConsoleEventDetail } from "@/db/events";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidPattern.test(id)) notFound();
  const [initialData, initialEvent] = await Promise.all([
    getConsoleSnapshot(),
    getConsoleEventDetail(id),
  ]);
  if (!initialEvent) notFound();
  return <KitaConsole initialData={initialData} initialEvent={initialEvent} initialView="event"/>;
}
