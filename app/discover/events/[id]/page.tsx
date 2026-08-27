import { notFound } from "next/navigation";
import { CalendarDays, ExternalLink, MapPin, Sparkles } from "lucide-react";
import { getConsoleEventDetail } from "@/db/events";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const titleCase = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

export default async function EventPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidPattern.test(id)) notFound();
  const event = await getConsoleEventDetail(id);
  if (!event) notFound();
  const date = event.startAt ? new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: event.timezone,
  }).format(new Date(event.startAt)) : "Date pending";
  const location = event.venue ? [event.venue.name, event.venue.city, event.venue.region].filter(Boolean).join(" · ") : "Venue pending";

  return <main className="consumer-shell preview-shell">
    <header className="consumer-nav"><a className="consumer-brand" href="/discover"><Sparkles size={17}/> <b>KitaCon</b></a><span className="operator-preview-badge">Private operator preview · {titleCase(event.status)}</span><a className="console-return" href={`/events/${event.id}`}>Back to console</a></header>
    <section className="preview-hero"><div className={`preview-art ${event.tone}`}><span>{event.dataOrigin === "MOCK" ? "Preview data" : "Canonical event"}</span><b>{event.short}</b></div><div className="preview-copy"><p className="eyebrow">{titleCase(event.eventType)}</p><h1>{event.title}</h1><p className="preview-meta"><CalendarDays size={14}/>{date}</p><p className="preview-meta"><MapPin size={14}/>{location}</p><p className="preview-summary">{event.summary || "No customer-facing summary has been written yet."}</p><div className="preview-actions">{event.officialUrl ? <a href={event.officialUrl} target="_blank" rel="noreferrer">Official website <ExternalLink size={13}/></a> : null}<a href={`/events/${event.id}`}>Edit in console</a></div></div></section>
    <section className="preview-related"><p className="eyebrow">Connected fandoms and entities</p><h2>{event.relations.length ? `${event.relations.length} relationships` : "Relationships pending"}</h2><div className="interest-bubbles">{event.relations.map((relation) => <span key={`${relation.entityId}-${relation.relationType}`} title={relation.name}>{relation.name.slice(0, 2).toUpperCase()}</span>)}</div></section>
  </main>;
}
