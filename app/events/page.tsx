import { ConsoleRoute } from "../ConsoleRoute";
import { parseEventListQuery } from "@/db/consoleEvents";

export default async function EventsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ConsoleRoute view="events" eventQuery={parseEventListQuery(await searchParams)} />;
}
