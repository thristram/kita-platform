import { notFound } from "next/navigation";
import { ConsoleRoute } from "../../../ConsoleRoute";
import type { CandidateTab } from "../../../KitaConsole";

const tabs = new Set<CandidateTab>(["overview", "schedule", "exhibitors", "fandoms", "updates"]);

export default async function CandidateTabPage({ params }: { params: Promise<{ id: string; tab: string }> }) {
  const { id, tab } = await params;
  if (!tabs.has(tab as CandidateTab)) notFound();
  return <ConsoleRoute view="review" candidateId={id} candidateTab={tab as CandidateTab}/>;
}
