"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock3, Database, FileArchive, Play, Plus, RefreshCw, Server, ShieldCheck, Workflow, X } from "lucide-react";
import type { ConsoleSnapshot, ConsoleSource } from "@/db/console";
import type { CrawlerDashboardStatus } from "@/db/crawler";
import { compareValues, nextSort, SortHeader, TablePagination, TableSearch, type SortDirection } from "./ConsoleTableControls";

type Notify = (message: string) => void;
type CrawlRunDetail = {
  run: Record<string, unknown> & { id: string; sourceName: string; status: string; rootUrl: string; pagesScheduled: number; pagesFetched: number; pagesUnchanged: number; pagesFailed: number; documentsCreated: number; bytesFetched: number; mediaDiscovered: number; logoStatus: string };
  discoveries: Array<Record<string, unknown> & { id: string; normalized_url: string; link_kind: string; page_hint: string; decision: string; decision_reason: string }>;
  documents: Array<Record<string, unknown> & { id: string; canonical_url: string; document_type: string; page_type: string; fetched_at: string; byte_size: number }>;
  media: Array<Record<string, unknown> & { id: string; resolved_url: string; category: string; fetch_status: string }>;
  sourceCandidates: Array<Record<string, unknown> & { id: string; candidate_type: string; url: string; confidence: number; status: string }>;
};
type RawDocumentDetail = { document: Record<string, unknown> & { id: string; canonical_url: string; document_type: string; page_type: string; fetched_at: string; content_hash: string; mime_type: string; byte_size: number; source_name: string; r2_bucket: string; r2_key: string }; chunks: Array<Record<string, unknown> & { id: string; heading_path: string; content: string }>; candidates: Array<Record<string, unknown> & { id: string; candidate_type: string; status: string }>; media: Array<Record<string, unknown> & { id: string; category: string; resolved_url: string }> };

function PageHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-head"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function stableUtcTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : `${date.toISOString().slice(11, 19)} UTC`;
}

function LocalDate({ value }: { value: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const date = new Date(value);
      setLabel(Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [value]);
  const date = new Date(value);
  const fallback = Number.isNaN(date.getTime()) ? "Unknown date" : `${date.toISOString().slice(0, 10)} UTC`;
  return <time dateTime={value}>{label ?? fallback}</time>;
}

function LocalTime({ value }: { value: string }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const date = new Date(value);
      setLabel(Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleTimeString());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [value]);
  return <time dateTime={value}>{label ?? stableUtcTime(value)}</time>;
}

async function apiRequest<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function relativeAgeSeconds(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "never" || normalized === "unknown") return Number.POSITIVE_INFINITY;
  if (normalized === "now" || normalized === "just now") return 0;
  const match = normalized.match(/([\d.]+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)/);
  if (!match) return Number.POSITIVE_INFINITY;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith("w")) return amount * 604_800;
  if (unit.startsWith("d")) return amount * 86_400;
  if (unit.startsWith("h")) return amount * 3_600;
  if (unit.startsWith("m")) return amount * 60;
  return amount;
}

export function SourcesWorkspace({
  initialSources,
  totals,
  notify,
  onOpenJobs,
}: {
  initialSources: ConsoleSource[];
  totals: ConsoleSnapshot["totals"];
  notify: Notify;
  onOpenJobs: () => void;
}) {
  type SourceSort = "name" | "type" | "trust" | "policyStatus" | "lastSuccess" | "items" | "dataOrigin";
  const [sources, setSources] = useState(initialSources);
  const [addOpen, setAddOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ConsoleSource | null>(null);
  const [busyId, setBusyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const initialQuery = new URLSearchParams(window.location.search).get("q");
    if (!initialQuery) return;
    const frame = window.requestAnimationFrame(() => setQuery(initialQuery));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const [policy, setPolicy] = useState("All policies");
  const [connector, setConnector] = useState("All types");
  const [sortField, setSortField] = useState<SourceSort>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const sourceTypes = useMemo(() => [...new Set(sources.map((source) => source.type))].sort(), [sources]);
  const visibleSources = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sources
      .filter((source) => policy === "All policies" || (policy === "Enabled" && source.enabled) || (policy === "Needs review" && source.policyStatus === "UNKNOWN") || (policy === "Disabled" && !source.enabled))
      .filter((source) => connector === "All types" || source.type === connector)
      .filter((source) => !needle || [source.name, source.baseUrl, source.type, source.trust, source.policyStatus, source.dataOrigin].some((value) => value.toLowerCase().includes(needle)))
      .sort((left, right) => compareValues(
        sortField === "items" ? Number(left.items) : sortField === "lastSuccess" ? relativeAgeSeconds(left.lastSuccess) : left[sortField],
        sortField === "items" ? Number(right.items) : sortField === "lastSuccess" ? relativeAgeSeconds(right.lastSuccess) : right[sortField],
        sortDirection,
      ));
  }, [connector, policy, query, sortDirection, sortField, sources]);
  const sort = (field: SourceSort) => {
    const next = nextSort(sortField, sortDirection, field);
    setSortField(next.field);
    setSortDirection(next.direction);
  };

  const updateSource = (source: ConsoleSource) => {
    setSources((current) => {
      const exists = current.some((item) => item.id === source.id);
      return exists ? current.map((item) => item.id === source.id ? source : item) : [source, ...current];
    });
  };

  const runSource = async (source: ConsoleSource) => {
    setBusyId(source.id);
    try {
      await apiRequest(`/api/crawler/sources/${source.id}/run`, { method: "POST" });
      notify(`${source.name} crawl queued`);
      onOpenJobs();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not queue crawl");
    } finally {
      setBusyId("");
    }
  };

  return <>
    <PageHead eyebrow="Ingestion control" title="Sources" description="Create, approve, and run policy-aware crawler sources" action={<button className="primary-button" onClick={() => setAddOpen(true)}><Plus size={13}/> Add source</button>}/>
    <section className="metrics compact-metrics">
      <article><span className="metric-icon violet"><Database size={18}/></span><span>Configured</span><strong>{sources.length}</strong><small>Database sources</small></article>
      <article><span className="metric-icon green"><ShieldCheck size={18}/></span><span>Enabled</span><strong>{sources.filter((source) => source.enabled).length}</strong><small>Approved to crawl</small></article>
      <article><span className="metric-icon amber"><AlertTriangle size={18}/></span><span>Policy review</span><strong>{sources.filter((source) => source.policyStatus === "UNKNOWN").length}</strong><small>Need a decision</small></article>
      <article><span className="metric-icon blue"><FileArchive size={18}/></span><span>Stored items</span><strong>{sources.reduce((sum, source) => sum + Number(source.items), 0)}</strong><small>{totals.queuedJobs} active jobs</small></article>
    </section>
    <div className="filterbar table-toolbar">
      <TableSearch value={query} onChange={setQuery} placeholder="Search sources..." />
      <label className="table-select"><select aria-label="Source policy" value={policy} onChange={(event) => setPolicy(event.target.value)}><option>All policies</option><option>Enabled</option><option>Needs review</option><option>Disabled</option></select></label>
      <label className="table-select"><select aria-label="Source type" value={connector} onChange={(event) => setConnector(event.target.value)}><option>All types</option>{sourceTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
      <span className="result-count">{visibleSources.length} of {sources.length} sources</span>
    </div>
    <section className="data-panel source-table">
      <div className="table-head source-table-row">
        <SortHeader label="Source" field="name" activeField={sortField} direction={sortDirection} onSort={sort}/>
        <SortHeader label="Type" field="type" activeField={sortField} direction={sortDirection} onSort={sort}/>
        <SortHeader label="Trust" field="trust" activeField={sortField} direction={sortDirection} onSort={sort}/>
        <SortHeader label="Policy" field="policyStatus" activeField={sortField} direction={sortDirection} onSort={sort}/>
        <SortHeader label="Last success" field="lastSuccess" activeField={sortField} direction={sortDirection} onSort={sort}/>
        <SortHeader label="Items" field="items" activeField={sortField} direction={sortDirection} onSort={sort}/>
        <SortHeader label="Origin" field="dataOrigin" activeField={sortField} direction={sortDirection} onSort={sort}/>
        <span/>
      </div>
      {visibleSources.map((source) => <div className="source-table-row table-row" key={source.id}>
        <span className="source-identity"><b className="source-logo">{source.name.slice(0, 2).toUpperCase()}</b><span><strong>{source.name}</strong><small>{source.baseUrl || "No base URL"}</small></span></span>
        <span>{source.type}</span><span>{source.trust}</span>
        <span><b className={`status-pill ${source.enabled ? "completed" : "pending"}`}>{source.policyStatus.replaceAll("_", " ")}</b></span>
        <span>{source.lastSuccess}</span><span>{source.items}</span><span><b className="type-badge">{source.dataOrigin}</b></span>
        <span className="row-actions">
          <a href={source.baseUrl} target="_blank" rel="noreferrer">Open</a>
          <button onClick={() => setReviewing(source)}>{source.enabled ? "Policy" : "Review"}</button>
          <button className="run-button" disabled={!source.enabled || source.policyStatus !== "REVIEWED_ALLOWED" || busyId === source.id} onClick={() => runSource(source)}><Play size={11}/>{busyId === source.id ? "Queueing" : "Run now"}</button>
        </span>
      </div>)}
      {!visibleSources.length ? <div className="empty-table"><Database size={20}/><strong>No matching sources</strong><span>Try another search or filter.</span></div> : null}
    </section>
    {addOpen && <SourceDialog title="Add crawler source" description="New sources stay disabled until you explicitly approve their policy." saving={saving} onClose={() => setAddOpen(false)} onSubmit={async (input) => {
      setSaving(true);
      try {
        const { source } = await apiRequest<{ source: ConsoleSource }>("/api/crawler/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
        updateSource(source); setAddOpen(false); notify(`${source.name} added to Neon`);
      } catch (error) { notify(error instanceof Error ? error.message : "Could not add source"); }
      finally { setSaving(false); }
    }}/>}
    {reviewing && <PolicyDialog source={reviewing} saving={saving} onClose={() => setReviewing(null)} onSubmit={async (input) => {
      setSaving(true);
      try {
        const { source } = await apiRequest<{ source: ConsoleSource }>(`/api/crawler/sources/${reviewing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
        updateSource(source); setReviewing(null); notify(input.approved ? `${source.name} enabled` : `${source.name} disabled`);
      } catch (error) { notify(error instanceof Error ? error.message : "Could not save review"); }
      finally { setSaving(false); }
    }}/>}
  </>;
}

type SourceFormInput = {
  name: string;
  url: string;
  connectorKey: "website" | "animecons";
  trustLevel: "OFFICIAL" | "VERIFIED" | "COMMUNITY";
  policyApproved: boolean;
  reviewNote: string;
  contactIdentity: string;
  followOfficialSites: boolean;
  discoverLinkedEvents: boolean;
};

function SourceDialog({ title, description, saving, onClose, onSubmit }: { title: string; description: string; saving: boolean; onClose: () => void; onSubmit: (input: SourceFormInput) => void }) {
  const [form, setForm] = useState<SourceFormInput>({ name: "", url: "", connectorKey: "website", trustLevel: "OFFICIAL", policyApproved: false, reviewNote: "", contactIdentity: "", followOfficialSites: true, discoverLinkedEvents: true });
  return <div className="modal-backdrop source-modal-backdrop"><button className="modal-dismiss" aria-label="Close add source" onClick={onClose}/><form className="source-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
    <header><div><span className="dialog-icon"><Database size={16}/></span><h2>{title}</h2><p>{description}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={15}/></button></header>
    <div className="crawler-form-grid">
      <label><span>Name</span><input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Anime Expo official site"/></label>
      <label><span>Connector</span><select value={form.connectorKey} onChange={(event) => setForm({ ...form, connectorKey: event.target.value as SourceFormInput["connectorKey"] })}><option value="website">Official website</option><option value="animecons">AnimeCons event or listing</option></select></label>
      <label><span>Trust level</span><select value={form.trustLevel} onChange={(event) => setForm({ ...form, trustLevel: event.target.value as SourceFormInput["trustLevel"] })}><option value="OFFICIAL">Official</option><option value="VERIFIED">Verified</option><option value="COMMUNITY">Community</option></select></label>
      <label className="wide-field"><span>Base or seed URL</span><input required type="url" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder={form.connectorKey === "animecons" ? "https://animecons.com/events/info/12345" : "https://www.anime-expo.org/"}/></label>
      <label className="wide-field"><span>Owner / reviewer identity</span><input value={form.contactIdentity} onChange={(event) => setForm({ ...form, contactIdentity: event.target.value })} placeholder="admin@kitacon.dev"/></label>
      <label className="wide-field"><span>Policy review note</span><textarea rows={3} required={form.policyApproved} value={form.reviewNote} onChange={(event) => setForm({ ...form, reviewNote: event.target.value })} placeholder="What was reviewed, when, and any crawl restrictions…"/></label>
      {form.connectorKey === "animecons" && <>
        <div className="policy-check wide-field"><input id="source-discover-linked-events" type="checkbox" checked={form.discoverLinkedEvents} onChange={(event) => setForm({ ...form, discoverLinkedEvents: event.target.checked })}/><label htmlFor="source-discover-linked-events"><strong>Discover linked AnimeCons events</strong><small>Queue bounded event-detail pages found on the seed page, up to this source&apos;s page and depth limits.</small></label></div>
        <div className="policy-check wide-field"><input id="source-follow-official-sites" type="checkbox" checked={form.followOfficialSites} onChange={(event) => setForm({ ...form, followOfficialSites: event.target.checked })}/><label htmlFor="source-follow-official-sites"><strong>Follow every discovered official website</strong><small>Official sites inherit this explicit approval and receive their own bounded deep crawl.</small></label></div>
      </>}
      <div className="policy-check wide-field"><input id="source-policy-approved" type="checkbox" checked={form.policyApproved} onChange={(event) => setForm({ ...form, policyApproved: event.target.checked })}/><label htmlFor="source-policy-approved"><strong>Approve and enable this source</strong><small>I reviewed robots.txt and applicable terms and authorize the configured crawl.</small></label></div>
    </div>
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Add source"}</button></footer>
  </form></div>;
}

function PolicyDialog({ source, saving, onClose, onSubmit }: { source: ConsoleSource; saving: boolean; onClose: () => void; onSubmit: (input: { approved: boolean; reviewNote: string; contactIdentity: string; maxDepth: number; maxPagesPerRun: number; followOfficialSites: boolean; discoverLinkedEvents: boolean }) => void }) {
  const [approved, setApproved] = useState(source.enabled && source.policyStatus === "REVIEWED_ALLOWED");
  const [reviewNote, setReviewNote] = useState(source.policyNote);
  const [contactIdentity, setContactIdentity] = useState(source.contactIdentity);
  const [maxDepth, setMaxDepth] = useState(source.maxDepth);
  const [maxPagesPerRun, setMaxPagesPerRun] = useState(source.maxPagesPerRun);
  const [followOfficialSites, setFollowOfficialSites] = useState(source.followOfficialSites);
  const [discoverLinkedEvents, setDiscoverLinkedEvents] = useState(source.discoverLinkedEvents);
  return <div className="modal-backdrop source-modal-backdrop"><button className="modal-dismiss" aria-label="Close policy review" onClick={onClose}/><form className="source-dialog compact-dialog" role="dialog" aria-modal="true" aria-label={`Review ${source.name}`} onSubmit={(event) => { event.preventDefault(); onSubmit({ approved, reviewNote, contactIdentity, maxDepth, maxPagesPerRun, followOfficialSites, discoverLinkedEvents }); }}>
    <header><div><span className="dialog-icon"><ShieldCheck size={16}/></span><h2>Source policy review</h2><p>{source.name} · {source.baseUrl}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={15}/></button></header>
    <div className="crawler-form-grid">
      <label className="wide-field"><span>Reviewer identity</span><input value={contactIdentity} onChange={(event) => setContactIdentity(event.target.value)} placeholder="admin@kitacon.dev"/></label>
      <label className="wide-field"><span>Required review note</span><textarea required rows={4} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Record robots.txt and terms review, crawl limits, and date…"/></label>
      <label><span>Maximum depth</span><input type="number" min={0} max={8} value={maxDepth} onChange={(event) => setMaxDepth(Number(event.target.value))}/></label>
      <label><span>Maximum pages per run</span><input type="number" min={1} max={2000} value={maxPagesPerRun} onChange={(event) => setMaxPagesPerRun(Number(event.target.value))}/></label>
      {source.connectorKey === "animecons" && <>
        <div className="policy-check wide-field"><input id="review-discover-linked-events" type="checkbox" checked={discoverLinkedEvents} onChange={(event) => setDiscoverLinkedEvents(event.target.checked)}/><label htmlFor="review-discover-linked-events"><strong>Discover linked AnimeCons events</strong><small>Fan out from the seed into event-detail pages within this source&apos;s limits.</small></label></div>
        <div className="policy-check wide-field"><input id="review-follow-official-sites" type="checkbox" checked={followOfficialSites} onChange={(event) => setFollowOfficialSites(event.target.checked)}/><label htmlFor="review-follow-official-sites"><strong>Follow discovered official websites</strong><small>Inherit this review decision for bounded first-party website crawls.</small></label></div>
      </>}
      <div className="policy-check wide-field"><input id="source-review-approved" type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)}/><label htmlFor="source-review-approved"><strong>Enable crawling</strong><small>Clear this to record a denied review and disable future runs.</small></label></div>
    </div>
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save review"}</button></footer>
  </form></div>;
}

export function CrawlerJobsWorkspace({ initialStatus, notify }: { initialStatus: CrawlerDashboardStatus; sources: ConsoleSource[]; notify: Notify; onOpenSources: () => void }) {
  type RunSort = "sourceName" | "status" | "progress" | "pagesFetched" | "createdAt";
  type WorkerSort = "name" | "state" | "version" | "heartbeatAge";
  const [status, setStatus] = useState(initialStatus);
  const [refreshing, setRefreshing] = useState(false);
  const [runDetail, setRunDetail] = useState<CrawlRunDetail | null>(null);
  const [rawDetail, setRawDetail] = useState<RawDocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [runQuery, setRunQuery] = useState("");
  const [runStatus, setRunStatus] = useState("ALL");
  const [runSortField, setRunSortField] = useState<RunSort>("createdAt");
  const [runSortDirection, setRunSortDirection] = useState<SortDirection>("desc");
  const [runPage, setRunPage] = useState(1);
  const [workerQuery, setWorkerQuery] = useState("");
  const [workerState, setWorkerState] = useState("ALL");
  const [workerSortField, setWorkerSortField] = useState<WorkerSort>("heartbeatAge");
  const [workerSortDirection, setWorkerSortDirection] = useState<SortDirection>("asc");
  const [workerPage, setWorkerPage] = useState(1);
  const pageSize = 5;

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try { setStatus(await apiRequest<CrawlerDashboardStatus>("/api/crawler/status", { cache: "no-store" })); }
    catch (error) { if (!quiet) notify(error instanceof Error ? error.message : "Could not refresh crawler status"); }
    finally { if (!quiet) setRefreshing(false); }
  }, [notify]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(true), 2_500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const queued = status.jobs.filter((job) => ["Queued", "Retry Wait"].includes(job.status)).length;
  const running = status.jobs.filter((job) => ["Leased", "Running"].includes(job.status)).length;
  const failed = status.jobs.filter((job) => ["Dead", "Failed"].includes(job.status)).length;
  const online = status.workers.filter((worker) => worker.state === "Online").length;
  const runStatuses = useMemo(() => [...new Set(status.runs.map((run) => run.status))].sort(), [status.runs]);
  const visibleRuns = useMemo(() => { const needle = runQuery.trim().toLowerCase(); return status.runs.filter((run) => runStatus === "ALL" || run.status === runStatus).filter((run) => !needle || `${run.sourceName} ${run.id} ${run.status}`.toLowerCase().includes(needle)).sort((left, right) => compareValues(left[runSortField], right[runSortField], runSortDirection)); }, [runQuery, runSortDirection, runSortField, runStatus, status.runs]);
  const visibleWorkers = useMemo(() => { const needle = workerQuery.trim().toLowerCase(); return status.workers.filter((worker) => workerState === "ALL" || worker.state === workerState).filter((worker) => !needle || `${worker.name} ${worker.id} ${worker.version} ${worker.state}`.toLowerCase().includes(needle)).sort((left, right) => compareValues(workerSortField === "heartbeatAge" ? relativeAgeSeconds(left.heartbeatAge) : left[workerSortField], workerSortField === "heartbeatAge" ? relativeAgeSeconds(right.heartbeatAge) : right[workerSortField], workerSortDirection)); }, [status.workers, workerQuery, workerSortDirection, workerSortField, workerState]);
  const runPageCount = Math.max(1, Math.ceil(visibleRuns.length / pageSize));
  const workerPageCount = Math.max(1, Math.ceil(visibleWorkers.length / pageSize));
  const pagedRuns = visibleRuns.slice((Math.min(runPage, runPageCount) - 1) * pageSize, Math.min(runPage, runPageCount) * pageSize);
  const pagedWorkers = visibleWorkers.slice((Math.min(workerPage, workerPageCount) - 1) * pageSize, Math.min(workerPage, workerPageCount) * pageSize);
  const sortRuns = (field: RunSort) => { const next = nextSort(runSortField, runSortDirection, field); setRunSortField(next.field); setRunSortDirection(next.direction); };
  const sortWorkers = (field: WorkerSort) => { const next = nextSort(workerSortField, workerSortDirection, field); setWorkerSortField(next.field); setWorkerSortDirection(next.direction); };
  const inspectRun = async (runId: string) => {
    setDetailLoading(true);
    try { setRunDetail(await apiRequest<CrawlRunDetail>(`/api/crawler/runs/${runId}`, { cache: "no-store" })); }
    catch (error) { notify(error instanceof Error ? error.message : "Could not load crawl run"); }
    finally { setDetailLoading(false); }
  };
  const inspectDocument = async (documentId: string) => {
    setDetailLoading(true);
    try { setRawDetail(await apiRequest<RawDocumentDetail>(`/api/crawler/raw-documents/${documentId}`, { cache: "no-store" })); }
    catch (error) { notify(error instanceof Error ? error.message : "Could not load raw document"); }
    finally { setDetailLoading(false); }
  };
  return <>
    <PageHead eyebrow="Durable intelligence queue" title="Crawl jobs" description="Monitor crawl runs and the workers that execute them. Start new runs from Sources." action={<button className="secondary-button jobs-refresh" onClick={() => refresh()} disabled={refreshing}><RefreshCw size={14} className={refreshing ? "spin" : ""}/><span>{refreshing ? "Refreshing" : "Refresh"}</span></button>}/>
    <section className="crawler-stat-grid">
      <article><span className="metric-icon green"><Server size={18}/></span><span>Workers online</span><strong>{online}</strong><small>{status.workers.length} registered</small></article>
      <article><span className="metric-icon violet"><Clock3 size={18}/></span><span>Queued</span><strong>{queued}</strong><small>Waiting for lease</small></article>
      <article><span className="metric-icon blue"><Workflow size={18}/></span><span>Running</span><strong>{running}</strong><small>Currently leased</small></article>
      <article><span className="metric-icon red"><AlertTriangle size={18}/></span><span>Failed</span><strong>{failed}</strong><small>Needs attention</small></article>
    </section>
    <div className="worker-dashboard-grid">
      <section className="panel worker-table-panel"><div className="panel-head"><div><h2>Crawl runs</h2><p>Progress refreshes every 2.5 seconds</p></div><span>{visibleRuns.length} runs</span></div><div className="worker-panel-tools"><TableSearch value={runQuery} onChange={(value) => { setRunQuery(value); setRunPage(1); }} placeholder="Search crawl runs..."/><label className="table-select"><select value={runStatus} onChange={(event) => { setRunStatus(event.target.value); setRunPage(1); }} aria-label="Crawl run status"><option value="ALL">All statuses</option>{runStatuses.map((item) => <option key={item}>{item}</option>)}</select></label></div><div className="compact-table crawl-run-table"><div className="table-head crawl-run-row"><SortHeader label="Source" field="sourceName" activeField={runSortField} direction={runSortDirection} onSort={sortRuns}/><SortHeader label="Status" field="status" activeField={runSortField} direction={runSortDirection} onSort={sortRuns}/><SortHeader label="Progress" field="progress" activeField={runSortField} direction={runSortDirection} onSort={sortRuns}/><SortHeader label="Fetched" field="pagesFetched" activeField={runSortField} direction={runSortDirection} onSort={sortRuns}/><span/></div>{pagedRuns.map((run) => <div className="crawl-run-row table-row" key={run.id}><span><strong>{run.sourceName}</strong><small>{run.id.slice(0, 8)} · <LocalDate value={run.createdAt}/></small></span><span><b className={`status-pill ${run.status.toLowerCase().replaceAll(" ", "-")}`}>{run.status}</b></span><span><div className="progress-track"><i style={{ width: `${run.progress}%` }}/></div><small>{run.progress}%</small></span><span>{run.pagesFetched}<small>{run.pagesUnchanged} unchanged · {run.pagesFailed} failed · {run.pagesBlocked} blocked</small></span><span><button onClick={() => inspectRun(run.id)}>Inspect</button></span></div>)}{!pagedRuns.length ? <div className="compact-empty"><Workflow size={17}/><span><strong>No matching crawl runs</strong><small>Start a run from Sources or change the filters.</small></span></div> : null}</div><TablePagination page={Math.min(runPage, runPageCount)} pageCount={runPageCount} onPage={setRunPage}/></section>
      <section className="panel worker-table-panel"><div className="panel-head"><div><h2>Crawl workers</h2><p>{online ? `${online} online · heartbeat received in the last 10 seconds` : "No recent heartbeat"}</p></div><span>{status.workers.length} registered</span></div><div className="worker-panel-tools"><TableSearch value={workerQuery} onChange={(value) => { setWorkerQuery(value); setWorkerPage(1); }} placeholder="Search crawl workers..."/><label className="table-select"><select value={workerState} onChange={(event) => { setWorkerState(event.target.value); setWorkerPage(1); }} aria-label="Crawl worker state"><option value="ALL">All states</option><option>Online</option><option>Offline</option></select></label></div><div className="compact-table crawl-worker-table"><div className="table-head crawl-worker-row"><SortHeader label="Worker" field="name" activeField={workerSortField} direction={workerSortDirection} onSort={sortWorkers}/><SortHeader label="Version" field="version" activeField={workerSortField} direction={workerSortDirection} onSort={sortWorkers}/><SortHeader label="State" field="state" activeField={workerSortField} direction={workerSortDirection} onSort={sortWorkers}/><SortHeader label="Heartbeat" field="heartbeatAge" activeField={workerSortField} direction={workerSortDirection} onSort={sortWorkers}/></div>{pagedWorkers.map((worker) => <div className="crawl-worker-row table-row" key={worker.id}><span><i className={`worker-beacon ${worker.state.toLowerCase()}`}/><span><strong>{worker.name}</strong><small>{worker.id.slice(0, 8)}</small></span></span><span>v{worker.version}</span><span><b className={`status-pill ${worker.state === "Online" ? "completed" : "draft"}`}>{worker.state}</b></span><span>{worker.heartbeatAge}</span></div>)}{!pagedWorkers.length ? <div className="compact-empty"><Database size={17}/><span><strong>No matching crawl workers</strong><small>Run the Python worker or change the filters.</small></span></div> : null}</div><TablePagination page={Math.min(workerPage, workerPageCount)} pageCount={workerPageCount} onPage={setWorkerPage}/></section>
    </div>
    <p className="status-footnote">Last checked <LocalTime value={status.checkedAt}/> · New crawls are started from the Sources workspace.</p>
    {detailLoading && <div className="detail-loading">Loading evidence…</div>}
    {runDetail && <RunDetailDialog detail={runDetail} onClose={() => setRunDetail(null)} onInspectDocument={inspectDocument} onRetry={async () => { try { await apiRequest(`/api/crawler/runs/${runDetail.run.id}/retry`, { method: "POST" }); notify("Crawl retry queued"); setRunDetail(null); await refresh(true); } catch (error) { notify(error instanceof Error ? error.message : "Could not retry crawl"); } }}/>}
    {rawDetail && <RawDocumentDialog detail={rawDetail} onClose={() => setRawDetail(null)}/>}
  </>;
}

function RunDetailDialog({ detail, onClose, onInspectDocument, onRetry }: { detail: CrawlRunDetail; onClose: () => void; onInspectDocument: (id: string) => void; onRetry: () => void }) {
  const run = detail.run;
  return <div className="modal-backdrop evidence-modal-backdrop"><button className="modal-dismiss" aria-label="Close crawl detail" onClick={onClose}/><section className="evidence-dialog" role="dialog" aria-modal="true" aria-label={`Crawl run ${run.id}`}>
    <header><div><p className="eyebrow">Crawl run · {run.id.slice(0, 8)}</p><h2>{run.sourceName}</h2><p>{run.rootUrl || "No root URL recorded"}</p></div><div><button onClick={onRetry}>Retry run</button><button className="icon-button" onClick={onClose} aria-label="Close"><X size={15}/></button></div></header>
    <div className="evidence-metrics"><span><small>Status</small><strong>{run.status}</strong></span><span><small>Pages</small><strong>{run.pagesFetched + run.pagesUnchanged}/{run.pagesScheduled}</strong></span><span><small>Unchanged</small><strong>{run.pagesUnchanged}</strong></span><span><small>Documents</small><strong>{run.documentsCreated}</strong></span><span><small>Media</small><strong>{run.mediaDiscovered}</strong></span><span><small>Bytes</small><strong>{Number(run.bytesFetched).toLocaleString()}</strong></span></div>
    <div className="evidence-columns"><section><h3>Discovered URL graph <small>{detail.discoveries.length}</small></h3><div className="evidence-list">{detail.discoveries.length ? detail.discoveries.map((item) => <article key={item.id}><span><strong>{item.page_hint || item.link_kind}</strong><small>{item.normalized_url}</small></span><b className={`status-pill ${item.decision.toLowerCase().replaceAll("_", "-")}`}>{item.decision}</b><p>{item.decision_reason}</p></article>) : <p className="empty-copy">No discovery edges recorded.</p>}</div></section><section><h3>Raw documents <small>{detail.documents.length}</small></h3><div className="evidence-list">{detail.documents.length ? detail.documents.map((item) => <article key={item.id}><span><strong>{item.page_type || item.document_type}</strong><small>{item.canonical_url}</small></span><div className="evidence-actions"><button onClick={() => onInspectDocument(item.id)}>Inspect</button><a href={`/api/crawler/raw-documents/${item.id}/download`} target="_blank" rel="noreferrer">Download</a></div><p>{Number(item.byte_size || 0).toLocaleString()} bytes · {item.fetched_at ? new Date(item.fetched_at).toLocaleString() : "Unknown time"}</p></article>) : <p className="empty-copy">No RawDocuments produced.</p>}</div></section></div>
    <div className="evidence-columns compact-evidence"><section><h3>Media candidates <small>{detail.media.length}</small></h3>{detail.media.slice(0, 12).map((item) => <div className="candidate-line" key={item.id}><span>{item.category}<small>{item.resolved_url}</small></span><b>{item.fetch_status}</b></div>)}</section><section><h3>Follow-on sources <small>{detail.sourceCandidates.length}</small></h3>{detail.sourceCandidates.slice(0, 12).map((item) => <div className="candidate-line" key={item.id}><span>{item.candidate_type}<small>{item.url}</small></span><b>{item.status}</b></div>)}</section></div>
  </section></div>;
}

function RawDocumentDialog({ detail, onClose }: { detail: RawDocumentDetail; onClose: () => void }) {
  const document = detail.document;
  return <div className="modal-backdrop evidence-modal-backdrop raw-modal-layer"><button className="modal-dismiss" aria-label="Close raw document" onClick={onClose}/><section className="evidence-dialog raw-dialog" role="dialog" aria-modal="true" aria-label={`Raw document ${document.id}`}>
    <header><div><p className="eyebrow">Immutable raw evidence</p><h2>{document.page_type || document.document_type}</h2><p>{document.canonical_url}</p></div><div><a href={`/api/crawler/raw-documents/${document.id}/download`} target="_blank" rel="noreferrer">Download raw</a><button className="icon-button" onClick={onClose} aria-label="Close"><X size={15}/></button></div></header>
    <dl className="raw-metadata"><div><dt>Source</dt><dd>{document.source_name}</dd></div><div><dt>Fetched</dt><dd>{new Date(document.fetched_at).toLocaleString()}</dd></div><div><dt>MIME</dt><dd>{document.mime_type}</dd></div><div><dt>Size</dt><dd>{Number(document.byte_size || 0).toLocaleString()} bytes</dd></div><div><dt>SHA-256</dt><dd className="mono">{document.content_hash}</dd></div><div><dt>Private object</dt><dd className="mono">{document.r2_bucket}/{document.r2_key}</dd></div></dl>
    <section className="chunk-view"><h3>Extracted chunks <small>{detail.chunks.length}</small></h3>{detail.chunks.length ? detail.chunks.map((chunk) => <article key={chunk.id}><strong>{chunk.heading_path || "Document text"}</strong><p>{chunk.content}</p></article>) : <p className="empty-copy">No searchable text chunks for this artifact.</p>}</section>
  </section></div>;
}
