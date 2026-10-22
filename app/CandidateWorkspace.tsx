"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventBundle } from "@kita/contracts";
import { encodeLegacyBangumiId } from "@kita/contracts";
import { ArrowLeft, ArrowRight, Building2, CalendarDays, Check, CheckCircle2, Circle, Download, ExternalLink, FileJson, FileSearch, Image as ImageIcon, Link2, LoaderCircle, MapPin, Pencil, Plus, RotateCcw, Search, ShieldCheck, Sparkles, Ticket, Upload, Users, X, XCircle } from "lucide-react";
import type { CandidateEventDraft, ReviewCandidateDetail, ReviewCandidateSummary, ReviewResolutionStatus } from "@/db/candidates";
import type { CandidateTab } from "./KitaConsole";
import { compareValues, nextSort, SortHeader, type SortDirection } from "./ConsoleTableControls";

const tabs: Array<{ id: CandidateTab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "schedule", label: "Schedule" }, { id: "exhibitors", label: "Exhibitors" }, { id: "fandoms", label: "Related Fandoms" }, { id: "updates", label: "Updates" },
];
const eventTypes = ["CONVENTION", "CONCERT", "COSPLAY", "MEETUP", "POPUP", "EXHIBITION", "DOUJIN", "SCREENING", "PANEL", "SIGNING", "OTHER"];
const sessionTypes = ["CEREMONY", "PANEL", "CONCERT", "SIGNING", "WORKSHOP", "SCREENING", "COSPLAY", "MEETUP", "GUEST_APPEARANCE", "OTHER"];
const updateCategories = ["OFFICIAL", "EXHIBITOR", "GUEST", "TICKET", "MEDIA", "POLICY", "SCHEDULE", "OTHER"];
const titleCase = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const percent = (value: number) => `${Math.round(value * 100)}%`;
const processingLabel = (mode: ReviewCandidateSummary["processingMode"]) => ({ LLM_KB: "LLM + KB", DETERMINISTIC_FALLBACK: "Deterministic fallback", DETERMINISTIC_ONLY: "Deterministic only", MANUAL: "Manual draft", MANUAL_JSON: "Manual JSON override" })[mode];
const formatMetric = (value: number | null, suffix = "") => value === null ? "Not reported" : `${value.toLocaleString()}${suffix}`;
const normalizedOffset = (value: string) => value.replace(/([+-])(\d):(\d{2})$/, "$10$2:$3");
const displayDate = (value: string | null) => {
  if (!value) return "Date pending";
  const date = new Date(normalizedOffset(value));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const displayTime = (value: string | null) => {
  if (!value) return "Time pending";
  const date = new Date(normalizedOffset(value));
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : String(value || "").split(",")).map((item) => item.trim()).filter(Boolean);
const string = (value: unknown) => Array.isArray(value) ? value.map(String).join(", ") : typeof value === "string" || typeof value === "number" ? String(value) : "";
const bool = (value: unknown) => value === true;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string; errorCode?: string; errorId?: string };
  if (!response.ok) throw new Error([body.error, body.errorCode, body.errorId].filter(Boolean).join(" · ") || `Request failed (${response.status})`);
  return body;
}

function coreDraft(bundle: EventBundle): CandidateEventDraft {
  return { title: bundle.event.name, eventType: bundle.event.eventType === "POPUP" ? "POP_UP" : bundle.event.eventType, startAt: bundle.event.startDate ? normalizedOffset(bundle.event.startDate) : "", endAt: bundle.event.endDate ? normalizedOffset(bundle.event.endDate) : "", timezone: bundle.event.timezone, officialUrl: bundle.event.officialUrl, summary: bundle.event.description, venueName: bundle.event.venue.name, addressLine1: bundle.event.venue.addressLine1, city: bundle.event.venue.city, region: bundle.event.venue.region, countryCode: bundle.event.venue.countryCode, postalCode: bundle.event.venue.postalCode };
}

type EditorKind = "overview" | "support" | "session" | "exhibitor" | "fandom" | "update";
type EditorState = { kind: EditorKind; index: number; value: Record<string, unknown> };

function PencilButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button className="candidate-edit-button" aria-label={label} title={label} onClick={onClick}><Pencil size={15}/></button>;
}

export function CandidateWorkspace({ initialCount, notify, initialCandidateId = "", initialTab = "overview" }: { initialCount: number; notify: (message: string) => void; initialCandidateId?: string; initialTab?: CandidateTab }) {
  const router = useRouter();
  const [candidates, setCandidates] = useState<ReviewCandidateSummary[]>([]);
  const [detail, setDetail] = useState<ReviewCandidateDetail | null>(null);
  const [bundle, setBundle] = useState<EventBundle | null>(null);
  const [resolution, setResolution] = useState<ReviewResolutionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saveError, setSaveError] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkEventId, setLinkEventId] = useState("");
  const [eventQuery, setEventQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const loadCandidates = useCallback(async () => {
    const result = await api<{ candidates: ReviewCandidateSummary[]; resolution: ReviewResolutionStatus | null }>("/api/candidates?status=PENDING&limit=250");
    setCandidates(result.candidates); setResolution(result.resolution);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => { try { await loadCandidates(); } catch (error) { if (active) notify(error instanceof Error ? error.message : "Could not load candidates"); } finally { if (active) setLoading(false); } };
    void load(); const interval = window.setInterval(() => { void loadCandidates().catch(() => undefined); }, 8_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [loadCandidates, notify]);

  useEffect(() => {
    if (!initialCandidateId) return;
    let active = true;
    api<{ candidate: ReviewCandidateDetail }>(`/api/candidates/${initialCandidateId}`)
      .then(({ candidate }) => { if (active) { setDetail(candidate); setBundle(candidate.bundle); } })
      .catch((error) => { if (active) notify(error instanceof Error ? error.message : "Could not load candidate"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initialCandidateId, notify]);

  const visible = useMemo(() => { const needle = query.trim().toLowerCase(); return candidates.filter((candidate) => !needle || [candidate.proposedTitle, candidate.documentTitle, candidate.sourceName, candidate.canonicalUrl].some((value) => value.toLowerCase().includes(needle))); }, [candidates, query]);
  const visibleEvents = useMemo(() => { if (!detail) return []; const needle = eventQuery.trim().toLowerCase(); return detail.existingEvents.filter((event) => !needle || `${event.title} ${event.status} ${event.startAt || ""}`.toLowerCase().includes(needle)); }, [detail, eventQuery]);

  const saveBundle = async (next: EventBundle) => {
    if (!detail) return;
    if (detail.status !== "PENDING" || detail.publishedEventId) {
      setSaveError("This Candidate has already left the review queue. Edit the linked Event instead.");
      return;
    }
    setSaveError(""); setActing(true);
    try {
      const saved = await api<{ bundle: EventBundle; revision: number; savedAt: string }>(`/api/candidates/${detail.id}/draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle: next }) });
      setBundle(saved.bundle); setDetail({ ...detail, bundle: saved.bundle, draft: coreDraft(saved.bundle), draftRevision: saved.revision, draftSavedAt: saved.savedAt }); setEditor(null); notify(`Draft revision ${saved.revision} saved`);
    } catch (error) { const message = error instanceof Error ? error.message : "Could not save draft"; setSaveError(message); notify(message); } finally { setActing(false); }
  };

  const openOverview = () => { if (!bundle) return; setSaveError(""); setEditor({ kind: "overview", index: -1, value: { name: bundle.event.name, alternateNames: bundle.event.alternateNames.join(", "), eventType: bundle.event.eventType, description: bundle.event.description, startDate: bundle.event.startDate || "", endDate: bundle.event.endDate || "", timezone: bundle.event.timezone, officialUrl: bundle.event.officialUrl, organizerNames: bundle.event.organizerNames.join(", "), venueName: bundle.event.venue.name, addressLine1: bundle.event.venue.addressLine1, city: bundle.event.venue.city, region: bundle.event.venue.region, postalCode: bundle.event.venue.postalCode, countryCode: bundle.event.venue.countryCode, heroMediaCandidateId: bundle.media.find((item) => item.role === "EVENT_HERO")?.mediaCandidateId || null } }); };
  const openSupport = () => { if (!bundle) return; setSaveError(""); setEditor({ kind: "support", index: -1, value: { links: bundle.links.map((item) => `${item.type}|${item.label}|${item.url}`).join("\n"), facts: bundle.facts.map((item) => `${item.type}|${item.label}|${String(item.value)}|${item.unit || ""}`).join("\n"), tickets: bundle.ticketOffers.map((item) => `${item.name}|${item.priceText}|${item.availability}|${item.purchaseUrl || ""}`).join("\n") } }); };
  const openItem = (kind: Exclude<EditorKind, "overview" | "support">, index: number, value: object) => { setSaveError(""); setEditor({ kind, index, value: clone(value) as Record<string, unknown> }); };
  const sourceDocumentIds = bundle?.evidence[0] ? [bundle.evidence[0].sourceDocumentId] : detail ? [detail.rawDocumentId] : [];
  const addItem = (kind: "session" | "exhibitor" | "update") => {
    const base = { externalKey: crypto.randomUUID(), sourceDocumentIds, confidence: 1 };
    if (kind === "session") openItem(kind, -1, { ...base, title: "", sessionType: "PANEL", description: "", startDate: null, endDate: null, timezone: bundle?.event.timezone || "UTC", venueName: bundle?.event.venue.name || "", room: "", ageRating: "", organizationNames: [], subjectTargets: [], personTargets: [], imageMediaCandidateId: null, tags: [] });
    if (kind === "exhibitor") openItem(kind, -1, { ...base, name: "", description: "", booth: "", categories: [], featured: false, websiteUrl: null, logoMediaCandidateId: null, organizationNames: [] });
    if (kind === "update") openItem(kind, -1, { ...base, title: "", summary: "", publishedAt: null, category: "OFFICIAL", sourceName: detail?.sourceName || "", sourceUrl: null, imageMediaCandidateId: null });
  };

  const commitEditor = () => {
    if (!editor || !bundle) return; const next = clone(bundle); const value = editor.value;
    if (editor.kind === "overview") {
      next.event = { ...next.event, name: string(value.name), alternateNames: list(value.alternateNames), eventType: string(value.eventType) as EventBundle["event"]["eventType"], description: string(value.description), startDate: string(value.startDate) || null, endDate: string(value.endDate) || null, timezone: string(value.timezone), officialUrl: string(value.officialUrl), organizerNames: list(value.organizerNames), venue: { name: string(value.venueName), addressLine1: string(value.addressLine1), city: string(value.city), region: string(value.region), postalCode: string(value.postalCode), countryCode: string(value.countryCode) } };
      next.media = next.media.filter((item) => item.role !== "EVENT_HERO");
      const selected = detail?.media.find((item) => item.id === value.heroMediaCandidateId);
      if (selected) next.media.unshift({ sourceDocumentId: sourceDocumentIds[0], mediaCandidateId: selected.id, url: selected.url, role: "EVENT_HERO", confidence: 1, method: "crawler-signals" });
    }
    if (editor.kind === "support") {
      next.links = string(value.links).split("\n").filter(Boolean).map((row) => { const [type,label,url] = row.split("|"); return { type: (type || "OTHER") as EventBundle["links"][number]["type"], label: label || "", url: url || "", sourceDocumentIds, confidence: 1 }; });
      next.facts = string(value.facts).split("\n").filter(Boolean).map((row) => { const [type,label,factValue,unit] = row.split("|"); return { type: (type || "OTHER") as EventBundle["facts"][number]["type"], label: label || "Fact", value: factValue || "", unit: unit || null, sourceDocumentIds, confidence: 1 }; });
      next.ticketOffers = string(value.tickets).split("\n").filter(Boolean).map((row, index) => { const [name,priceText,availability,purchaseUrl] = row.split("|"); return { externalKey: `human-ticket-${index}-${name}`, name: name || "Ticket", description: "", purchaseUrl: purchaseUrl || null, priceText: priceText || "", availability: (availability || "UNKNOWN") as EventBundle["ticketOffers"][number]["availability"], validFrom: null, validThrough: null, sourceDocumentIds, confidence: 1 }; });
    }
    if (editor.kind === "session") { const item = { ...value, title: string(value.title), sessionType: string(value.sessionType), description: string(value.description), startDate: string(value.startDate) || null, endDate: string(value.endDate) || null, timezone: string(value.timezone), venueName: string(value.venueName), room: string(value.room), ageRating: string(value.ageRating), organizationNames: list(value.organizationNames), tags: list(value.tags) } as EventBundle["sessions"][number]; if (editor.index < 0) next.sessions.push(item); else next.sessions[editor.index] = item; }
    if (editor.kind === "exhibitor") { const item = { ...value, name: string(value.name), description: string(value.description), booth: string(value.booth), categories: list(value.categories), organizationNames: list(value.organizationNames), featured: bool(value.featured), websiteUrl: string(value.websiteUrl) || null } as EventBundle["exhibitors"][number]; if (editor.index < 0) next.exhibitors.push(item); else next.exhibitors[editor.index] = item; }
    if (editor.kind === "fandom") {
      const rawId = Number(value.rawId);
      const entityType = string(value.entityType) as EventBundle["relatedSubjects"][number]["target"]["entityType"];
      try {
        next.relatedSubjects[editor.index] = { ...value, label: string(value.label), description: string(value.description), featured: bool(value.featured), target: { provider: "bangumi", entityType, rawId, encodedId: encodeLegacyBangumiId(rawId), canonicalKey: `bangumi:${entityType}:${rawId}` } } as EventBundle["relatedSubjects"][number];
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "Invalid Bangumi ID");
        return;
      }
    }
    if (editor.kind === "update") { const item = { ...value, title: string(value.title), summary: string(value.summary), publishedAt: string(value.publishedAt) || null, category: string(value.category), sourceName: string(value.sourceName), sourceUrl: string(value.sourceUrl) || null } as EventBundle["updates"][number]; if (editor.index < 0) next.updates.push(item); else next.updates[editor.index] = item; }
    void saveBundle(next);
  };

  const createEvent = async () => { if (!detail || !bundle) return; setActing(true); try { const result = await api<{ eventId: string }>(`/api/candidates/${detail.id}/materialize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(coreDraft(bundle)) }); window.location.assign(`/events/${result.eventId}`); } catch (error) { notify(error instanceof Error ? error.message : "Could not create review event"); } finally { setActing(false); } };
  const linkEvent = async () => { if (!detail || !linkEventId) return; setActing(true); try { const result = await api<{ eventId: string }>(`/api/candidates/${detail.id}/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: linkEventId }) }); window.location.assign(`/events/${result.eventId}`); } catch (error) { notify(error instanceof Error ? error.message : "Could not link event"); } finally { setActing(false); } };
  const reject = async () => { if (!detail || !window.confirm("Reject this candidate? Evidence is retained.")) return; setActing(true); try { await api(`/api/candidates/${detail.id}/reject`, { method: "POST" }); router.push("/candidates"); notify("Candidate rejected"); } catch (error) { notify(error instanceof Error ? error.message : "Could not reject candidate"); } finally { setActing(false); } };
  const rerun = async () => { if (!detail) return; setActing(true); try { await api(`/api/candidates/${detail.id}/retry-resolution`, { method: "POST" }); notify("LLM-required resolution queued"); router.push("/resolution-jobs"); } catch (error) { notify(error instanceof Error ? error.message : "Could not queue LLM resolution"); } finally { setActing(false); } };
  const importJson = async (value: unknown, filename: string) => { if (!detail) return; setActing(true); try { const saved = await api<{ bundle: EventBundle; revision: number; savedAt: string; processingMode: ReviewCandidateSummary["processingMode"] }>(`/api/candidates/${detail.id}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle: value, filename }) }); setBundle(saved.bundle); setDetail({ ...detail, bundle: saved.bundle, draft: coreDraft(saved.bundle), draftRevision: saved.revision, draftSavedAt: saved.savedAt, processingMode: saved.processingMode, processing: { ...detail.processing, mode: saved.processingMode } }); setImportOpen(false); notify(`JSON imported as draft revision ${saved.revision}`); } catch (error) { notify(error instanceof Error ? error.message : "Could not import JSON"); } finally { setActing(false); } };

  if (!initialCandidateId) return <CandidateQueue candidates={visible} total={candidates.length || initialCount} query={query} setQuery={setQuery} loading={loading} resolution={resolution} onOpen={(id) => router.push(`/candidates/${id}/overview`)}/>;
  if (loading || !detail || !bundle) return <section className="panel candidate-loading"><LoaderCircle className="spin" size={20}/>Loading candidate editor...</section>;

  const hero = bundle.media.find((media) => media.role === "EVENT_HERO")?.url || detail.media.find((media) => /hero|cover|banner/i.test(media.category))?.url || detail.media[0]?.url || "";
  const editable = detail.status === "PENDING" && !detail.publishedEventId;
  const steps = [{ label: "Crawl complete", done: true }, { label: "Evidence prepared", note: "Deduplicated · provenance kept", done: true }, { label: "Processed", note: processingLabel(detail.processingMode), done: true, warning: detail.processingMode === "DETERMINISTIC_FALLBACK" || detail.processingMode === "DETERMINISTIC_ONLY" }, { label: "Editorial review", note: "In progress", active: true, done: false }, { label: "Published", note: "Pending", done: false }];

  return <>
    <div className="candidate-editor-head"><Link href="/candidates"><ArrowLeft size={15}/> Candidate queue</Link><div><span className={`candidate-processing-badge ${detail.processingMode.toLowerCase().replaceAll("_", "-")}`}>{processingLabel(detail.processingMode)}</span><a className="candidate-tool-button" href={`/api/candidates/${detail.id}/export`} download><Download size={14}/> Export raw bundle</a><button onClick={() => setImportOpen(true)}><FileJson size={14}/> Import JSON</button><button onClick={() => setEvidenceOpen(true)}><ShieldCheck size={14}/> Source evidence</button>{detail.processingMode === "DETERMINISTIC_FALLBACK" || detail.processingMode === "DETERMINISTIC_ONLY" ? <button onClick={() => void rerun()} disabled={acting}><RotateCcw size={14}/> Re-run with LLM</button> : null}</div></div>
    <section className="candidate-pipeline panel" aria-label="Candidate progress">{steps.map((step, index) => <div key={step.label} className={`${step.done ? "done" : ""} ${step.warning ? "warning" : ""} ${step.active ? "active" : ""}`}><span>{step.done ? <Check size={13}/> : <Circle size={10}/>}</span><span className="candidate-step-copy"><b>{step.label}</b>{step.note ? <small>{step.note}</small> : null}</span>{index < steps.length - 1 ? <i/> : null}</div>)}</section>
    {!editable ? <div className="candidate-readonly-notice" role="status">This Candidate is {titleCase(detail.status)} and can no longer be saved as a draft. {detail.publishedEventId ? <Link href={`/events/${detail.publishedEventId}`}>Edit the linked Event →</Link> : <Link href="/candidates">Return to the review queue →</Link>}</div> : null}
    <details className="candidate-more-info panel"><summary>More info <span>Model, prompt, token metrics, crawl run, draft revision and warnings</span></summary><div className="candidate-processing-grid"><dl><div><dt>Model</dt><dd>{detail.processing.modelProvider} / {detail.processing.modelName}</dd></div><div><dt>Prompt</dt><dd>{detail.processing.promptVersion}</dd></div><div><dt>Documents</dt><dd>{detail.processing.documentCount}</dd></div><div><dt>Draft revision</dt><dd>{detail.draftRevision || "Original"}</dd></div></dl><dl><div><dt>Input tokens</dt><dd>{formatMetric(detail.processing.inputTokens)}</dd></div><div><dt>Output tokens</dt><dd>{formatMetric(detail.processing.outputTokens)}</dd></div><div><dt>Duration</dt><dd>{formatMetric(detail.processing.durationMs, " ms")}</dd></div><div><dt>Run</dt><dd>{detail.processing.crawlRunId?.slice(0, 8) || "Unknown"}</dd></div></dl></div>{detail.processing.warnings.length ? <div className="candidate-warning-list"><b>Warnings</b><ul>{detail.processing.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}</details>
    <article className={`candidate-event-preview ${editable ? "" : "read-only"}`}>
      <section className="candidate-hero" style={hero ? { backgroundImage: `linear-gradient(90deg, rgba(8,9,13,.96) 0%, rgba(8,9,13,.75) 48%, rgba(8,9,13,.12) 100%), url("${hero.replaceAll('"', '%22')}")` } : undefined}><PencilButton label="Edit event overview" onClick={openOverview}/><span className="candidate-event-type">{titleCase(bundle.event.eventType)}</span><h1>{bundle.event.name}</h1><p className="candidate-hero-meta"><CalendarDays size={16}/>{displayDate(bundle.event.startDate)} to {displayDate(bundle.event.endDate)}<MapPin size={16}/>{bundle.event.venue.name || "Venue pending"}, {[bundle.event.venue.city, bundle.event.venue.region].filter(Boolean).join(", ")}</p><p>{bundle.event.description || "No public summary has been extracted yet."}</p><div className="candidate-hero-actions"><a href={bundle.event.officialUrl} target="_blank" rel="noreferrer">Official website <ExternalLink size={14}/></a><button onClick={() => setEvidenceOpen(true)}>View provenance</button></div></section>
      <nav className="candidate-tabs" aria-label="Candidate editor tabs">{tabs.map((tab) => <Link key={tab.id} className={initialTab === tab.id ? "active" : ""} href={`/candidates/${detail.id}/${tab.id}`}>{tab.label}<span>{tab.id === "schedule" ? bundle.sessions.length : tab.id === "exhibitors" ? bundle.exhibitors.length : tab.id === "fandoms" ? bundle.relatedSubjects.length : tab.id === "updates" ? bundle.updates.length : ""}</span></Link>)}</nav>
      <div className="candidate-tab-body">{initialTab === "overview" ? <OverviewTab bundle={bundle} openOverview={openOverview} openSupport={openSupport}/> : null}{initialTab === "schedule" ? <ScheduleTab bundle={bundle} media={detail.media} onEdit={(index) => openItem("session", index, bundle.sessions[index])} onAdd={() => addItem("session")}/> : null}{initialTab === "exhibitors" ? <ExhibitorsTab bundle={bundle} media={detail.media} onEdit={(index) => openItem("exhibitor", index, bundle.exhibitors[index])} onAdd={() => addItem("exhibitor")}/> : null}{initialTab === "fandoms" ? <FandomsTab bundle={bundle} onEdit={(index) => openItem("fandom", index, { ...bundle.relatedSubjects[index], rawId: bundle.relatedSubjects[index].target.rawId, entityType: bundle.relatedSubjects[index].target.entityType })}/> : null}{initialTab === "updates" ? <UpdatesTab bundle={bundle} media={detail.media} onEdit={(index) => openItem("update", index, bundle.updates[index])} onAdd={() => addItem("update")}/> : null}</div>
    </article>
    <div className="candidate-action-bar"><span><b>{detail.draftSavedAt ? `Draft revision ${detail.draftRevision}` : "Original model output"}</b><small>{detail.draftSavedAt ? `Saved ${new Date(detail.draftSavedAt).toLocaleString()}` : "No human edits saved yet"}</small></span>{editable ? <><button className="candidate-reject" onClick={() => void reject()} disabled={acting}><XCircle size={14}/> Reject</button><button onClick={() => setLinkOpen(true)} disabled={acting}><Link2 size={14}/> Choose existing event</button><button className="primary-button" onClick={() => void createEvent()} disabled={acting}><CheckCircle2 size={14}/> Create Review Event</button></> : detail.publishedEventId ? <Link href={`/events/${detail.publishedEventId}`}>Open linked Event →</Link> : null}</div>
    {editor ? <EditorDialog editor={editor} setEditor={setEditor} media={detail.media} onClose={() => setEditor(null)} onSave={commitEditor} busy={acting} error={saveError} onErrorClear={() => setSaveError("")}/> : null}
    {evidenceOpen ? <EvidenceDrawer detail={detail} onClose={() => setEvidenceOpen(false)}/> : null}
    {importOpen ? <JsonImportDialog busy={acting} onClose={() => setImportOpen(false)} onImport={importJson}/> : null}
    {linkOpen ? <div className="candidate-modal-backdrop"><button className="modal-dismiss" onClick={() => setLinkOpen(false)} aria-label="Close"/><section className="candidate-editor-dialog small" role="dialog" aria-modal="true"><header><div><h2>Choose existing event</h2><p>Attach this candidate and all evidence instead of creating a duplicate.</p></div><button onClick={() => setLinkOpen(false)}><X size={16}/></button></header><label className="candidate-modal-search"><Search size={14}/><input aria-label="Search existing events" value={eventQuery} onChange={(event) => setEventQuery(event.target.value)} placeholder="Search events..."/></label><div className="candidate-existing-list">{visibleEvents.map((event) => <label key={event.id}><input aria-label={`Choose ${event.title}`} type="radio" name="event" checked={linkEventId === event.id} onChange={() => setLinkEventId(event.id)}/><span><b>{event.title}</b><small>{displayDate(event.startAt)} · {titleCase(event.status)}</small></span></label>)}</div><footer><button onClick={() => setLinkOpen(false)}>Cancel</button><button className="primary-button" disabled={!linkEventId || acting} onClick={() => void linkEvent()}>Link event</button></footer></section></div> : null}
  </>;
}

function CandidateQueue({ candidates, total, query, setQuery, loading, resolution, onOpen }: { candidates: ReviewCandidateSummary[]; total: number; query: string; setQuery: (value: string) => void; loading: boolean; resolution: ReviewResolutionStatus | null; onOpen: (id: string) => void }) {
  type SortField = "candidate" | "stage" | "method" | "date" | "confidence" | "source";
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const sorted = useMemo(() => [...candidates].sort((left, right) => compareValues(
    sortField === "candidate" ? left.proposedTitle || left.documentTitle
      : sortField === "stage" ? 4
      : sortField === "method" ? processingLabel(left.processingMode)
      : sortField === "date" ? left.proposedStartAt || left.createdAt
      : sortField === "confidence" ? left.confidence
      : left.sourceName,
    sortField === "candidate" ? right.proposedTitle || right.documentTitle
      : sortField === "stage" ? 4
      : sortField === "method" ? processingLabel(right.processingMode)
      : sortField === "date" ? right.proposedStartAt || right.createdAt
      : sortField === "confidence" ? right.confidence
      : right.sourceName,
    sortDirection,
  )), [candidates, sortDirection, sortField]);
  const sort = (field: SortField) => { const next = nextSort(sortField, sortDirection, field); setSortField(next.field); setSortDirection(next.direction); };
  return <><div className="page-head"><div><p className="eyebrow">Editorial review</p><h1>Candidate queue</h1><p>One aggregate candidate represents one crawl run and opens as a complete event preview.</p>{resolution ? <p>Latest resolution: {resolution.sourceName} · {titleCase(resolution.status)} · {resolution.documentCount} documents</p> : null}</div><span className="candidate-count">{total} candidates ready</span></div><div className="filterbar candidate-queue-filter"><label className="table-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search candidates..."/></label><span className="result-count">{candidates.length} shown</span></div><section className="data-panel candidate-queue-table"><div className="table-head candidate-queue-row"><SortHeader label="Candidate" field="candidate" activeField={sortField} direction={sortDirection} onSort={sort}/><SortHeader label="Stage" field="stage" activeField={sortField} direction={sortDirection} onSort={sort}/><SortHeader label="Method" field="method" activeField={sortField} direction={sortDirection} onSort={sort}/><SortHeader label="Date & venue" field="date" activeField={sortField} direction={sortDirection} onSort={sort}/><SortHeader label="Confidence" field="confidence" activeField={sortField} direction={sortDirection} onSort={sort}/><SortHeader label="Source" field="source" activeField={sortField} direction={sortDirection} onSort={sort}/><span/></div>{sorted.map((candidate) => <div className="candidate-queue-row table-row" key={candidate.id}><span><strong>{candidate.proposedTitle || candidate.documentTitle}</strong><small>{candidate.id.slice(0, 8)} · {titleCase(candidate.pageType)}</small></span><span className="candidate-stage-cell"><b>Editorial review</b><small><i/><i/><i/><i className="active"/><i/> 4 of 5</small></span><span><b className={`candidate-processing-badge ${candidate.processingMode.toLowerCase().replaceAll("_", "-")}`}>{processingLabel(candidate.processingMode)}</b></span><span><strong>{displayDate(candidate.proposedStartAt || null)}</strong><small>{candidate.proposedLocation || "Venue pending"}</small></span><span>{percent(candidate.confidence)}</span><span>{candidate.sourceName}</span><span><button className="candidate-row-arrow" onClick={() => onOpen(candidate.id)} aria-label={`Open ${candidate.proposedTitle || candidate.documentTitle}`}><ArrowRight size={16}/></button></span></div>)}{loading ? <div className="empty-table"><LoaderCircle className="spin" size={20}/><strong>Loading candidates</strong></div> : !candidates.length ? <div className="empty-table"><FileSearch size={20}/><strong>No matching candidates</strong><span>Run a source or change the search.</span></div> : null}</section></>;
}

function Section({ title, description, action, children, className = "" }: { title: string; description: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) { return <section className={`candidate-content-section ${className}`}><header><div><h2>{title}</h2><p>{description}</p></div>{action}</header>{children}</section>; }

function OverviewTab({ bundle, openOverview, openSupport }: { bundle: EventBundle; openOverview: () => void; openSupport: () => void }) {
  return <div className="candidate-overview-grid"><div><Section title={`About ${bundle.event.name}`} description="Public event summary" action={<PencilButton label="Edit event information" onClick={openOverview}/>}><p className="candidate-about-copy">{bundle.event.description || "No description provided."}</p><div className="candidate-fact-strip"><span><CalendarDays size={17}/><b>{bundle.facts.find((fact) => fact.type === "DURATION_DAYS")?.value || "Pending"}</b><small>Days</small></span><span><Building2 size={17}/><b>{bundle.exhibitors.length}</b><small>Exhibitors</small></span><span><Sparkles size={17}/><b>{bundle.sessions.length}</b><small>Sessions</small></span><span><Users size={17}/><b>{bundle.guests.length}</b><small>Guests</small></span></div></Section><Section title="Featured exhibitors" description="Organizations with the strongest source support"><div className="candidate-mini-cards">{bundle.exhibitors.slice(0, 5).map((item) => <article key={item.externalKey}><b>{item.name}</b><small>{item.booth || item.categories.join(" · ") || "Details pending"}</small></article>)}{!bundle.exhibitors.length ? <p>No exhibitors extracted yet.</p> : null}</div></Section></div><aside><Section title="Event details" description="Venue, organizer and official links" action={<PencilButton label="Edit event details" onClick={openOverview}/>}><dl className="candidate-detail-list"><div><dt><MapPin size={15}/>Venue</dt><dd>{bundle.event.venue.name || "Pending"}<small>{[bundle.event.venue.addressLine1, bundle.event.venue.city, bundle.event.venue.region, bundle.event.venue.countryCode].filter(Boolean).join(", ")}</small></dd></div><div><dt><CalendarDays size={15}/>Dates</dt><dd>{displayDate(bundle.event.startDate)} to {displayDate(bundle.event.endDate)}<small>{bundle.event.timezone}</small></dd></div><div><dt><Users size={15}/>Organizer</dt><dd>{bundle.event.organizerNames.join(", ") || "Pending"}</dd></div></dl></Section><Section title="Quick facts & access" description="Links, tickets, and sourced facts" action={<PencilButton label="Edit facts and links" onClick={openSupport}/>}><div className="candidate-support-list">{bundle.links.slice(0, 5).map((item) => <a href={item.url} key={`${item.type}-${item.url}`} target="_blank" rel="noreferrer"><Link2 size={14}/><span><b>{item.label || titleCase(item.type)}</b><small>{item.url}</small></span></a>)}{bundle.ticketOffers.slice(0, 3).map((item) => <span key={item.externalKey}><Ticket size={14}/><span><b>{item.name}</b><small>{item.priceText || titleCase(item.availability)}</small></span></span>)}</div></Section></aside></div>;
}

type ReviewMedia = ReviewCandidateDetail["media"];
const mediaUrl = (media: ReviewMedia, id: string | null) => id ? media.find((item) => item.id === id)?.url : undefined;

function ScheduleTab({ bundle, media, onEdit, onAdd }: { bundle: EventBundle; media: ReviewMedia; onEdit: (index: number) => void; onAdd: () => void }) {
  const groups = new Map<string, Array<{ item: EventBundle["sessions"][number]; index: number }>>(); bundle.sessions.forEach((item, index) => { const key = displayDate(item.startDate); groups.set(key, [...(groups.get(key) || []), { item, index }]); });
  return <Section title="Schedule" description="Panels, concerts, signings, screenings and more" action={<button className="candidate-add-button" onClick={onAdd}><Plus size={14}/><span>Add session</span></button>}><div className="candidate-schedule">{[...groups.entries()].map(([day, items]) => <div key={day}><h3>{day}</h3>{items.map(({ item, index }) => <article key={item.externalKey}>{mediaUrl(media, item.imageMediaCandidateId) ? <img className="candidate-session-image" src={mediaUrl(media, item.imageMediaCandidateId)} alt=""/> : null}<time>{displayTime(item.startDate)}<small>{item.endDate ? `to ${displayTime(item.endDate)}` : ""}</small></time><span className={`candidate-session-color ${item.sessionType.toLowerCase()}`}/><div><b>{item.title}</b><p>{item.description || "No description."}</p><small>{titleCase(item.sessionType)} · {item.venueName || bundle.event.venue.name} {item.room ? `· ${item.room}` : ""}</small></div><PencilButton label={`Edit ${item.title}`} onClick={() => onEdit(index)}/></article>)}</div>)}{!bundle.sessions.length ? <Empty icon={<CalendarDays/>} label="No sessions extracted yet"/> : null}</div></Section>;
}

function ExhibitorsTab({ bundle, media, onEdit, onAdd }: { bundle: EventBundle; media: ReviewMedia; onEdit: (index: number) => void; onAdd: () => void }) { return <Section title="Exhibitors" description="Brands, creators, publishers, vendors and artists" action={<button className="candidate-add-button" onClick={onAdd}><Plus size={14}/><span>Add exhibitor</span></button>}><div className="candidate-exhibitor-grid">{bundle.exhibitors.map((item, index) => <article key={item.externalKey}><PencilButton label={`Edit ${item.name}`} onClick={() => onEdit(index)}/>{item.featured ? <span>Featured</span> : null}{mediaUrl(media, item.logoMediaCandidateId) ? <img className="candidate-org-image" src={mediaUrl(media, item.logoMediaCandidateId)} alt=""/> : <div className="candidate-org-mark">{item.name.slice(0, 2).toUpperCase()}</div>}<h3>{item.name}</h3><b>{item.booth || "Booth pending"}</b><div>{item.categories.map((category) => <small key={category}>{category}</small>)}</div><p>{item.description || "No exhibitor description."}</p>{item.websiteUrl ? <a href={item.websiteUrl} target="_blank" rel="noreferrer">Website <ExternalLink size={12}/></a> : null}</article>)}{!bundle.exhibitors.length ? <Empty icon={<Building2/>} label="No exhibitors extracted yet"/> : null}</div></Section>; }

function FandomsTab({ bundle, onEdit }: { bundle: EventBundle; onEdit: (index: number) => void }) { return <Section title="Related Fandoms" description="Bangumi-backed subjects linked to this event"><div className="candidate-fandom-grid">{bundle.relatedSubjects.map((item, index) => <article key={item.target.canonicalKey}><PencilButton label={`Edit ${item.label}`} onClick={() => onEdit(index)}/><div className="candidate-fandom-art"><ImageIcon size={24}/></div><div><h3>{item.label}</h3><p>{item.description || "Related through event programming and source evidence."}</p><small>{item.target.canonicalKey} · {percent(item.confidence)} confidence</small></div></article>)}{!bundle.relatedSubjects.length ? <Empty icon={<Sparkles/>} label="No related fandoms resolved yet"/> : null}</div></Section>; }

function UpdatesTab({ bundle, media, onEdit, onAdd }: { bundle: EventBundle; media: ReviewMedia; onEdit: (index: number) => void; onAdd: () => void }) { return <Section title="Latest Updates" description="Announcements and changes from tracked sources" action={<button className="candidate-add-button" onClick={onAdd}><Plus size={14}/><span>Add update</span></button>}><div className="candidate-update-list">{bundle.updates.map((item, index) => <article key={item.externalKey}>{mediaUrl(media, item.imageMediaCandidateId) ? <img className="candidate-update-image" src={mediaUrl(media, item.imageMediaCandidateId)} alt=""/> : <span className="candidate-update-icon"><Sparkles size={17}/></span>}<div><small>{item.sourceName || "Official source"} · {displayDate(item.publishedAt)}</small><h3>{item.title}</h3><p>{item.summary || "No summary."}</p><b>{titleCase(item.category)}</b></div><PencilButton label={`Edit ${item.title}`} onClick={() => onEdit(index)}/></article>)}{!bundle.updates.length ? <Empty icon={<FileSearch/>} label="No updates extracted yet"/> : null}</div></Section>; }

function Empty({ icon, label }: { icon: React.ReactNode; label: string }) { return <div className="candidate-tab-empty">{icon}<b>{label}</b><span>You can add it manually or re-run resolution.</span></div>; }

function JsonImportDialog({ busy, onClose, onImport }: { busy: boolean; onClose: () => void; onImport: (bundle: unknown, filename: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const submit = () => {
    try { setError(""); void onImport(JSON.parse(value) as unknown, filename || "pasted-event-bundle.json"); }
    catch { setError("This is not valid JSON. Codex must return one JSON object without a Markdown fence."); }
  };
  return <div className="candidate-modal-backdrop"><button className="modal-dismiss" onClick={onClose} aria-label="Close JSON importer"/><section className="candidate-editor-dialog json-import-dialog" role="dialog" aria-modal="true" aria-label="Import Event Content Bundle JSON"><header><div><h2>Import JSON override</h2><p>This creates a new human-reviewed draft revision. The original crawler and model result remain immutable.</p></div><button onClick={onClose}><X size={16}/></button></header><div className="json-import-body"><label className="json-file-drop"><Upload size={20}/><span><b>{filename || "Choose event-bundle.json"}</b><small>Validated against event-content-bundle/v2</small></span><input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; setFilename(file.name); setError(""); void file.text().then(setValue); }}/></label><label><span>Or paste the complete JSON object</span><textarea rows={18} value={value} onChange={(event) => { setValue(event.target.value); setFilename(""); setError(""); }} placeholder={'{\n  "schemaVersion": "event-content-bundle/v2",\n  ...\n}'}/></label>{error ? <p className="json-import-error">{error}</p> : null}<p>Unknown document IDs, invalid Bangumi encoded IDs, unsupported enums, and malformed URLs are rejected before the draft is changed.</p></div><footer><button onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !value.trim()} onClick={submit}>{busy ? <LoaderCircle className="spin" size={14}/> : <FileJson size={14}/>} Validate and override draft</button></footer></section></div>;
}

function EditorDialog({ editor, setEditor, media, onClose, onSave, busy, error, onErrorClear }: { editor: EditorState; setEditor: (state: EditorState) => void; media: ReviewMedia; onClose: () => void; onSave: () => void; busy: boolean; error: string; onErrorClear: () => void }) {
  const set = (key: string, value: unknown) => { onErrorClear(); setEditor({ ...editor, value: { ...editor.value, [key]: value } }); };
  const field = (label: string, key: string, options?: string[]) => <label><span>{label}</span>{options ? <select value={string(editor.value[key])} onChange={(event) => set(key, event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select> : <input value={string(editor.value[key])} onChange={(event) => set(key, event.target.value)}/>}</label>;
  const area = (label: string, key: string, rows = 4) => <label className="wide-field"><span>{label}</span><textarea rows={rows} value={string(editor.value[key])} onChange={(event) => set(key, event.target.value)}/></label>;
  return <div className="candidate-modal-backdrop"><button className="modal-dismiss" onClick={onClose} aria-label="Close editor"/><section className="candidate-editor-dialog" role="dialog" aria-modal="true"><header><div><h2>Edit {titleCase(editor.kind)}</h2><p>Changes are saved to a versioned candidate draft and retain the original evidence.</p></div><button onClick={onClose}><X size={16}/></button></header><div className="candidate-editor-fields">
    {editor.kind === "overview" ? <><MediaAssetField label="Event hero image" value={string(editor.value.heroMediaCandidateId) || null} media={media} onChange={(value) => set("heroMediaCandidateId", value)}/>{field("Event name", "name")}{field("Event type", "eventType", eventTypes)}{area("Public description", "description", 5)}{field("Start date (ISO)", "startDate")}{field("End date (ISO)", "endDate")}{field("Timezone", "timezone")}{field("Official URL", "officialUrl")}{field("Alternate names (comma separated)", "alternateNames")}{field("Organizers (comma separated)", "organizerNames")}<h3 className="wide-field">Venue</h3>{field("Venue name", "venueName")}{field("Address", "addressLine1")}{field("City", "city")}{field("Region", "region")}{field("Postal code", "postalCode")}{field("Country code", "countryCode")}</> : null}
    {editor.kind === "support" ? <>{area("Links · TYPE|Label|URL, one per line", "links", 6)}{area("Facts · TYPE|Label|Value|Unit, one per line", "facts", 6)}{area("Tickets · Name|Price|Availability|URL, one per line", "tickets", 6)}</> : null}
    {editor.kind === "session" ? <><MediaAssetField label="Session image" value={string(editor.value.imageMediaCandidateId) || null} media={media} onChange={(value) => set("imageMediaCandidateId", value)}/>{field("Title", "title")}{field("Session type", "sessionType", sessionTypes)}{area("Description", "description")}{field("Start date (ISO)", "startDate")}{field("End date (ISO)", "endDate")}{field("Timezone", "timezone")}{field("Venue", "venueName")}{field("Room", "room")}{field("Age rating", "ageRating")}{field("Organizations (comma separated)", "organizationNames")}{field("Tags (comma separated)", "tags")}</> : null}
    {editor.kind === "exhibitor" ? <><MediaAssetField label="Exhibitor logo or image" value={string(editor.value.logoMediaCandidateId) || null} media={media} onChange={(value) => set("logoMediaCandidateId", value)}/>{field("Name", "name")}{field("Booth", "booth")}{area("Description", "description")}{field("Categories (comma separated)", "categories")}{field("Organizations (comma separated)", "organizationNames")}{field("Website URL", "websiteUrl")}<label className="candidate-checkbox"><input type="checkbox" checked={bool(editor.value.featured)} onChange={(event) => set("featured", event.target.checked)}/><span>Featured exhibitor</span></label></> : null}
    {editor.kind === "fandom" ? <>{field("Display label", "label")}{field("Bangumi ID", "rawId")}{field("Entity type", "entityType", ["subject", "person", "character", "episode"])}{area("Description", "description")}<label className="candidate-checkbox"><input type="checkbox" checked={bool(editor.value.featured)} onChange={(event) => set("featured", event.target.checked)}/><span>Featured fandom</span></label></> : null}
    {editor.kind === "update" ? <><MediaAssetField label="Update image" value={string(editor.value.imageMediaCandidateId) || null} media={media} onChange={(value) => set("imageMediaCandidateId", value)}/>{field("Title", "title")}{field("Category", "category", updateCategories)}{area("Summary", "summary")}{field("Published at (ISO)", "publishedAt")}{field("Source name", "sourceName")}{field("Source URL", "sourceUrl")}</> : null}
  </div><footer>{error ? <p className="candidate-save-error" role="alert">{error}</p> : null}<button onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy} onClick={onSave}>{busy ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>} Save changes</button></footer></section></div>;
}

function MediaAssetField({ label, value, media, onChange }: { label: string; value: string | null; media: ReviewMedia; onChange: (value: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const selected = media.find((item) => item.id === value);
  const categories = useMemo(() => [...new Set(media.map((item) => item.category).filter(Boolean))].sort(), [media]);
  const visible = useMemo(() => media.filter((item) => category === "ALL" || item.category === category).filter((item) => !query || `${item.category} ${item.url} ${item.width || ""} ${item.height || ""}`.toLowerCase().includes(query.toLowerCase())), [category, media, query]);
  return <div className="media-asset-field wide-field"><span>{label}</span><button type="button" onClick={() => setOpen(true)}>{selected ? <img src={selected.url} alt=""/> : <span className="media-default-art"><ImageIcon size={20}/></span>}<span><b>{selected ? titleCase(selected.category) : "Automatic event artwork"}</b><small>{selected ? `${selected.width || "?"} × ${selected.height || "?"} · ${selected.url}` : "Uses the event default when no source image is selected."}</small></span><Pencil size={14}/></button>{open ? <div className="media-picker-backdrop"><section className="media-picker" role="dialog" aria-modal="true" aria-label={`Choose ${label.toLowerCase()}`}><header><div><h3>Choose media</h3><p>{media.length} assets from this event’s crawl evidence</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Close media picker"><X size={16}/></button></header><div className="media-picker-tools"><label><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search URL, category, or size…"/></label><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Media category"><option value="ALL">All tags</option>{categories.map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</select></div><div className="media-picker-grid"><button type="button" className={!value ? "selected" : ""} onClick={() => { onChange(null); setOpen(false); }}><span className="media-default-art"><ImageIcon size={25}/></span><b>Automatic default</b><small>Default artwork</small></button>{visible.map((item) => <button type="button" className={value === item.id ? "selected" : ""} key={item.id} onClick={() => { onChange(item.id); setOpen(false); }}><img src={item.url} alt="" loading="lazy"/><b>{titleCase(item.category)}</b><small>{item.width && item.height ? `${item.width} × ${item.height}` : "Size pending"}</small><span>{titleCase(item.category)}</span></button>)}</div>{!visible.length ? <div className="media-picker-empty"><ImageIcon size={22}/><b>No matching media</b><span>Try another search or tag.</span></div> : null}</section></div> : null}</div>;
}

function EvidenceDrawer({ detail, onClose }: { detail: ReviewCandidateDetail; onClose: () => void }) {
  const grouped = useMemo(() => { const groups = new Map<string, typeof detail.assertions>(); detail.assertions.forEach((item) => groups.set(item.fieldPath, [...(groups.get(item.fieldPath) || []), item])); return [...groups.entries()]; }, [detail]);
  return <div className="candidate-drawer-backdrop"><button className="modal-dismiss" onClick={onClose} aria-label="Close evidence"/><aside className="candidate-evidence-drawer"><header><div><h2>Source evidence</h2><p>{detail.processing.documentCount} documents · {detail.assertions.length} extracted fields · {detail.media.length} media</p></div><button onClick={onClose}><X size={17}/></button></header><a className="candidate-source-link" href={detail.canonicalUrl} target="_blank" rel="noreferrer"><span><b>{detail.sourceName}</b><small>{detail.documentTitle}</small></span><ExternalLink size={14}/></a><div className="candidate-evidence-groups">{grouped.map(([field, assertions]) => <section key={field}><h3>{titleCase(field)}</h3>{assertions.slice(0, 3).map((assertion) => <article key={assertion.id}><header><b>{percent(assertion.confidence)} confidence</b><span>{assertion.locator || "Document content"}</span></header><p>{assertion.excerpt || string(assertion.normalizedValue || assertion.value) || "Structured value extracted"}</p></article>)}</section>)}</div><details><summary>Source text ({detail.chunks.length} chunks)</summary>{detail.chunks.map((chunk) => <article className="candidate-evidence-chunk" key={chunk.id}><b>{chunk.heading || `Chunk ${chunk.index + 1}`}</b><p>{chunk.content}</p></article>)}</details><details><summary>Media ({detail.media.length})</summary><div className="candidate-evidence-media">{detail.media.map((media) => <a key={media.id} href={media.url} target="_blank" rel="noreferrer"><ImageIcon size={14}/><span>{titleCase(media.category)}<small>{media.width && media.height ? `${media.width} × ${media.height}` : "Dimensions pending"}</small></span></a>)}</div></details></aside></div>;
}
