"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext's current Link shim duplicates React; native console navigation is reliable. */

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FileText, Play, RefreshCw, Route, ServerCog } from "lucide-react";

type EventEvidence = {
  event: { enrichment_state?: string; official_url?: string; internal_cover_asset_id?: string | null };
  runs: Array<{ id: string; status: string; scheduled_at: string | null; pages_scheduled: number; pages_fetched: number; pages_unchanged: number; pages_failed: number; documents_created: number; media_discovered: number; logo_discovery_status: string; error_summary?: Record<string, unknown> }>;
  sources: Array<{ id: string; name: string; source_type: string; base_url: string; trust_level: string; enabled: boolean; relation_type: string; confidence: number }>;
  documents: Array<{ id: string; canonical_url: string; document_type: string; page_type: string; title?: string; fetched_at: string; mime_type: string; byte_size: number }>;
  media: Array<{ id: string; detected_category: string; source_url: string; r2_bucket?: string | null; r2_key?: string | null; width?: number; height?: number; role: string; is_default_internal: boolean; pinned: boolean }>;
  graph: Array<{ id: string; normalized_url: string; anchor_text?: string; link_kind: string; page_hint: string; decision: string; decision_reason: string }>;
};

const titleCase = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

export function EventCrawlerPanel({ eventId, notify }: { eventId: string; notify: (message: string) => void }) {
  const [evidence, setEvidence] = useState<EventEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [queueing, setQueueing] = useState(false);
  const [creatingSource, setCreatingSource] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/crawler/events/${eventId}/evidence`, { cache: "no-store" });
      const payload = await response.json() as EventEvidence & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load crawler evidence");
      setEvidence(payload);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not load crawler evidence");
    } finally {
      setLoading(false);
    }
  }, [eventId, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(true), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const source = evidence?.sources.find((item) => item.enabled) || evidence?.sources[0];
  const latestRun = evidence?.runs[0];
  const activeRun = evidence?.runs.some((run) => ["QUEUED", "RUNNING"].includes(run.status));

  useEffect(() => {
    if (!activeRun) return;
    const timer = window.setInterval(() => void refresh(true), 2_500);
    return () => window.clearInterval(timer);
  }, [activeRun, refresh]);

  const runCrawler = async () => {
    if (!source) return notify("Attach an approved source to this event first");
    if (!source.enabled) return notify("Review and enable this source before crawling");
    setQueueing(true);
    try {
      const response = await fetch(`/api/crawler/sources/${source.id}/run`, { method: "POST" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not queue crawl");
      notify(`${source.name} crawl queued`);
      await refresh(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not queue crawl");
    } finally {
      setQueueing(false);
    }
  };

  const createOfficialSource = async () => {
    if (!evidence?.event.official_url) return;
    setCreatingSource(true);
    try {
      const host = new URL(evidence.event.official_url).hostname;
      const response = await fetch("/api/crawler/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Official site · ${host}`, url: evidence.event.official_url, connectorKey: "website", trustLevel: "OFFICIAL", policyApproved: false, reviewNote: "", contactIdentity: "", rootEventId: eventId }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not create source");
      notify("Official source attached. Review its policy in Sources before crawling.");
      await refresh(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not create source");
    } finally {
      setCreatingSource(false);
    }
  };

  if (loading) return <section className="panel workspace-tab crawler-event-empty"><RefreshCw className="spin" size={17}/><p>Loading crawler evidence…</p></section>;
  if (!evidence) return <section className="panel workspace-tab crawler-event-empty"><ServerCog size={18}/><p>Crawler evidence is unavailable.</p></section>;

  return <div className="event-crawler-workspace">
    <section className="panel crawler-event-summary">
      <div className="section-title"><div><p className="eyebrow">Event enrichment</p><h2>Crawler evidence</h2><p>Raw documents, source graph, and media produced for this canonical event.</p></div><div className="crawler-event-actions">{!source && evidence.event.official_url ? <button disabled={creatingSource} onClick={createOfficialSource}>{creatingSource ? "Creating…" : "Create official source"}</button> : null}<button onClick={() => refresh()}><RefreshCw size={12}/> Refresh</button><button className="primary-button" disabled={!source || !source.enabled || queueing || Boolean(activeRun)} onClick={runCrawler}><Play size={12}/>{queueing ? "Queueing…" : activeRun ? "Crawl active" : "Run crawl"}</button></div></div>
      <div className="crawler-event-metrics"><article><span>State</span><strong>{titleCase(String(evidence.event.enrichment_state || "not started"))}</strong><small>Canonical enrichment</small></article><article><span>Sources</span><strong>{evidence.sources.length}</strong><small>{source ? source.name : "No source attached"}</small></article><article><span>Raw documents</span><strong>{evidence.documents.length}</strong><small>Immutable evidence</small></article><article><span>Media</span><strong>{evidence.media.length}</strong><small>{evidence.event.internal_cover_asset_id ? "Cover resolved" : "Cover pending"}</small></article></div>
    </section>

    <div className="crawler-event-grid">
      <section className="panel"><div className="panel-head"><div><h2>Latest run</h2><p>Durable job progress and extraction output</p></div>{latestRun ? <b className={`status-pill ${latestRun.status.toLowerCase()}`}>{titleCase(latestRun.status)}</b> : null}</div>{latestRun ? <><div className="crawler-run-metrics"><span><b>{latestRun.pages_fetched}</b> fetched</span><span><b>{latestRun.pages_unchanged}</b> unchanged</span><span><b>{latestRun.pages_failed}</b> failed</span><span><b>{latestRun.documents_created}</b> documents</span><span><b>{latestRun.media_discovered}</b> media</span></div><a className="inline-evidence-link" href="/?view=jobs">Open runs in Crawl Jobs <ExternalLink size={11}/></a>{latestRun.error_summary && Object.keys(latestRun.error_summary).length ? <pre className="crawler-error-box">{JSON.stringify(latestRun.error_summary, null, 2)}</pre> : null}</> : <p className="empty-copy">No crawl has been recorded for this event. Attach an enabled source and run it above.</p>}</section>
      <section className="panel"><div className="panel-head"><div><h2>Attached sources</h2><p>Seed and discovered follow-on sources</p></div></div><div className="event-source-list">{evidence.sources.map((item) => <article key={item.id}><span className={`worker-beacon ${item.enabled ? "online" : "offline"}`}/><span><strong>{item.name}</strong><small>{titleCase(item.source_type)} · {titleCase(item.relation_type)} · {Math.round(Number(item.confidence || 0) * 100)}%</small></span><a href={item.base_url} target="_blank" rel="noreferrer"><ExternalLink size={12}/></a></article>)}{!evidence.sources.length ? <p className="empty-copy">No crawler source is associated with this event yet.</p> : null}</div></section>
    </div>

    <section className="panel crawler-documents"><div className="panel-head"><div><h2>RawDocuments</h2><p>Metadata stays in Neon; private bytes are served through bounded signed URLs.</p></div><FileText size={15}/></div><div className="crawler-document-list">{evidence.documents.map((document) => <article key={document.id}><span><strong>{document.title || titleCase(document.page_type || document.document_type)}</strong><small>{document.canonical_url}</small></span><span><b>{Number(document.byte_size || 0).toLocaleString()} B</b><small>{document.fetched_at ? new Date(document.fetched_at).toLocaleString() : "Unknown time"}</small></span><a href={`/api/crawler/raw-documents/${document.id}/download`} target="_blank" rel="noreferrer">Download</a></article>)}{!evidence.documents.length ? <p className="empty-copy">No immutable documents have been written for this event.</p> : null}</div></section>

    <div className="crawler-event-grid">
      <section className="panel"><div className="panel-head"><div><h2>Source graph</h2><p>Accepted, excluded, and externally classified links</p></div><Route size={15}/></div><div className="event-graph-list">{evidence.graph.slice(0, 30).map((edge) => <article key={edge.id}><span><strong>{edge.anchor_text || titleCase(edge.page_hint || edge.link_kind)}</strong><small>{edge.normalized_url}</small></span><b className={`status-pill ${edge.decision.toLowerCase().replaceAll("_", "-")}`}>{titleCase(edge.decision)}</b><p>{edge.decision_reason}</p></article>)}{!evidence.graph.length ? <p className="empty-copy">No URL discovery edges have been captured.</p> : null}</div></section>
      <section className="panel"><div className="panel-head"><div><h2>Resolved media</h2><p>Pinned assignments are never overwritten by the crawler.</p></div></div><div className="event-media-list">{evidence.media.slice(0, 30).map((item) => <article key={item.id}><span><strong>{titleCase(item.detected_category || item.role)}</strong><small>{item.width && item.height ? `${item.width} × ${item.height}` : "Dimensions pending"}</small></span><span className="media-evidence-action"><b>{item.pinned ? "Pinned" : item.is_default_internal ? "Internal default" : titleCase(item.role)}</b>{item.r2_bucket && item.r2_key ? <a href={`/api/crawler/media/${item.id}/download`} target="_blank" rel="noreferrer">Download</a> : null}</span></article>)}{!evidence.media.length ? <p className="empty-copy">No downloaded media is assigned yet.</p> : null}</div></section>
    </div>
  </div>;
}
