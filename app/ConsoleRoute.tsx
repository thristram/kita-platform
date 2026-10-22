import { getConsoleSnapshot } from "@/db/console";
import { listConsoleEvents, type EventListQuery } from "@/db/consoleEvents";
import { KitaConsole, type CandidateTab, type ConsoleView, type SettingsSection } from "./KitaConsole";
import { requireConsolePage } from "@/lib/consolePageAccess";

type RouteView = Exclude<ConsoleView, "event">;

export async function ConsoleRoute({ view, settingsSection, candidateId, candidateTab, eventQuery }: { view: RouteView; settingsSection?: SettingsSection; candidateId?: string; candidateTab?: CandidateTab; eventQuery?: EventListQuery }) {
  const access = await requireConsolePage(view === "settings" && settingsSection === "access" ? "access:manage" : "console:read");
  const [initialData, initialEventPage] = await Promise.all([
    getConsoleSnapshot(),
    view === "events" && eventQuery ? listConsoleEvents(eventQuery) : Promise.resolve(null),
  ]);
  return <KitaConsole initialData={initialData} initialEventPage={initialEventPage} operator={access.session} permissions={access.permissions} initialView={view} initialSettingsSection={settingsSection} initialCandidateId={candidateId} initialCandidateTab={candidateTab} />;
}
