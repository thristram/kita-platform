"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's current Link shim duplicates React; native navigation keeps dynamic console routes reliable. */

import { useMemo, useState } from "react";
import { ExternalLink, Link2, Plus, Save, Trash2 } from "lucide-react";
import type { ConsoleEventDetail } from "@/db/events";

interface EventFormState {
  title: string;
  eventType: string;
  startAt: string;
  endAt: string;
  timezone: string;
  officialUrl: string;
  summary: string;
}

const eventTypes = ["CONVENTION", "CONCERT", "POP_UP", "EXHIBITION", "MEETUP", "OTHER"];
const relationTypes = ["FEATURES", "ORGANIZED_BY", "SPONSORED_BY", "APPEARANCE"];

const toInputDate = (value: string | null, timezone: string) => {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
};

const zonedInputToIso = (value: string, timezone: string) => {
  const utcGuess = new Date(`${value}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(utcGuess);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  const representedAsUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  const timezoneOffset = representedAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - timezoneOffset).toISOString();
};

const toForm = (event: ConsoleEventDetail): EventFormState => ({
  title: event.title,
  eventType: event.eventType,
  startAt: toInputDate(event.startAt, event.timezone),
  endAt: toInputDate(event.endAt, event.timezone),
  timezone: event.timezone,
  officialUrl: event.officialUrl,
  summary: event.summary,
});

const titleCase = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const formatDate = (value: string | null, timezone: string) => {
  if (!value) return "Date pending";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
};

function EventArt({ tone, short, title }: { tone: string; short: string; title: string }) {
  return <div className={`event-art ${tone}`}><span className="event-date">INTERNAL DEFAULT</span><b><em>{short}</em>{title.toUpperCase()}</b></div>;
}

function ReadField({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className="field"><span>{label}</span><strong>{value}</strong><small>{meta}</small></div>;
}

export function EventWorkspace({ initialEvent, notify }: { initialEvent: ConsoleEventDetail; notify: (message: string) => void }) {
  const [event, setEvent] = useState(initialEvent);
  const [form, setForm] = useState(() => toForm(initialEvent));
  const [tab, setTab] = useState("Overview");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [relationEntityId, setRelationEntityId] = useState("");
  const [relationType, setRelationType] = useState("FEATURES");

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(event));
  const unlinkedEntities = useMemo(() => event.availableEntities.filter(
    (candidate) => !event.relations.some((relation) => relation.entityId === candidate.id && relation.relationType === relationType),
  ), [event.availableEntities, event.relations, relationType]);

  const applyEventResponse = async (response: Response, fallback: string) => {
    const payload = await response.json() as { event?: ConsoleEventDetail; error?: string };
    if (!response.ok || !payload.event) throw new Error(payload.error || fallback);
    setEvent(payload.event);
    setForm(toForm(payload.event));
    return payload.event;
  };

  const saveChanges = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          startAt: form.startAt ? zonedInputToIso(form.startAt, form.timezone) : null,
          endAt: form.endAt ? zonedInputToIso(form.endAt, form.timezone) : null,
        }),
      });
      await applyEventResponse(response, "Could not save changes");
      setEditing(false);
      notify("Event changes saved to Neon");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save changes");
    } finally {
      setSaving(false);
    }
  };

  const changePublication = async () => {
    const nextStatus = event.status === "PUBLISHED" ? "DRAFT" : "PUBLISHED";
    setSaving(true);
    try {
      const response = await fetch(`/api/events/${event.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      await applyEventResponse(response, "Could not change publication status");
      notify(nextStatus === "PUBLISHED" ? "Event published to customer views" : "Event unpublished from customer views");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not change publication status");
    } finally {
      setSaving(false);
    }
  };

  const addRelation = async () => {
    if (!relationEntityId) return notify("Choose an entity first");
    try {
      const response = await fetch(`/api/events/${event.id}/relationships`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityId: relationEntityId, relationType }),
      });
      await applyEventResponse(response, "Could not add relationship");
      setRelationEntityId("");
      notify("Relationship added to Neon");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not add relationship");
    }
  };

  const removeRelation = async (entityId: string, currentRelationType: string) => {
    try {
      const response = await fetch(`/api/events/${event.id}/relationships`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityId, relationType: currentRelationType }),
      });
      await applyEventResponse(response, "Could not remove relationship");
      notify("Relationship removed from Neon");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not remove relationship");
    }
  };

  const tabs = ["Overview", "Fandom Links", "Venue", "Media", "Sources", "Conflicts", "History", "Preview"];
  const location = event.venue ? `${event.venue.name} · ${[event.venue.city, event.venue.region].filter(Boolean).join(", ")}` : "Venue pending";

  return <>
    <div className="detail-head">
      <a className="back-link" href="/?view=events">‹ Events</a>
      <div className="detail-title"><span className={`detail-logo ${event.tone}`}>{event.short}</span><div><div className="title-line"><h1>{event.title}</h1><b className={`status-pill ${event.status.toLowerCase()}`}>{titleCase(event.status)}</b>{event.dataOrigin === "MOCK" ? <small className="mock-tag">Mock</small> : null}</div><p>{formatDate(event.startAt, event.timezone)} · {location}</p><span className="type-badge">{titleCase(event.eventType)}</span></div></div>
      <div className="detail-actions">
        <form action={`/discover/events/${event.id}`} method="get"><button className="button-link" type="submit">Preview <ExternalLink size={12}/></button></form>
        <button onClick={saveChanges} disabled={saving || !dirty}><Save size={12}/>{saving ? "Saving…" : "Save changes"}</button>
        <button className="primary-button" onClick={changePublication} disabled={saving}>{event.status === "PUBLISHED" ? "Unpublish" : "Publish"}</button>
      </div>
    </div>
    <div className="tabs" role="tablist">{tabs.map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)} key={item}>{item}{item === "Media" ? <small>{event.assets.length}</small> : null}{item === "Fandom Links" ? <small>{event.relations.length}</small> : null}{item === "Conflicts" && event.conflictCount ? <small className="warn-count">{event.conflictCount}</small> : null}</button>)}</div>

    {tab === "Overview" && <div className="detail-grid"><div className="detail-main">
      <section className="panel hero-panel"><div className="panel-head"><div><h2>Internal cover</h2><p>{event.assets[0] ? `Resolved from ${event.assets[0].title}` : "No asset assigned"}</p></div><b className="status-pill published">Internal default</b></div><EventArt tone={event.tone} short={event.short} title={event.title}/></section>
      <section className={`panel form-section ${editing ? "editing" : ""}`}><div className="section-title"><div><h2>Event information</h2><p>Canonical customer-visible fields</p></div><button onClick={() => { setEditing((value) => !value); if (editing) setForm(toForm(event)); }}>{editing ? "Cancel editing" : "Edit fields"}</button></div>
        {editing ? <div className="editable-grid">
          <label><span>Canonical title</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}/></label>
          <label><span>Event type</span><select value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })}>{eventTypes.map((type) => <option key={type} value={type}>{titleCase(type)}</option>)}</select></label>
          <label><span>Start</span><input type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })}/></label>
          <label><span>End</span><input type="datetime-local" value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })}/></label>
          <label><span>Timezone</span><input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}/></label>
          <label><span>Official URL</span><input type="url" value={form.officialUrl} onChange={(e) => setForm({ ...form, officialUrl: e.target.value })} placeholder="https://…"/></label>
          <label className="wide-field"><span>Public summary</span><textarea value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} rows={4} placeholder="Add a customer-facing summary…"/></label>
          <div className="wide-field edit-actions"><span>{dirty ? "Unsaved changes" : "No changes yet"}</span><button className="primary-button" onClick={saveChanges} disabled={saving || !dirty}>{saving ? "Saving…" : "Save to Neon"}</button></div>
        </div> : <><div className="field-grid"><ReadField label="Canonical title" value={event.title} meta="Canonical record"/><ReadField label="Event type" value={titleCase(event.eventType)} meta="Customer classification"/><ReadField label="Start" value={formatDate(event.startAt, event.timezone)} meta="Canonical date"/><ReadField label="End" value={formatDate(event.endAt, event.timezone)} meta="Canonical date"/><ReadField label="Timezone" value={event.timezone} meta="Venue derived"/><ReadField label="Organizer" value={event.organizer?.name || "Not linked"} meta={event.organizer ? "Verified entity" : "Relationship pending"}/></div></>}
      </section>
      <section className="panel"><div className="section-title"><div><h2>Summary</h2><p>English · public projection</p></div><button onClick={() => setEditing(true)}>Edit</button></div><p className="description">{event.summary || "No public summary has been written yet."}</p></section>
    </div><aside className="detail-side">
      <section className="panel"><h2>Publication</h2><dl><div><dt>Serving state</dt><dd><b className={`status-pill ${event.status.toLowerCase()}`}>{titleCase(event.status)}</b></dd></div><div><dt>Updated</dt><dd>{formatDate(event.updatedAt, event.timezone)}</dd></div><div><dt>Open conflicts</dt><dd className={event.conflictCount ? "warning-text" : ""}>{event.conflictCount}</dd></div></dl></section>
      <section className="panel"><h2>Fandom links</h2><div className="chip-list">{event.relations.length ? event.relations.slice(0, 5).map((relation) => <span key={`${relation.entityId}-${relation.relationType}`}>{relation.name}</span>) : <span>No relationships</span>}</div><button className="text-action" onClick={() => setTab("Fandom Links")}>Manage {event.relations.length} relationships →</button></section>
      <section className="panel"><h2>Primary sources</h2>{event.officialUrl ? <a className="mini-source" href={event.officialUrl} target="_blank" rel="noreferrer"><i className="healthy"/><span>Official website</span><b>Direct</b></a> : null}{event.sources.map((source) => <div className="mini-source" key={source.id}><i className="healthy"/>{source.name}<b>{source.trust}</b></div>)}{!event.officialUrl && !event.sources.length ? <p className="muted-copy">No source attached.</p> : null}</section>
    </aside></div>}

    {tab === "Fandom Links" && <section className="panel relation-manager"><div className="section-title"><div><h2>Event relationships</h2><p>These links drive fandom discovery and entity navigation.</p></div></div><div className="relation-add"><select aria-label="Relationship type" value={relationType} onChange={(e) => { setRelationType(e.target.value); setRelationEntityId(""); }}>{relationTypes.map((type) => <option key={type} value={type}>{titleCase(type)}</option>)}</select><select aria-label="Entity" value={relationEntityId} onChange={(e) => setRelationEntityId(e.target.value)}><option value="">Choose an entity…</option>{unlinkedEntities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name} · {entity.entityType}</option>)}</select><button className="primary-button" onClick={addRelation}><Plus size={13}/> Add relationship</button></div><div className="relation-list">{event.relations.map((relation) => <div key={`${relation.entityId}-${relation.relationType}`}><span className="relation-icon"><Link2 size={14}/></span><span><strong>{relation.name}</strong><small>{relation.entityType} · {titleCase(relation.relationType)}{relation.pinned ? " · Pinned" : ""}</small></span><button aria-label={`Remove ${relation.name}`} onClick={() => removeRelation(relation.entityId, relation.relationType)}><Trash2 size={14}/></button></div>)}{!event.relations.length ? <p className="empty-copy">No relationships yet. Choose an entity above to add one.</p> : null}</div></section>}
    {tab === "Venue" && <section className="panel workspace-tab"><h2>{event.venue?.name || "No venue linked"}</h2>{event.venue ? <dl><div><dt>Address</dt><dd>{event.venue.address || "Not provided"}</dd></div><div><dt>City</dt><dd>{event.venue.city}, {event.venue.region}</dd></div><div><dt>Country</dt><dd>{event.venue.countryCode}</dd></div><div><dt>Timezone</dt><dd>{event.timezone}</dd></div></dl> : <p>Attach a venue during event editing.</p>}</section>}
    {tab === "Media" && <section className="panel workspace-tab"><div className="section-title"><div><h2>Assigned media</h2><p>{event.assets.length} assets linked to this event</p></div></div><div className="workspace-assets">{event.assets.map((asset) => <article key={asset.id}><div className={`event-art ${asset.art}`}><span className="event-date">{asset.category}</span><b>{event.short}</b></div><strong>{asset.title}</strong><small>{asset.dimensions} · {asset.source}</small></article>)}{!event.assets.length ? <p className="empty-copy">No media is assigned to this event.</p> : null}</div></section>}
    {tab === "Sources" && <section className="panel workspace-tab"><h2>Evidence and sources</h2>{event.officialUrl ? <a href={event.officialUrl} target="_blank" rel="noreferrer">Official website <ExternalLink size={12}/></a> : null}{event.sources.map((source) => <div className="source-row-static" key={source.id}><strong>{source.name}</strong><span>{source.trust}</span></div>)}{!event.officialUrl && !event.sources.length ? <p>No source evidence is linked yet.</p> : null}</section>}
    {tab === "Conflicts" && <section className="panel workspace-tab"><h2>Resolution conflicts</h2><p>{event.conflictCount ? `${event.conflictCount} conflict requires editorial review.` : "No open conflicts for this event."}</p></section>}
    {tab === "History" && <section className="panel workspace-tab"><h2>Canonical history</h2><div className="history-row"><span>Latest update</span><strong>{formatDate(event.updatedAt, event.timezone)}</strong></div><div className="history-row"><span>Current status</span><strong>{titleCase(event.status)}</strong></div><div className="history-row"><span>Data origin</span><strong>{event.dataOrigin}</strong></div></section>}
    {tab === "Preview" && <section className="panel workspace-tab preview-panel"><p className="eyebrow">Customer projection</p><h2>{event.title}</h2><p>{event.summary || "No summary yet."}</p><a className="primary-button button-link" href={`/discover/events/${event.id}`}>Open full preview <ExternalLink size={13}/></a></section>}
  </>;
}
