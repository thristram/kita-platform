"use client";

import { createElement, useEffect, useMemo, useState } from "react";
import {
  Bell, CalendarDays, Database, FileSearch, Images, LayoutDashboard,
  Moon, Plus, Search, Settings, Sparkles, Sun, Workflow,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ConsoleAsset, ConsoleEvent, ConsoleJob, ConsoleSnapshot, ConsoleSource } from "@/db/console";
import type { ConsoleEventDetail } from "@/db/events";
import { EventWorkspace } from "./EventWorkspace";

export type ConsoleView = "overview" | "events" | "event" | "media" | "sources" | "jobs" | "review" | "settings";

const nav = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "events", label: "Events", icon: CalendarDays },
  { id: "review", label: "Candidates", icon: FileSearch },
  { id: "media", label: "Media Library", icon: Images },
  { id: "sources", label: "Sources", icon: Database },
  { id: "jobs", label: "Crawl Jobs", icon: Workflow },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

export function KitaConsole({ initialData, initialEvent = null, initialView = "overview" }: { initialData: ConsoleSnapshot; initialEvent?: ConsoleEventDetail | null; initialView?: ConsoleView }) {
  const [view, setView] = useState<ConsoleView>(initialEvent ? "event" : initialView);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showMockData, setShowMockData] = useState(initialData.consumerShowMockData);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");

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
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  };

  const filteredCommands = useMemo(() => [
    ["Go to Overview", "overview"], ["Open Events", "events"], ...(initialData.events[0] ? [[`Open ${initialData.events[0].title}`, `event:${initialData.events[0].id}`]] : []),
    ["Review candidates", "review"], ["Browse Media Library", "media"], ["View source health", "sources"], ["View failed jobs", "jobs"],
  ].filter(([label]) => label.toLowerCase().includes(query.toLowerCase())), [initialData.events, query]);

  const navigateToView = (target: ConsoleView) => {
    if (initialEvent) {
      window.location.assign(target === "overview" ? "/" : `/?view=${target}`);
      return;
    }
    setView(target);
  };
  const openEvent = (id: string) => window.location.assign(`/events/${id}`);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigateToView("overview")}><span className="brand-mark"><Sparkles size={18}/></span>KitaCon</button>
        <nav aria-label="Primary navigation">
          {nav.map((item) => <button key={item.id} className={`nav-item ${view === item.id || (view === "event" && item.id === "events") ? "active" : ""}`} onClick={() => navigateToView(item.id)}><span>{createElement(item.icon, { size: 15, strokeWidth: 1.8 })}</span>{item.label}{item.id === "review" && initialData.totals.review ? <b>{initialData.totals.review}</b> : null}{item.id === "jobs" && initialData.totals.queuedJobs ? <b>{initialData.totals.queuedJobs}</b> : null}</button>)}
        </nav>
        <div className="sidebar-spacer" />
        <button className="nav-item" onClick={() => setTheme(theme === "light" ? "dark" : "light")}><span>{theme === "light" ? <Moon size={15}/> : <Sun size={15}/>}</span>{theme === "light" ? "Dark mode" : "Light mode"}</button>
        <div className="profile"><span className="avatar">KA</span><span><strong>Kita Admin</strong><small>admin@kitacon.dev</small></span><span>⌄</span></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="search" onClick={() => setPalette(true)}><Search size={14}/> <span>Search events, entities, sources…</span><kbd>⌘K</kbd></button>
          <a className="consumer-link" href="/discover">Consumer preview ↗</a>
          <button className="icon-button" aria-label="Notifications"><Bell size={14}/></button>
          <button className="primary-button" onClick={() => notify("Event creation is the next editorial workflow") }><Plus size={13}/> Create event</button>
        </header>

        {view === "overview" && <Overview events={initialData.events} sources={initialData.sources} totals={initialData.totals} onOpenEvent={openEvent} onNavigate={navigateToView} />}
        {view === "events" && <EventsView events={initialData.events} onOpen={openEvent} notify={notify} />}
        {view === "event" && initialEvent && <EventWorkspace initialEvent={initialEvent} notify={notify} />}
        {view === "media" && <MediaView assets={initialData.assets} notify={notify} />}
        {view === "sources" && <SourcesView sources={initialData.sources} totals={initialData.totals} notify={notify} />}
        {view === "jobs" && <JobsView jobs={initialData.jobs} notify={notify} />}
        {view === "review" && <ReviewView count={initialData.totals.review} notify={notify} />}
        {view === "settings" && <SettingsView showMockData={showMockData} setShowMockData={setShowMockData} notify={notify} />}

        <footer><span>Last canonical projection 2 minutes ago</span><span>Private operator preview · P0</span></footer>
      </section>

      {palette && <div className="modal-backdrop"><button className="modal-dismiss" aria-label="Close command palette" onClick={() => setPalette(false)}/><div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><div className="command-input"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search or jump to…"/><kbd>ESC</kbd></div><p>Navigation</p>{filteredCommands.map(([label, target]) => <button key={target} onClick={() => { if (target.startsWith("event:")) openEvent(target.slice(6)); else navigateToView(target as ConsoleView); setPalette(false); setQuery(""); }}><span>↳</span>{label}<kbd>↵</kbd></button>)}</div></div>}
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
    <section className="metrics" aria-label="Platform totals"><article><span>Events</span><strong>{totals.events.toLocaleString()}</strong><small>Canonical records</small></article><article><span>Entities</span><strong>{totals.entities.toLocaleString()}</strong><small>Linked subjects</small></article><article><span>Media assets</span><strong>{totals.assets.toLocaleString()}</strong><small>Classified assets</small></article><article><span>Active sources</span><strong>{totals.sources.toLocaleString()}</strong><small>Policy enabled</small></article><article className="attention"><span>Needs review</span><strong>{totals.review.toLocaleString()}</strong><small>{totals.queuedJobs} queued jobs</small></article></section>
    <section className="section-block"><div className="section-title"><div><h2>Upcoming highlights</h2><p>Recently resolved events with usable internal media</p></div><button onClick={() => onNavigate("events")}>View all events →</button></div><div className="highlight-grid">{events.slice(0,4).map((event,index)=><button className="event-card" key={event.id} onClick={() => onOpenEvent(event.id)}><Art tone={event.art} label={index===0?"AX":["夜","葬","GSC"][index-1]} /><div className="event-copy"><strong>{event.title}</strong><span>{event.date} · {event.place}</span><small>{event.type}</small></div></button>)}</div></section>
    <div className="operations-grid"><section className="panel"><div className="panel-head"><div><h2>Source health</h2><p>Official and provider ingestion</p></div><button onClick={()=>onNavigate("sources")}>View sources →</button></div><div className="source-list">{sources.slice(0,4).map((source)=><button className="source-row" key={source.id} onClick={()=>onNavigate("sources")}><span className="source-logo">{source.name.slice(0,2).toUpperCase()}</span><span className="source-name"><strong>{source.name}</strong><small>Last success {source.lastSuccess}</small></span><span className={`status ${source.status.toLowerCase()}`}><i />{source.status}</span><time>{source.lastSuccess}</time><span>›</span></button>)}</div></section>
    <section className="panel"><div className="panel-head"><div><h2>Intelligence queue</h2><p>PostgreSQL is the durable source of truth</p></div><button onClick={()=>onNavigate("jobs")}>Open queue →</button></div><div className="queue-chart"><div className="queue-row"><span>Queued</span><div><i style={{width: totals.queuedJobs ? "100%" : "0%"}}/></div><strong>{totals.queuedJobs}</strong></div></div><div className="worker-line"><span className={totals.queuedJobs ? "live-dot" : "idle-dot"}/><span><strong>{totals.queuedJobs ? "Waiting for crawler worker" : "Queue is idle"}</strong><small>Start the Python worker to lease queued jobs</small></span><b>{totals.queuedJobs ? "Queued" : "Idle"}</b></div></section>
    <section className="panel review-panel"><div className="panel-head"><div><h2>Editorial review</h2><p>Canonical changes needing attention</p></div></div><div className="review-stats"><div><strong>{totals.review}</strong><span>Candidates</span></div><div><strong>0</strong><span>Conflicts</span></div><div><strong>0</strong><span>Media</span></div></div><button className="secondary-button" onClick={()=>onNavigate("review")}>{totals.review ? "Start reviewing" : "Open review queue"} <span>→</span></button></section></div>
  </>;
}

function EventsView({ events, onOpen, notify }: { events: ConsoleEvent[]; onOpen: (id: string) => void; notify: (m:string)=>void }) {
  const [filter,setFilter]=useState("All");
  return <><PageHead eyebrow="Canonical content" title="Events" description="Manage published, draft, and review-ready real-world events" action={<button className="primary-button" onClick={()=>notify("Event creation is the next editorial workflow")}><Plus size={13}/> Create event</button>}/><div className="filterbar"><button className="filter-search"><Search size={13}/> Search events…</button>{["All","Convention","Concert","Pop-up","Needs review"].map(item=><button className={filter===item?"selected":""} onClick={()=>setFilter(item)} key={item}>{item}</button>)}<button className="filter-more">More filters⌄</button></div><section className="data-panel"><div className="table-head event-row"><span>Event</span><span>Type</span><span>Date & location</span><span>Fandom links</span><span>Sources</span><span>Status</span><span/></div>{events.filter(e=>filter==="All"||e.type===filter||filter==="Needs review"&&e.state==="Review").map((event,index)=><button className="event-row table-row" key={event.id} onClick={() => onOpen(event.id)}><Art tone={event.art} label={index===0?"AX":"K"} compact/><span><strong>{event.title}</strong><small>{event.id.slice(0,12)}</small></span><span><b className="type-badge">{event.type}</b></span><span><strong>{event.date}</strong><small>{event.place}</small></span><span>{event.fandom}</span><span>{event.source}</span><span><b className={`status-pill ${event.state.toLowerCase()}`}>{event.state}</b>{event.dataOrigin === "MOCK" ? <small className="mock-tag">Mock</small> : null}</span><span>›</span></button>)}</section><div className="pagination"><span>Showing {events.length} database records</span><button>‹</button><button className="selected">1</button><button>›</button></div></>;
}

function MediaView({assets,notify}:{assets:ConsoleAsset[];notify:(m:string)=>void}){const [selected,setSelected]=useState(0);const asset=assets[selected];return <><PageHead eyebrow="Centralized asset catalog" title="Media Library" description="Classify, attach, approve, and download media from every source" action={<div className="header-actions"><button onClick={()=>notify("Download bundle prepared with manifest")}>Download selected</button><button className="primary-button" onClick={()=>notify("Upload dialog opened")}><Plus size={13}/> Upload asset</button></div>}/><div className="filterbar"><button className="filter-search"><Search size={13}/> Search assets…</button>{["All categories","All sources","All usage","All rights"].map(item=><button key={item}>{item}⌄</button>)}<span className="result-count">{assets.length} assets</span></div><div className="library-layout"><section><div className="asset-grid">{assets.map((item,index)=><button className="asset-button" onClick={()=>setSelected(index)} key={item.id}><AssetCard asset={item} selected={selected===index} notify={notify}/></button>)}</div></section>{asset ? <aside className="asset-inspector panel"><Art tone={asset.art} label={asset.category==="EVENT_LOGO"?"AX":"KITA"}/><div className="inspector-head"><div><h2>{asset.title}</h2><p>{asset.category}</p></div><b className="status-pill published">Internal default</b></div><dl><div><dt>Dimensions</dt><dd>{asset.dimensions}</dd></div><div><dt>Source</dt><dd>{asset.source}</dd></div><div><dt>Data origin</dt><dd>{asset.dataOrigin}</dd></div><div><dt>Usage</dt><dd>INTERNAL_ONLY</dd></div><div><dt>Rights</dt><dd>UNKNOWN</dd></div></dl><div className="inspector-actions"><button onClick={()=>notify("Original download prepared")}>Download original</button><button onClick={()=>notify("Asset marked PUBLIC_READY")}>Mark public ready</button><button onClick={()=>notify("Asset pinned as internal default")}>Set internal default</button></div></aside> : <aside className="asset-inspector panel">No assets in the database.</aside>}</div></>}
function AssetCard({asset,selected=false,notify}:{asset:ConsoleAsset;selected?:boolean;notify:(m:string)=>void}){return <article className={`asset-card ${selected?"selected":""}`} onDoubleClick={()=>notify(`${asset.title} opened`)}><Art tone={asset.art} label={asset.category==="EVENT_LOGO"?"AX":"K"}/><div><strong>{asset.title}</strong><span>{asset.category}</span><small>{asset.dimensions} · {asset.source}</small>{asset.dataOrigin === "MOCK" ? <small className="mock-tag">Mock data</small> : null}</div>{selected?<b className="check">✓</b>:null}</article>}

function SourcesView({sources,totals,notify}:{sources:ConsoleSource[];totals:ConsoleSnapshot["totals"];notify:(m:string)=>void}){
  const runSource = async (source: ConsoleSource) => {
    const response = await fetch(`/api/crawler/sources/${source.id}/run`, { method: "POST" });
    const payload = await response.json() as { jobId?: string; error?: string };
    notify(response.ok ? `${source.name} queued as ${payload.jobId?.slice(0,8)}` : payload.error || "Unable to queue source");
  };
  return <><PageHead eyebrow="Ingestion operations" title="Sources" description="Registry, scheduling, health, and cursor state" action={<button className="primary-button" onClick={()=>notify("Add source form opened")}><Plus size={13}/> Add source</button>}/><section className="metrics compact-metrics"><article><span>Active</span><strong>{totals.sources}</strong><small>Policy enabled</small></article><article><span>Needs policy review</span><strong>{sources.filter(source=>source.policyStatus!=="REVIEWED_ALLOWED").length}</strong><small>Cannot crawl yet</small></article><article><span>Documents</span><strong>{sources.reduce((sum,source)=>sum+Number(source.items),0)}</strong><small>Raw source records</small></article><article><span>Queued jobs</span><strong>{totals.queuedJobs}</strong><small>Durable PostgreSQL queue</small></article></section><div className="filterbar"><button className="filter-search"><Search size={13}/> Search sources…</button><button>All types⌄</button><button>All trust⌄</button><button>All states⌄</button></div><section className="data-panel source-table"><div className="table-head source-table-row"><span>Source</span><span>Type</span><span>Trust</span><span>Status</span><span>Last success</span><span>Next run</span><span>Items</span><span/></div>{sources.map(source=><div className="source-table-row table-row" key={source.id}><span className="source-identity"><b className="source-logo">{source.name.slice(0,2).toUpperCase()}</b><span><strong>{source.name}</strong><small>connector/{source.type.toLowerCase()} · {source.dataOrigin}</small></span></span><span>{source.type}</span><span>{source.trust}</span><span className={`status ${source.status.toLowerCase()}`}><i/>{source.status}</span><span>{source.lastSuccess}</span><span>{source.nextRun}</span><span>{source.items}</span><span className="row-actions"><button disabled={!source.enabled || source.policyStatus!=="REVIEWED_ALLOWED"} onClick={()=>runSource(source)}>Run now</button></span></div>)}</section></>}

function SettingsView({showMockData,setShowMockData,notify}:{showMockData:boolean;setShowMockData:(value:boolean)=>void;notify:(message:string)=>void}){
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
  return <><PageHead eyebrow="KitaCon instance" title="Settings" description="Manage serving behavior, crawling policy, and media defaults"/><section className="settings-layout"><div className="settings-menu"><button className="active">General</button><button>Sources</button><button>Crawling</button><button>Media</button><button>Notifications</button></div><div className="settings-panel"><div className="settings-heading"><div><h2>Customer data visibility</h2><p>Controls serving queries, not operator views or stored records.</p></div></div><div className="setting-row"><div><strong>Show mock data</strong><p>Include records tagged <code>MOCK</code> in customer-facing event listings.</p></div><Switch checked={showMockData} onCheckedChange={updateMockVisibility} aria-label="Show mock data in customer views"/></div><div className="setting-note"><Database size={16}/><span><strong>Database-backed setting</strong><small>Mock rows remain in Neon when disabled and stay visible to operators with a Mock label.</small></span></div></div></section></>;
}

function JobsView({jobs,notify}:{jobs:ConsoleJob[];notify:(m:string)=>void}){const counts=(priority:string)=>jobs.filter(job=>job.priority===priority).length;return <><PageHead eyebrow="Durable intelligence queue" title="Jobs & workers" description="Lease health, priority backlog, retries, and crawler throughput"/><div className="job-layout"><section className="panel"><div className="panel-head"><div><h2>Queue by priority</h2><p>{jobs.length} jobs stored in PostgreSQL</p></div></div><div className="priority-grid">{["REALTIME","HIGH","NORMAL","BATCH"].map(priority=><div key={priority}><span>{priority}</span><strong>{counts(priority)}</strong><small>database rows</small></div>)}</div></section><section className="panel worker-card"><span className="idle-dot"/><div><h2>Crawler worker</h2><p>Run the Python worker to begin leasing jobs.</p></div><b>{jobs.some(job=>job.status==="Leased"||job.status==="Running")?"Active":"Idle"}</b><dl><div><dt>Stored jobs</dt><dd>{jobs.length}</dd></div><div><dt>Queued</dt><dd>{jobs.filter(job=>job.status==="Queued").length}</dd></div><div><dt>Failed</dt><dd>{jobs.filter(job=>["Dead","Retry Wait"].includes(job.status)).length}</dd></div></dl></section></div><section className="data-panel job-table"><div className="table-head job-row"><span>Job</span><span>Capability</span><span>Priority</span><span>Status</span><span>Worker</span><span>Age</span><span/></div>{jobs.length?jobs.map(job=><div className="job-row table-row" key={job.id}><span><strong>{job.type}</strong><small className="mono">{job.id.slice(0,12)} · {job.dataOrigin}</small></span><span>{job.capability}</span><span><b className="type-badge">{job.priority}</b></span><span><b className={`status-pill ${job.status.toLowerCase().replaceAll(" ","-")}`}>{job.status}</b></span><span>{job.worker}</span><span>{job.age}</span><span className="row-actions"><button onClick={()=>notify(`${job.id.slice(0,8)} selected`)}>Inspect</button></span></div>):<div className="empty-table"><Workflow size={20}/><strong>No crawler jobs yet</strong><span>Review a source policy, enable it, then use Run now.</span></div>}</section></>}

function ReviewView({count,notify}:{count:number;notify:(m:string)=>void}){if(!count)return <><PageHead eyebrow="Editorial review" title="Review queue" description="Resolve extracted candidates before canonical publication"/><section className="panel empty-tab"><FileSearch size={22}/><h2>No candidates need review</h2><p>Run a reviewed source to create evidence-backed extraction candidates.</p><button onClick={()=>notify("Open Sources to queue a crawl")}>Go to Sources</button></section></>;return <><PageHead eyebrow={`${count} candidates`} title="Review queue" description="Keep source evidence visible while resolving canonical fields"/><section className="panel empty-tab"><FileSearch size={22}/><h2>{count} candidates ready</h2><p>Candidate detail rendering is available after a crawler extraction is selected.</p></section></>}
