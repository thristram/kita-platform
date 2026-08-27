import { KitaConsole, type ConsoleView } from "./KitaConsole";
import { getConsoleSnapshot } from "../db/console";

const views = new Set<ConsoleView>(["overview", "events", "media", "sources", "jobs", "review", "settings"]);

export default async function Home({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const initialView = view && views.has(view as ConsoleView) ? view as ConsoleView : "overview";
  return <KitaConsole initialData={await getConsoleSnapshot()} initialView={initialView} />;
}
