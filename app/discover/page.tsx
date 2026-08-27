import type { Metadata } from "next";
import { ConsumerHome } from "./ConsumerHome";
import { listPublishedEvents } from "../../db/serving";

export const metadata: Metadata = {
  title: "Discover anime events near you | KitaCon",
  description: "Find conventions, concerts, pop-ups, and exhibitions connected to the fandoms you love.",
};

export default async function DiscoverPage() {
  const events = await listPublishedEvents();
  return <ConsumerHome events={events.map((event) => ({
    ...event,
    startAt: event.startAt ? new Date(event.startAt).toISOString() : null,
  }))} />;
}
