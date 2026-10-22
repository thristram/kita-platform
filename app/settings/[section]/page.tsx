import { notFound } from "next/navigation";
import { ConsoleRoute } from "../../ConsoleRoute";
import type { SettingsSection } from "../../KitaConsole";

const sections = new Set<SettingsSection>(["general", "sources", "crawling", "media", "notifications", "access"]);

export default async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!sections.has(section as SettingsSection)) notFound();
  return <ConsoleRoute view="settings" settingsSection={section as SettingsSection} />;
}
