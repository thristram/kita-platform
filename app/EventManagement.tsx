"use client";
/* eslint-disable @next/next/no-img-element -- Evidence images retain their original URLs. */
import { useMemo, useState } from "react";
import { ExternalLink, Link2, Plus, Trash2 } from "lucide-react";
import type { ConsoleEventDetail } from "@/db/events";
import { EventCrawlerPanel } from "./EventCrawlerPanel";
const relationTypes = ["FEATURES", "ORGANIZED_BY", "SPONSORED_BY", "APPEARANCE"];
const titleCase=(s:string)=>s.replaceAll("_"," ").toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
const formatDate=(v:string|null,tz:string)=>v ? new Date(v).toLocaleString("en-US",{timeZone:tz}) : "Date pending";
export function EventManagement({event,tab,onUpdate,notify}:{event:ConsoleEventDetail;tab:string;onUpdate:(event:ConsoleEventDetail)=>void;notify:(message:string)=>void}) {
  const [relationEntityId,setRelationEntityId]=useState("");
  const [relationType,setRelationType]=useState("FEATURES");
  const unlinkedEntities=useMemo(()=>event.availableEntities.filter(e=>!event.relations.some(r=>r.entityId===e.id&&r.relationType===relationType)),[event.availableEntities,event.relations,relationType]);
  const applyEventResponse=async(response:Response,fallback:string)=>{
    const payload=await response.json() as {event?:ConsoleEventDetail;error?:string};
    if(!response.ok||!payload.event)throw new Error(payload.error||fallback);
    onUpdate(payload.event);return payload.event;
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

  return <div className="ep-management">
    {tab === "Crawler" && <EventCrawlerPanel eventId={event.id} notify={notify}/>}
    {tab === "Fandom Links" && <section className="panel relation-manager"><div className="section-title"><div><h2>Event relationships</h2><p>These links drive fandom discovery and entity navigation.</p></div></div><div className="relation-add"><select aria-label="Relationship type" value={relationType} onChange={(e) => { setRelationType(e.target.value); setRelationEntityId(""); }}>{relationTypes.map((type) => <option key={type} value={type}>{titleCase(type)}</option>)}</select><select aria-label="Entity" value={relationEntityId} onChange={(e) => setRelationEntityId(e.target.value)}><option value="">Choose an entity…</option>{unlinkedEntities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name} · {entity.entityType}</option>)}</select><button className="primary-button" onClick={addRelation}><Plus size={13}/> Add relationship</button></div><div className="relation-list">{event.relations.map((relation) => <div key={`${relation.entityId}-${relation.relationType}`}><span className="relation-icon"><Link2 size={14}/></span><span><strong>{relation.name}</strong><small>{relation.entityType} · {titleCase(relation.relationType)}{relation.pinned ? " · Pinned" : ""}</small></span><button aria-label={`Remove ${relation.name}`} onClick={() => removeRelation(relation.entityId, relation.relationType)}><Trash2 size={14}/></button></div>)}{!event.relations.length ? <p className="empty-copy">No relationships yet. Choose an entity above to add one.</p> : null}</div></section>}
    {tab === "Venue" && <section className="panel workspace-tab"><h2>{event.venue?.name || "No venue linked"}</h2>{event.venue ? <dl><div><dt>Address</dt><dd>{event.venue.address || "Not provided"}</dd></div><div><dt>City</dt><dd>{event.venue.city}, {event.venue.region}</dd></div><div><dt>Country</dt><dd>{event.venue.countryCode}</dd></div><div><dt>Timezone</dt><dd>{event.timezone}</dd></div></dl> : <p>Attach a venue during event editing.</p>}</section>}
    {tab === "Media" && <section className="panel workspace-tab"><div className="section-title"><div><h2>Event media</h2><p>Images selected during review and attached to event content</p></div></div><div className="ep-media-grid">{event.media.filter(m=>m.selected).map(m=><a href={m.url} key={m.id} target="_blank" rel="noreferrer"><img src={m.url} alt={titleCase(m.role)} loading="lazy"/><strong>{titleCase(m.role)}</strong><small>{m.url.split("/").pop()}</small></a>)}</div>{!event.media.some(m=>m.selected)?<p>No reviewed media attached.</p>:null}</section>}
    {tab === "Sources" && <section className="panel workspace-tab"><h2>Evidence and sources</h2>{event.officialUrl ? <a href={event.officialUrl} target="_blank" rel="noreferrer">Official website <ExternalLink size={12}/></a> : null}{event.sources.map((source) => <div className="source-row-static" key={source.id}><strong>{source.name}</strong><span>{source.trust}</span></div>)}{!event.officialUrl && !event.sources.length ? <p>No source evidence is linked yet.</p> : null}</section>}
    {tab === "Conflicts" && <section className="panel workspace-tab"><h2>Resolution conflicts</h2><p>{event.conflictCount ? `${event.conflictCount} conflict requires editorial review.` : "No open conflicts for this event."}</p></section>}
    {tab === "History" && <section className="panel workspace-tab"><h2>Canonical history</h2><div className="history-row"><span>Latest update</span><strong>{formatDate(event.updatedAt, event.timezone)}</strong></div><div className="history-row"><span>Current status</span><strong>{titleCase(event.status)}</strong></div><div className="history-row"><span>Data origin</span><strong>{event.dataOrigin}</strong></div></section>}
    {tab === "Preview" && <section className="panel workspace-tab preview-panel"><p className="eyebrow">Customer projection</p><h2>{event.title}</h2><p>{event.summary || "No summary yet."}</p><a className="primary-button button-link" href={`/discover/events/${event.id}`}>Open full preview <ExternalLink size={13}/></a></section>}
  </div>;
}
