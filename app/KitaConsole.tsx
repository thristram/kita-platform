"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell, CalendarDays, ChevronDown, Database, FileSearch, Images, LayoutDashboard,
  Link2, Moon, Plus, Search, Settings, Sparkles, Sun, Workflow,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ConsoleAsset, ConsoleEvent, ConsoleSnapshot, ConsoleSource } from "@/db/console";
import type { ConsoleEventPage, EventListQuery, EventSortField } from "@/db/consoleEvents";
import type { ConsoleSearchResult } from "@/db/consoleSearch";
import type { ConsoleEventDetail } from "@/db/events";
import { EventWorkspace } from "./EventWorkspace";
import { CrawlerJobsWorkspace, SourcesWorkspace } from "./CrawlerWorkspace";
import { CandidateWorkspace } from "./CandidateWorkspace";
import { ResolutionJobsWorkspace } from "./ResolutionWorkspace";
import { ManualEventWorkspace } from "./ManualEventWorkspace";
import { SortHeader, TablePagination, TableSearch } from "./ConsoleTableControls";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import type { ConsoleSession } from "@/lib/consoleSession";
import { ConsoleAccessWorkspace } from "./ConsoleAccessWorkspace";

export type ConsoleView = "overview" | "events" | "event" | "new-event" | "media" | "sources" | "jobs" | "resolution" | "review" | "settings";
export type CandidateTab = "overview" | "schedule" | "exhibitors" | "fandoms" | "updates";
export type SettingsSection = "general" | "sources" | "crawling" | "media" | "notifications" | "access";

const consoleRoutes: Record<Exclude<ConsoleView, "event">, string> = {
  overview: "/overview",
  events: "/events",
  "new-event": "/events/new",
  review: "/candidates",
  media: "/media",
  sources: "/sources",
  jobs: "/crawl-jobs",
  resolution: "/resolution-jobs",
  settings: "/settings/general",
};

const settingsSections: Array<{ id: SettingsSection; label: string; href: string }> = [
  { id: "general", label: "General", href: "/settings/general" },
  { id: "sources", label: "Sources", href: "/settings/sources" },
  { id: "crawling", label: "Crawling", href: "/settings/crawling" },
  { id: "media", label: "Media", href: "/settings/media" },
  { id: "notifications", label: "Notifications", href: "/settings/notifications" },
  { id: "access", label: "Access", href: "/settings/access" },
];

const settingsSectionCopy: Record<Exclude<SettingsSection, "general" | "access">, { title: string; description: string; href?: string; action?: string }> = {
  sources: { title: "Source policy defaults", description: "Source-specific approval, limits, and connector controls remain available in the operational Sources workspace.", href: "/sources", action: "Open Sources" },
  crawling: { title: "Crawler execution defaults", description: "Worker health, durable queue behavior, and crawl runs remain available in the Crawl Jobs workspace.", href: "/crawl-jobs", action: "Open Crawl Jobs" },
  media: { title: "Media publication defaults", description: "Asset classification and publication readiness remain available in the Media Library.", href: "/media", action: "Open Media Library" },
  notifications: { title: "Operator notifications", description: "Account-level notification preferences are planned for a future release." },
};

const nav = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "events", label: "Events", icon: CalendarDays },
  { id: "review", label: "Candidates", icon: FileSearch },
  { id: "media", label: "Media Library", icon: Images },
  { id: "sources", label: "Sources", icon: Database },
] as const;

export function KitaConsole({ initialData, initialEventPage = null, operator, permissions, initialEvent = null, initialView = "overview", initialSettingsSection = "general", initialCandidateId = "", initialCandidateTab = "overview" }: { initialData: ConsoleSnapshot; initialEventPage?: ConsoleEventPage | null; operator: ConsoleSession; permissions: string[]; initialEvent?: ConsoleEventDetail | null; initialView?: ConsoleView; initialSettingsSection?: SettingsSection; initialCandidateId?: string; initialCandidateTab?: CandidateTab }) {
  const router = useRouter();
  const view: ConsoleView = initialEvent ? "event" : initialView;
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [workersOpen, setWorkersOpen] = useState(view === "jobs" || view === "resolution");
  const [settingsOpen, setSettingsOpen] = useState(view === "settings");
  const [showMockData, setShowMockData] = useState(initialData.consumerShowMockData);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConsoleSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!palette) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [palette]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setPalette((value) => !value);
      }
      if (event.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (!palette || term.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      setSearchError("");
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
        const body = await response.json() as { results?: ConsoleSearchResult[]; error?: string };
        if (!response.ok) throw new Error(body.error || `Search failed (${response.status})`);
        setSearchResults(body.results || []);
      } catch (error) {
        if (!controller.signal.aborted) {
          setSearchResults([]);
          setSearchError(error instanceof Error ? error.message : "Search failed");
        }
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [palette, query]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      const serverTheme = document.documentElement.dataset.theme;
      const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      setTheme(stored === "dark" || stored === "light" ? stored : serverTheme === "dark" || serverTheme === "light" ? serverTheme : preferred);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.cookie = `${THEME_STORAGE_KEY}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [theme]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  const filteredCommands = useMemo(() => [
    ["Go to Overview", "overview"], ["Open Events", "events"],
    ["Review candidates", "review"], ["Browse Media Library", "media"], ["View source health", "sources"], ["View crawl jobs", "jobs"], ["View resolution jobs", "resolution"],
  ].filter(([label]) => label.toLowerCase().includes(query.toLowerCase())), [query]);

  const closePalette = () => { setPalette(false); setQuery(""); setSearchResults([]); setSearchError(""); setSearchLoading(false); };
  const openSearchResult = (result: ConsoleSearchResult) => { router.push(result.href); closePalette(); };
  const updatePaletteQuery = (value: string) => {
    setQuery(value);
    setSearchResults([]);
    setSearchError("");
    setSearchLoading(value.trim().length >= 2);
  };

  const navigateToView = (target: ConsoleView) => {
    if (target === "event") return;
    router.push(consoleRoutes[target]);
  };
  const openEvent = (id: string) => router.push(`/events/${id}`);
  const effectiveTheme = theme ?? "light";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href={consoleRoutes.overview}><span className="brand-mark"><Sparkles size={18}/></span>KitaCon</Link>
        <nav aria-label="Primary navigation">
          {nav.map((item) => {
            const active = view === item.id || ((view === "event" || view === "new-event") && item.id === "events");
            return <Link key={item.id} href={consoleRoutes[item.id]} aria-current={active ? "page" : undefined} className={`nav-item ${active ? "active" : ""}`}><span>{createElement(item.icon, { size: 15, strokeWidth: 1.8 })}</span>{item.label}{item.id === "review" && initialData.totals.review ? <b>{initialData.totals.review}</b> : null}</Link>;
          })}
          <div className={`nav-group ${workersOpen ? "expanded" : ""}`}>
            <button type="button" className={`nav-item nav-group-trigger ${view === "jobs" || view === "resolution" ? "active" : ""}`} aria-expanded={workersOpen} aria-controls="workers-submenu" onClick={() => setWorkersOpen((current) => !current)}><span><Workflow size={15} strokeWidth={1.8}/></span>Workers{initialData.totals.queuedJobs ? <b>{initialData.totals.queuedJobs}</b> : null}<ChevronDown className="nav-chevron" size={14}/></button>
            {workersOpen ? <div className="nav-submenu" id="workers-submenu"><Link href="/crawl-jobs" aria-current={view === "jobs" ? "page" : undefined} className={view === "jobs" ? "active" : ""}>Crawl</Link><Link href="/resolution-jobs" aria-current={view === "resolution" ? "page" : undefined} className={view === "resolution" ? "active" : ""}>Resolution</Link></div> : null}
          </div>
          <div className={`nav-group ${settingsOpen ? "expanded" : ""}`}>
            <button type="button" className={`nav-item nav-group-trigger ${view === "settings" ? "active" : ""}`} aria-expanded={settingsOpen} aria-controls="settings-submenu" onClick={() => setSettingsOpen((current) => !current)}><span><Settings size={15} strokeWidth={1.8}/></span>Settings<ChevronDown className="nav-chevron" size={14}/></button>
            {settingsOpen ? <div className="nav-submenu" id="settings-submenu">{settingsSections.filter((section) => section.id !== "access" || permissions.includes("access:manage")).map((section) => <Link key={section.id} href={section.href} aria-current={view === "settings" && initialSettingsSection === section.id ? "page" : undefined} className={view === "settings" && initialSettingsSection === section.id ? "active" : ""}>{section.label}</Link>)}</div> : null}
          </div>
        </nav>
        <div className="sidebar-spacer" />
        <button className="nav-item" onClick={() => setTheme(effectiveTheme === "light" ? "dark" : "light")}><span>{effectiveTheme === "light" ? <Moon size={15}/> : <Sun size={15}/>}</span>{effectiveTheme === "light" ? "Dark mode" : "Light mode"}</button>
        <div className="profile"><span className="avatar">{operator.name.slice(0, 2).toUpperCase()}</span><span><strong>{operator.name}</strong><small>{operator.email}</small></span><form action="/api/auth/sign-out" method="post"><button type="submit" title="Sign out" aria-label="Sign out">↪</button></form></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="search" onClick={() => setPalette(true)}><Search size={14}/> <span>Search events, candidates, entities, sources…</span><kbd>⌘K</kbd></button>
          <Link className="consumer-link" href="/discover">Consumer preview ↗</Link>
          <button className="icon-button" aria-label="Notifications"><Bell size={14}/></button>
          {permissions.includes("events:write") ? <Link className="primary-button" href="/events/new"><Plus size={13}/> Create event</Link> : null}
        </header>

        {view === "overview" && <Overview events={initialData.events} sources={initialData.sources} totals={initialData.totals} onOpenEvent={openEvent} onNavigate={navigateToView} />}
        {view === "events" && initialEventPage && <EventsView key={JSON.stringify(initialEventPage.query)} result={initialEventPage} onOpen={openEvent} canCreate={permissions.includes("events:write")} />}
        {view === "event" && initialEvent && <EventWorkspace initialEvent={initialEvent} notify={notify} />}
        {view === "new-event" && <ManualEventWorkspace sources={initialData.sources} notify={notify} />}
        {view === "media" && <MediaView assets={initialData.assets} notify={notify} />}
        {view === "sources" && <SourcesWorkspace initialSources={initialData.sources} totals={initialData.totals} notify={notify} onOpenJobs={() => navigateToView("jobs")} />}
        {view === "jobs" && <CrawlerJobsWorkspace initialStatus={initialData.crawler} sources={initialData.sources} notify={notify} onOpenSources={() => navigateToView("sources")} />}
        {view === "resolution" && <ResolutionJobsWorkspace notify={notify} />}
        {view === "review" && <CandidateWorkspace initialCount={initialData.totals.review} notify={notify} initialCandidateId={initialCandidateId} initialTab={initialCandidateTab} />}
        {view === "settings" && (initialSettingsSection === "access" ? <ConsoleAccessWorkspace currentPrincipalId={operator.principalId}/> : <SettingsView section={initialSettingsSection} showMockData={showMockData} setShowMockData={setShowMockData} notify={notify} canEdit={permissions.includes("settings:write")} />)}

        <footer><span>Last canonical projection 2 minutes ago</span><span>Private operator preview · P0</span></footer>
      </section>

      {palette && <div className="modal-backdrop"><button className="modal-dismiss" aria-label="Close command palette" onClick={closePalette}/><div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><div className="command-input"><Search size={15}/><input ref={searchInputRef} value={query} onChange={(e) => updatePaletteQuery(e.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim().length >= 2) { event.preventDefault(); if (searchResults[0]) openSearchResult(searchResults[0]); else { router.push(`/events?q=${encodeURIComponent(query.trim())}`); closePalette(); } } }} placeholder="Search events, candidates, entities, sources…" aria-label="Search Console"/><kbd>ESC</kbd></div>{query.trim().length >= 2 ? <><p>Database results</p>{searchLoading ? <div className="command-message" role="status">Searching…</div> : searchError ? <div className="command-message error" role="alert">{searchError}</div> : searchResults.length ? searchResults.map((result) => <button key={`${result.kind}:${result.id}`} onClick={() => openSearchResult(result)}><span className="command-result-kind">{result.kind}</span><span className="command-result-copy"><strong>{result.title}</strong><small>{result.subtitle}</small></span><kbd>↵</kbd></button>) : <div className="command-message">No matching records</div>}</> : null}{filteredCommands.length ? <><p>Navigation</p>{filteredCommands.map(([label, target]) => <button key={target} onClick={() => { navigateToView(target as ConsoleView); closePalette(); }}><span>↳</span>{label}<kbd>↵</kbd></button>)}</> : null}</div></div>}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}

function PageHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-head"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function Art({ tone, label, compact = false }: { tone: string; label: string; compact?: boolean }) {
  return <div className={`event-art ${tone} ${compact ? "compact-art" : ""}`}><span className="event-date">{compact ? "INTERNAL" : "FEATURED"}</span><b>{label}</b></div>;
}

function Overview({ events, sources, totals, onOpenEvent, onNavigate }: { events: ConsoleEvent[]; sources: ConsoleSource[]; totals: ConsoleSnapshot["totals"]; onOpenEvent: (id: string) => void; onNavigate: (view: ConsoleView) => void }) {
  return <>
    <PageHead eyebrow="KitaCon Console" title="Overview" description="Your fandom intelligence hub" action={<span className="sync-state"><i /> All systems operational</span>} />
    <section className="metrics" aria-label="Platform totals">
      <article><span className="metric-icon violet"><CalendarDays size={19}/></span><span>Events</span><strong>{totals.events.toLocaleString()}</strong><small>Canonical records</small></article>
      <article><span className="metric-icon green"><Database size={19}/></span><span>Entities</span><strong>{totals.entities.toLocaleString()}</strong><small>Linked subjects</small></article>
      <article><span className="metric-icon amber"><Images size={19}/></span><span>Media assets</span><strong>{totals.assets.toLocaleString()}</strong><small>Classified assets</small></article>
      <article><span className="metric-icon blue"><Link2 size={19}/></span><span>Active sources</span><strong>{totals.sources.toLocaleString()}</strong><small>Policy enabled</small></article>
      <article className="attention"><span className="metric-icon"><FileSearch size={19}/></span><span>Needs review</span><strong>{totals.review.toLocaleString()}</strong><small>{totals.queuedJobs} queued jobs</small></article>
    </section>
    <section className="section-block"><div className="section-title"><div><h2>Upcoming highlights</h2><p>Next events by start date</p></div><button onClick={() => onNavigate("events")}>View all events →</button></div><div className="highlight-grid">{events.slice(0,4).map((event)=><button className="event-card" key={event.id} onClick={() => onOpenEvent(event.id)}><Art tone={event.art} label={event.title.slice(0,2).toUpperCase()} /><div className="event-copy"><strong>{event.title}</strong><span>{event.date} · {event.place}</span><small>{event.type}</small></div></button>)}</div></section>
    <div className="operations-grid"><section className="panel"><div className="panel-head"><div><h2>Source health</h2><p>Official and provider ingestion</p></div><button onClick={()=>onNavigate("sources")}>View sources →</button></div><div className="source-list">{sources.slice(0,4).map((source)=><button className="source-row" key={source.id} onClick={()=>onNavigate("sources")}><span className="source-logo">{source.name.slice(0,2).toUpperCase()}</span><span className="source-name"><strong>{source.name}</strong><small>Last success {source.lastSuccess}</small></span><span className={`status ${source.status.toLowerCase()}`}><i />{source.status}</span><time>{source.lastSuccess}</time><span>›</span></button>)}</div></section>
    <section className="panel"><div className="panel-head"><div><h2>Intelligence queue</h2><p>LLM and knowledge resolution work</p></div><button onClick={()=>onNavigate("resolution")}>Open resolution jobs →</button></div><div className="queue-chart"><div className="queue-row"><span>Crawler queued</span><div><i style={{width: totals.queuedJobs ? "100%" : "0%"}}/></div><strong>{totals.queuedJobs}</strong></div></div><div className="worker-line"><span className={totals.queuedJobs ? "live-dot" : "idle-dot"}/><span><strong>{totals.queuedJobs ? "Crawler work is active" : "Crawler queue is idle"}</strong><small>Resolution jobs are managed in their own workspace</small></span><b>{totals.queuedJobs ? "Active" : "Idle"}</b></div></section>
    <section className="panel review-panel"><div className="panel-head"><div><h2>Editorial review</h2><p>Canonical changes needing attention</p></div></div><div className="review-stats"><div><strong>{totals.review}</strong><span>Candidates</span></div><div><strong>0</strong><span>Conflicts</span></div><div><strong>0</strong><span>Media</span></div></div><button className="secondary-button" onClick={()=>onNavigate("review")}>{totals.review ? "Start reviewing" : "Open review queue"} <span>→</span></button></section></div>
  </>;
}

function EventsView({ result, onOpen, canCreate }: { result: ConsoleEventPage; onOpen: (id: string) => void; canCreate: boolean }) {
  const router = useRouter();
  const [search, setSearch] = useState(result.query.search);
  const searchTimer = useRef<number | null>(null);
  const { events, total, page, pageSize, pageCount, query, facets } = result;
  const eventUrl = (updates: Partial<EventListQuery>) => {
    const next = { ...query, ...updates };
    const params = new URLSearchParams();
    if (next.search) params.set("q", next.search);
    if (next.type) params.set("type", next.type);
    if (next.status) params.set("status", next.status);
    if (next.origin !== "all") params.set("origin", next.origin);
    if (next.time !== "all") params.set("time", next.time);
    if (next.sort !== "date") params.set("sort", next.sort);
    if (next.direction !== "desc") params.set("direction", next.direction);
    if (next.pageSize !== 25) params.set("pageSize", String(next.pageSize));
    if (next.page > 1) params.set("page", String(next.page));
    return `/events${params.size ? `?${params}` : ""}`;
  };
  useEffect(() => () => { if (searchTimer.current) window.clearTimeout(searchTimer.current); }, []);
  const navigate = (updates: Partial<EventListQuery>) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    router.push(eventUrl({ ...updates, search: search.trim() }));
  };
  const updateSearch = (value: string) => {
    setSearch(value);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => router.replace(eventUrl({ search: value.trim(), page: 1 })), 350);
  };
  const change = (updates: Partial<EventListQuery>) => navigate({ ...updates, page: 1 });
  const sort = (field: EventSortField) => navigate({
    sort: field,
    direction: query.sort === field && query.direction === "asc" ? "desc" : "asc",
    page: 1,
  });
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);

  return <>
    <PageHead eyebrow="Canonical content" title="Events" description="Manage published, draft, and review-ready real-world events" action={canCreate ? <Link className="primary-button" href="/events/new"><Plus size={13}/> Create event</Link> : undefined}/>
    <div className="filterbar">
      <TableSearch value={search} onChange={updateSearch} placeholder="Search all events..." />
      <label className="table-select"><select aria-label="Event type" value={query.type} onChange={(event) => change({ type: event.target.value })}><option value="">All types</option>{facets.types.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label>
      <label className="table-select"><select aria-label="Event status" value={query.status} onChange={(event) => change({ status: event.target.value })}><option value="">All statuses</option>{facets.statuses.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></label>
      <label className="table-select"><select aria-label="Event time" value={query.time} onChange={(event) => change({ time: event.target.value as EventListQuery["time"] })}><option value="all">All dates</option><option value="upcoming">Upcoming</option><option value="past">Past</option><option value="undated">Date pending</option></select></label>
      <label className="table-select filter-more"><select aria-label="Data origin" value={query.origin} onChange={(event) => change({ origin: event.target.value as EventListQuery["origin"] })}><option value="all">All origins</option><option value="LIVE">Live only</option><option value="MOCK">Mock only</option></select></label>
    </div>
    <section className="data-panel event-list-table">
      <div className="table-head event-row">
        <SortHeader label="Event" field="title" activeField={query.sort} direction={query.direction} onSort={sort}/>
        <SortHeader label="Type" field="type" activeField={query.sort} direction={query.direction} onSort={sort}/>
        <SortHeader label="Date & location" field="date" activeField={query.sort} direction={query.direction} onSort={sort}/>
        <SortHeader label="Fandom links" field="fandom" activeField={query.sort} direction={query.direction} onSort={sort}/>
        <SortHeader label="Sources" field="source" activeField={query.sort} direction={query.direction} onSort={sort}/>
        <SortHeader label="Status" field="state" activeField={query.sort} direction={query.direction} onSort={sort}/>
        <span/>
      </div>
      {events.map((event)=><button className="event-row table-row" key={event.id} onClick={() => onOpen(event.id)}><Art tone={event.art} label={event.title.slice(0,2).toUpperCase()} compact/><span><strong>{event.title}</strong><small>{event.id.slice(0,12)}</small></span><span><b className="type-badge">{event.type}</b></span><span><strong>{event.date}</strong><small>{event.place}</small></span><span>{event.fandom}</span><span>{event.source}</span><span><b className={`status-pill ${event.state.toLowerCase()}`}>{event.state}</b>{event.dataOrigin === "MOCK" ? <small className="mock-tag">Mock</small> : null}</span><span>›</span></button>)}
      {!events.length ? <div className="empty-table"><Search size={20}/><strong>No matching events</strong><span>Try another search or filter.</span></div> : null}
    </section>
    <div className="event-list-footer"><span>Showing {start}–{end} of {total} events</span><label className="table-select"><select aria-label="Rows per page" value={pageSize} onChange={(event) => change({ pageSize: Number(event.target.value) as EventListQuery["pageSize"] })}><option value={25}>25 per page</option><option value={50}>50 per page</option><option value={100}>100 per page</option></select></label><TablePagination page={page} pageCount={pageCount} onPage={(nextPage) => navigate({ page: search.trim() === query.search ? nextPage : 1 })}/></div>
  </>;
}

function MediaView({assets,notify}:{assets:ConsoleAsset[];notify:(m:string)=>void}) {
  const [selectedId, setSelectedId] = useState(assets[0]?.id || "");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All categories");
  const [source, setSource] = useState("All sources");
  const [origin, setOrigin] = useState("All origins");
  const categories = useMemo(() => [...new Set(assets.map((asset) => asset.category))].sort(), [assets]);
  const sources = useMemo(() => [...new Set(assets.map((asset) => asset.source))].sort(), [assets]);
  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return assets.filter((asset) =>
      (category === "All categories" || asset.category === category)
      && (source === "All sources" || asset.source === source)
      && (origin === "All origins" || asset.dataOrigin === origin)
      && (!needle || [asset.title, asset.category, asset.source, asset.dimensions].some((value) => value.toLowerCase().includes(needle)))
    );
  }, [assets, category, origin, query, source]);
  const asset = visibleAssets.find((item) => item.id === selectedId) || visibleAssets[0];
  return <>
    <PageHead eyebrow="Centralized asset catalog" title="Media Library" description="Classify, attach, approve, and download media from every source" action={<div className="header-actions"><button onClick={()=>notify("Download bundle prepared with manifest")}>Download selected</button><button className="primary-button" onClick={()=>notify("Upload dialog opened")}><Plus size={13}/> Upload asset</button></div>}/>
    <div className="filterbar">
      <TableSearch value={query} onChange={setQuery} placeholder="Search assets..." />
      <label className="table-select"><select aria-label="Asset category" value={category} onChange={(event) => setCategory(event.target.value)}><option>All categories</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="table-select"><select aria-label="Asset source" value={source} onChange={(event) => setSource(event.target.value)}><option>All sources</option>{sources.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="table-select"><select aria-label="Asset origin" value={origin} onChange={(event) => setOrigin(event.target.value)}><option>All origins</option><option value="LIVE">Live</option><option value="MOCK">Mock</option></select></label>
      <span className="result-count">{visibleAssets.length} of {assets.length} assets</span>
    </div>
    <div className="library-layout"><section><div className="asset-grid">{visibleAssets.map((item)=><button className="asset-button" onClick={()=>setSelectedId(item.id)} key={item.id}><AssetCard asset={item} selected={asset?.id===item.id} notify={notify}/></button>)}</div>{!visibleAssets.length ? <div className="empty-table"><Images size={20}/><strong>No matching assets</strong><span>Try another search or filter.</span></div> : null}</section>{asset ? <aside className="asset-inspector panel"><Art tone={asset.art} label={asset.category==="EVENT_LOGO"?"AX":"KITA"}/><div className="inspector-head"><div><h2>{asset.title}</h2><p>{asset.category}</p></div><b className="status-pill published">Internal default</b></div><dl><div><dt>Dimensions</dt><dd>{asset.dimensions}</dd></div><div><dt>Source</dt><dd>{asset.source}</dd></div><div><dt>Data origin</dt><dd>{asset.dataOrigin}</dd></div><div><dt>Usage</dt><dd>INTERNAL_ONLY</dd></div><div><dt>Rights</dt><dd>UNKNOWN</dd></div></dl><div className="inspector-actions"><button onClick={()=>notify("Original download prepared")}>Download original</button><button onClick={()=>notify("Asset marked PUBLIC_READY")}>Mark public ready</button><button onClick={()=>notify("Asset pinned as internal default")}>Set internal default</button></div></aside> : <aside className="asset-inspector panel">No assets match the current filters.</aside>}</div>
  </>;
}
function AssetCard({asset,selected=false,notify}:{asset:ConsoleAsset;selected?:boolean;notify:(m:string)=>void}){return <article className={`asset-card ${selected?"selected":""}`} onDoubleClick={()=>notify(`${asset.title} opened`)}><Art tone={asset.art} label={asset.category==="EVENT_LOGO"?"AX":"K"}/><div><strong>{asset.title}</strong><span>{asset.category}</span><small>{asset.dimensions} · {asset.source}</small>{asset.dataOrigin === "MOCK" ? <small className="mock-tag">Mock data</small> : null}</div>{selected?<b className="check">✓</b>:null}</article>}

function SettingsView({section,showMockData,setShowMockData,notify,canEdit}:{section:Exclude<SettingsSection,"access">;showMockData:boolean;setShowMockData:(value:boolean)=>void;notify:(message:string)=>void;canEdit:boolean}){
  const updateMockVisibility = async (enabled: boolean) => {
    const previous = showMockData;
    setShowMockData(enabled);
    const response = await fetch("/api/settings/mock-data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      setShowMockData(previous);
      notify("Could not update mock-data visibility");
      return;
    }
    notify(enabled ? "Mock records are visible in customer views" : "Mock records are hidden from customer views");
  };
  return <><PageHead eyebrow="KitaCon instance" title="Settings" description="Manage serving behavior, crawling policy, and media defaults"/><section className="settings-layout">{section === "general" ? <div className="settings-panel"><div className="settings-heading"><div><h2>Customer data visibility</h2><p>Controls serving queries, not operator views or stored records.</p></div></div><div className="setting-row"><div><strong>Show mock data</strong><p>Include records tagged <code>MOCK</code> in customer-facing event listings.</p></div><Switch checked={showMockData} disabled={!canEdit} onCheckedChange={updateMockVisibility} aria-label="Show mock data in customer views"/></div><div className="setting-note"><Database size={16}/><span><strong>Database-backed setting</strong><small>Mock rows remain in Neon when disabled and stay visible to operators with a Mock label.</small></span></div></div> : <div className="settings-panel settings-placeholder"><div className="settings-heading"><div><h2>{settingsSectionCopy[section].title}</h2><p>{settingsSectionCopy[section].description}</p></div></div>{settingsSectionCopy[section].href ? <Link className="settings-link" href={settingsSectionCopy[section].href}>{settingsSectionCopy[section].action} →</Link> : <div className="setting-note"><Settings size={16}/><span><strong>Coming later</strong><small>Account-level notification preferences are not yet available.</small></span></div>}</div>}</section></>;
}
