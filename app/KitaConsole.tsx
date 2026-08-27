"use client";

import { useEffect, useMemo, useState } from "react";

type View = "overview" | "events" | "event" | "media" | "sources" | "jobs" | "review";

const nav: { id: View; label: string; icon: string; count?: number }[] = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "events", label: "Events", icon: "□" },
  { id: "review", label: "Candidates", icon: "◇", count: 16 },
  { id: "media", label: "Media Library", icon: "▧" },
  { id: "sources", label: "Sources", icon: "◎" },
  { id: "jobs", label: "Crawl Jobs", icon: "↻", count: 7 },
];

const events = [
  { title: "Anime Expo 2027", type: "Convention", date: "Jul 2–5, 2027", place: "Los Angeles, CA", fandom: "Demon Slayer · Frieren", state: "Published", source: "5 sources", art: "coral" },
  { title: "YOASOBI Live in Seattle", type: "Concert", date: "Oct 18, 2026", place: "Seattle, WA", fandom: "YOASOBI", state: "Published", source: "3 sources", art: "violet" },
  { title: "Frieren Orchestra Concert", type: "Concert", date: "Sep 27, 2026", place: "Tokyo, Japan", fandom: "Frieren · Evan Call", state: "Review", source: "4 sources", art: "blue" },
  { title: "Good Smile AX Exclusive Pop-up", type: "Pop-up", date: "Jul 3–6, 2027", place: "Los Angeles, CA", fandom: "Hatsune Miku", state: "Draft", source: "2 sources", art: "amber" },
  { title: "Demon Slayer World Tour", type: "Exhibition", date: "Aug 10–24, 2026", place: "San Francisco, CA", fandom: "Demon Slayer", state: "Published", source: "6 sources", art: "rose" },
];

const assets = [
  ["AX 2027 Key Visual", "EVENT_HERO", "1920 × 1080", "Official website", "coral"],
  ["Anime Expo Poster", "EVENT_POSTER", "1080 × 1350", "Anime Expo", "navy"],
  ["AX Logo", "EVENT_LOGO", "1024 × 1024", "Official website", "red"],
  ["Frieren Orchestra", "FANDOM_POSTER", "1400 × 2100", "TMDB", "blue"],
  ["YOASOBI Seattle", "EVENT_HERO", "1920 × 1080", "Ticketmaster", "violet"],
  ["Good Smile AX", "SOCIAL_POST", "1080 × 1080", "Instagram", "amber"],
  ["LACC Exterior", "VENUE_LOGO", "1600 × 900", "Official website", "slate"],
  ["Demon Slayer Tour", "EVENT_POSTER", "1200 × 1600", "Aniplex USA", "rose"],
];

const sourceRows = [
  ["Anime Expo Official", "WEBSITE", "OFFICIAL", "Healthy", "2m ago", "in 6h", "245"],
  ["Bangumi Archive", "ARCHIVE", "CURATED", "Healthy", "3d ago", "Sunday", "18,592"],
  ["TMDB Changes", "API", "PARTNER", "Healthy", "14m ago", "in 10h", "312"],
  ["Aniplex USA", "X_ACCOUNT", "OFFICIAL", "Healthy", "16m ago", "in 44m", "86"],
  ["Ticketmaster Anime", "API", "PARTNER", "Review", "1h ago", "in 3h", "1,204"],
  ["Good Smile Company", "WEBSITE", "OFFICIAL", "Healthy", "32m ago", "in 5h", "162"],
];

export function KitaConsole() {
  const [view, setView] = useState<View>("overview");
  const [eventTab, setEventTab] = useState("Overview");
  const [theme, setTheme] = useState<"light" | "dark">("light");
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
    ["Go to Overview", "overview"], ["Open Events", "events"], ["Open Anime Expo 2027", "event"],
    ["Review candidates", "review"], ["Browse Media Library", "media"], ["View source health", "sources"], ["View failed jobs", "jobs"],
  ].filter(([label]) => label.toLowerCase().includes(query.toLowerCase())), [query]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("overview")}><span className="brand-mark">✦</span>KitaCon</button>
        <nav aria-label="Primary navigation">
          {nav.map((item) => <button key={item.id} className={`nav-item ${view === item.id || (view === "event" && item.id === "events") ? "active" : ""}`} onClick={() => setView(item.id)}><span>{item.icon}</span>{item.label}{item.count ? <b>{item.count}</b> : null}</button>)}
        </nav>
        <div className="sidebar-spacer" />
        <button className="nav-item" onClick={() => setTheme(theme === "light" ? "dark" : "light")}><span>{theme === "light" ? "☾" : "☼"}</span>{theme === "light" ? "Dark mode" : "Light mode"}</button>
        <div className="profile"><span className="avatar">KA</span><span><strong>Kita Admin</strong><small>admin@kitacon.dev</small></span><span>⌄</span></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="search" onClick={() => setPalette(true)}>⌕ <span>Search events, entities, sources…</span><kbd>⌘K</kbd></button>
          <a className="consumer-link" href="/discover">Consumer preview ↗</a>
          <button className="icon-button" aria-label="Notifications">●</button>
          <button className="primary-button" onClick={() => { setView("event"); notify("New event draft opened"); }}>＋ Create event</button>
        </header>

        {view === "overview" && <Overview onOpenEvent={() => setView("event")} onNavigate={setView} />}
        {view === "events" && <EventsView onOpen={() => setView("event")} notify={notify} />}
        {view === "event" && <EventDetail tab={eventTab} setTab={setEventTab} notify={notify} />}
        {view === "media" && <MediaView notify={notify} />}
        {view === "sources" && <SourcesView notify={notify} />}
        {view === "jobs" && <JobsView notify={notify} />}
        {view === "review" && <ReviewView notify={notify} />}

        <footer><span>Last canonical projection 2 minutes ago</span><span>Private operator preview · P0</span></footer>
      </section>

      {palette && <div className="modal-backdrop" role="presentation" onMouseDown={() => setPalette(false)}><div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}><div className="command-input">⌕<input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search or jump to…"/><kbd>ESC</kbd></div><p>Navigation</p>{filteredCommands.map(([label, target]) => <button key={target} onClick={() => { setView(target as View); setPalette(false); setQuery(""); }}><span>↳</span>{label}<kbd>↵</kbd></button>)}</div></div>}
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

function Overview({ onOpenEvent, onNavigate }: { onOpenEvent: () => void; onNavigate: (view: View) => void }) {
  return <>
    <PageHead eyebrow="KitaCon Console" title="Overview" description="Your fandom intelligence hub" action={<span className="sync-state"><i /> All systems operational</span>} />
    <section className="metrics" aria-label="Platform totals"><article><span>Events</span><strong>1,248</strong><small className="positive">+24 this week</small></article><article><span>Entities</span><strong>18,592</strong><small className="positive">+342 this week</small></article><article><span>Media assets</span><strong>8,932</strong><small className="positive">+128 today</small></article><article><span>Active sources</span><strong>186</strong><small className="positive">+7 this week</small></article><article className="attention"><span>Needs review</span><strong>23</strong><small>7 high priority</small></article></section>
    <section className="section-block"><div className="section-title"><div><h2>Upcoming highlights</h2><p>Recently resolved events with usable internal media</p></div><button onClick={() => onNavigate("events")}>View all events →</button></div><div className="highlight-grid">{events.slice(0,4).map((event,index)=><button className="event-card" key={event.title} onClick={onOpenEvent}><Art tone={event.art} label={index===0?"AX":["夜","葬","GSC"][index-1]} /><div className="event-copy"><strong>{event.title}</strong><span>{event.date} · {event.place}</span><small>{event.type}</small></div></button>)}</div></section>
    <div className="operations-grid"><section className="panel"><div className="panel-head"><div><h2>Source health</h2><p>Official and provider ingestion</p></div><button onClick={()=>onNavigate("sources")}>View sources →</button></div><div className="source-list">{sourceRows.slice(0,4).map(([name,, ,status,time])=><button className="source-row" key={name} onClick={()=>onNavigate("sources")}><span className="source-logo">{name.slice(0,2).toUpperCase()}</span><span className="source-name"><strong>{name}</strong><small>Last success {time}</small></span><span className={`status ${status.toLowerCase()}`}><i />{status}</span><time>{time}</time><span>›</span></button>)}</div></section>
    <section className="panel"><div className="panel-head"><div><h2>Intelligence queue</h2><p>Bounded jobs by priority</p></div><button onClick={()=>onNavigate("jobs")}>Open queue →</button></div><div className="queue-chart">{([['Realtime',3,'30%'],['High',8,'56%'],['Normal',31,'82%'],['Batch',126,'68%']] as const).map(([label,count,width])=><div className="queue-row" key={label}><span>{label}</span><div><i style={{width}}/></div><strong>{count}</strong></div>)}</div><div className="worker-line"><span className="live-dot"/><span><strong>kita-local-01</strong><small>Vision · Qwen 2.5 VL · 41 jobs/hr</small></span><b>Online</b></div></section>
    <section className="panel review-panel"><div className="panel-head"><div><h2>Editorial review</h2><p>Canonical changes needing attention</p></div></div><div className="review-stats"><div><strong>16</strong><span>Candidates</span></div><div><strong>7</strong><span>Conflicts</span></div><div><strong>4</strong><span>Media</span></div></div><button className="secondary-button" onClick={()=>onNavigate("review")}>Start reviewing <span>→</span></button></section></div>
  </>;
}

function EventsView({ onOpen, notify }: { onOpen: () => void; notify: (m:string)=>void }) {
  const [filter,setFilter]=useState("All");
  return <><PageHead eyebrow="Canonical content" title="Events" description="Manage published, draft, and review-ready real-world events" action={<button className="primary-button" onClick={()=>notify("New event draft created")}>＋ Create event</button>}/><div className="filterbar"><button className="filter-search">⌕ Search events…</button>{["All","Convention","Concert","Pop-up","Needs review"].map(item=><button className={filter===item?"selected":""} onClick={()=>setFilter(item)} key={item}>{item}</button>)}<button className="filter-more">More filters⌄</button></div><section className="data-panel"><div className="table-head event-row"><span>Event</span><span>Type</span><span>Date & location</span><span>Fandom links</span><span>Sources</span><span>Status</span><span/></div>{events.filter(e=>filter==="All"||e.type===filter||filter==="Needs review"&&e.state==="Review").map((event,index)=><button className="event-row table-row" key={event.title} onClick={onOpen}><Art tone={event.art} label={index===0?"AX":"K"} compact/><span><strong>{event.title}</strong><small>evt_{(index+1).toString().padStart(4,"0")}a7f</small></span><span><b className="type-badge">{event.type}</b></span><span><strong>{event.date}</strong><small>{event.place}</small></span><span>{event.fandom}</span><span>{event.source}</span><span><b className={`status-pill ${event.state.toLowerCase()}`}>{event.state}</b></span><span>›</span></button>)}</section><div className="pagination"><span>Showing 1–{events.length} of 1,248</span><button>‹</button><button className="selected">1</button><button>2</button><button>3</button><button>›</button></div></>;
}

function EventDetail({ tab,setTab,notify }:{tab:string;setTab:(s:string)=>void;notify:(m:string)=>void}) {
  const tabs=["Overview","Fandom Links","Venue","Media","Sources","Conflicts","History","Preview"];
  return <><div className="detail-head"><button className="back-link">‹ Events</button><div className="detail-title"><span className="detail-logo">AX</span><div><div className="title-line"><h1>Anime Expo 2027</h1><b className="status-pill published">Published</b></div><p>Jul 2–5, 2027 · Los Angeles Convention Center · Los Angeles, CA</p><span className="type-badge">Convention</span></div></div><div className="detail-actions"><button onClick={()=>notify("Private preview opened")}>Preview</button><button onClick={()=>notify("Changes saved")}>Save changes</button><button className="primary-button" onClick={()=>notify("Event unpublished from serving projections")}>Unpublish</button></div></div><div className="tabs" role="tablist">{tabs.map(item=><button role="tab" aria-selected={tab===item} className={tab===item?"active":""} onClick={()=>setTab(item)} key={item}>{item}{item==="Media"?<small>24</small>:null}{item==="Conflicts"?<small className="warn-count">1</small>:null}</button>)}</div>{tab==="Overview"&&<EventOverview/>}{tab==="Media"&&<EventMedia notify={notify}/>} {tab!=="Overview"&&tab!=="Media"&&<EmptyTab tab={tab}/>}</>;
}

function EventOverview(){return <div className="detail-grid"><div className="detail-main"><section className="panel hero-panel"><div className="panel-head"><div><h2>Internal cover</h2><p>Resolved from official event hero · Pinned</p></div><b className="status-pill published">Internal default</b></div><Art tone="coral" label="ANIME EXPO 2027"/></section><section className="panel form-section"><div className="section-title"><div><h2>Event information</h2><p>Canonical customer-visible fields</p></div><button>Edit fields</button></div><div className="field-grid"><Field label="Canonical title" value="Anime Expo 2027" meta="Manual · PREFERRED"/><Field label="Event type" value="Convention" meta="Auto · Official source"/><Field label="Start" value="Jul 2, 2027 · 9:00 AM" meta="Manual · PINNED"/><Field label="End" value="Jul 5, 2027 · 6:00 PM" meta="Manual · PINNED"/><Field label="Timezone" value="America/Los_Angeles" meta="Venue derived"/><Field label="Organizer" value="Society for the Promotion of Japanese Animation" meta="Verified entity"/></div></section><section className="panel"><div className="section-title"><div><h2>Summary</h2><p>English · public projection</p></div><button>Edit</button></div><p className="description">Anime Expo brings fans and industry together for North America’s largest celebration of Japanese animation, manga, games, music, and pop culture.</p></section></div><aside className="detail-side"><section className="panel"><h2>Publication</h2><dl><div><dt>Serving state</dt><dd><b className="status-pill published">Published</b></dd></div><div><dt>Projection</dt><dd>Current · v128</dd></div><div><dt>Last verified</dt><dd>2 minutes ago</dd></div><div><dt>Open conflicts</dt><dd className="warning-text">1 date assertion</dd></div></dl></section><section className="panel"><h2>Fandom links</h2><div className="chip-list"><span>Frieren</span><span>Demon Slayer</span><span>Hatsune Miku</span><span>Good Smile</span></div><button className="text-action">Manage 12 relationships →</button></section><section className="panel"><h2>Primary sources</h2><div className="mini-source"><i className="healthy"/>Official website<b>98%</b></div><div className="mini-source"><i className="healthy"/>AnimeCons<b>91%</b></div><div className="mini-source"><i className="healthy"/>Ticketmaster<b>88%</b></div></section></aside></div>}
function Field({label,value,meta}:{label:string;value:string;meta:string}){return <div className="field"><span>{label}</span><strong>{value}</strong><small>{meta}</small></div>}

function EventMedia({notify}:{notify:(m:string)=>void}){return <div className="media-detail"><section className="panel internal-cover"><div><p className="eyebrow">Resolved internal cover</p><h2>AX 2027 Key Visual</h2><p>Official event hero · 1920 × 1080 · INTERNAL_ONLY</p><div className="cover-actions"><button onClick={()=>notify("Original download prepared")}>Download original</button><button onClick={()=>notify("Internal cover pinned")}>Pin selection</button></div></div><Art tone="coral" label="AX 2027"/></section><div className="media-section-head"><div><h2>Official / Event Hero</h2><p>1 default · 3 alternatives</p></div><button>＋ Upload asset</button></div><div className="asset-grid event-assets">{assets.slice(0,4).map((asset,index)=><AssetCard asset={asset} key={asset[0]} selected={index===0} notify={notify}/>)}</div><div className="media-section-head"><div><h2>Provider & related fandom</h2><p>Inherited and evidence candidates</p></div></div><div className="asset-grid event-assets">{assets.slice(4).map(asset=><AssetCard asset={asset} key={asset[0]} notify={notify}/>)}</div></div>}

function EmptyTab({tab}:{tab:string}){return <section className="panel empty-tab"><span>◇</span><h2>{tab}</h2><p>This workspace is connected to Anime Expo 2027’s canonical record.</p><button>Open {tab.toLowerCase()} workspace</button></section>}

function MediaView({notify}:{notify:(m:string)=>void}){const [selected,setSelected]=useState(1);return <><PageHead eyebrow="Centralized asset catalog" title="Media Library" description="Classify, attach, approve, and download media from every source" action={<div className="header-actions"><button onClick={()=>notify("Download bundle prepared with manifest")}>⇩ Download selected</button><button className="primary-button" onClick={()=>notify("Upload dialog opened")}>＋ Upload asset</button></div>}/><div className="filterbar"><button className="filter-search">⌕ Search assets…</button>{["All categories","All sources","All usage","All rights"].map(item=><button key={item}>{item}⌄</button>)}<span className="result-count">8,932 assets</span></div><div className="library-layout"><section><div className="asset-grid">{assets.map((asset,index)=><button className="asset-button" onClick={()=>setSelected(index)} key={asset[0]}><AssetCard asset={asset} selected={selected===index} notify={notify}/></button>)}</div></section><aside className="asset-inspector panel"><Art tone={assets[selected][4]} label={selected===2?"AX":"KITA"}/><div className="inspector-head"><div><h2>{assets[selected][0]}</h2><p>{assets[selected][1]}</p></div><b className="status-pill published">Internal default</b></div><dl><div><dt>Dimensions</dt><dd>{assets[selected][2]}</dd></div><div><dt>Source</dt><dd>{assets[selected][3]}</dd></div><div><dt>Usage</dt><dd>INTERNAL_ONLY</dd></div><div><dt>Rights</dt><dd>UNKNOWN</dd></div><div><dt>Origin</dt><dd>CRAWLED</dd></div><div><dt>SHA-256</dt><dd className="mono">7f3a…c62e</dd></div></dl><div className="inspector-actions"><button onClick={()=>notify("Original download prepared")}>Download original</button><button onClick={()=>notify("Asset marked PUBLIC_READY")}>Mark public ready</button><button onClick={()=>notify("Asset pinned as internal default")}>Set internal default</button></div></aside></div></>}
function AssetCard({asset,selected=false,notify}:{asset:string[];selected?:boolean;notify:(m:string)=>void}){return <article className={`asset-card ${selected?"selected":""}`} onDoubleClick={()=>notify(`${asset[0]} opened`)}><Art tone={asset[4]} label={asset[1]==="EVENT_LOGO"?"AX":"K"}/><div><strong>{asset[0]}</strong><span>{asset[1]}</span><small>{asset[2]} · {asset[3]}</small></div>{selected?<b className="check">✓</b>:null}</article>}

function SourcesView({notify}:{notify:(m:string)=>void}){return <><PageHead eyebrow="Ingestion operations" title="Sources" description="Registry, scheduling, health, and cursor state" action={<button className="primary-button" onClick={()=>notify("Add source form opened")}>＋ Add source</button>}/><section className="metrics compact-metrics"><article><span>Active</span><strong>186</strong><small className="positive">183 healthy</small></article><article><span>Needs attention</span><strong>3</strong><small>1 authorization issue</small></article><article><span>Documents today</span><strong>2,481</strong><small className="positive">+18%</small></article><article><span>Next scheduled</span><strong>8m</strong><small>AnimeCons</small></article></section><div className="filterbar"><button className="filter-search">⌕ Search sources…</button><button>All types⌄</button><button>All trust⌄</button><button>All states⌄</button></div><section className="data-panel source-table"><div className="table-head source-table-row"><span>Source</span><span>Type</span><span>Trust</span><span>Status</span><span>Last success</span><span>Next run</span><span>Items</span><span/></div>{sourceRows.map(row=><div className="source-table-row table-row" key={row[0]}><span className="source-identity"><b className="source-logo">{row[0].slice(0,2).toUpperCase()}</b><span><strong>{row[0]}</strong><small>connector/{row[1].toLowerCase()}</small></span></span><span>{row[1]}</span><span>{row[2]}</span><span className={`status ${row[3].toLowerCase()}`}><i/>{row[3]}</span><span>{row[4]}</span><span>{row[5]}</span><span>{row[6]}</span><span className="row-actions"><button onClick={()=>notify(`${row[0]} crawl started`)}>Run now</button><button>•••</button></span></div>)}</section></>}

function JobsView({notify}:{notify:(m:string)=>void}){const jobs=[["Extract event from AX announcement","VISION","HIGH","Running","kita-local-01","2m"],["Classify 18 website images","VISION","NORMAL","Pending","—","8m"],["Resolve Frieren entity links","TEXT","NORMAL","Completed","kita-local-01","16m"],["Parse Ticketmaster update","INGESTION","REALTIME","Failed","cloud-ingest-02","32m"],["Summarize Good Smile page","TEXT","BATCH","Pending","—","1h"]];return <><PageHead eyebrow="Durable intelligence queue" title="Jobs & workers" description="Lease health, priority backlog, retries, and model throughput" action={<button className="primary-button" onClick={()=>notify("Batch generation paused")}>Pause batch</button>}/><div className="job-layout"><section className="panel"><div className="panel-head"><div><h2>Queue by priority</h2><p>Oldest pending job: 1h 12m</p></div></div><div className="priority-grid"><div><span>Realtime</span><strong>3</strong><small>0 failed</small></div><div><span>High</span><strong>8</strong><small>2 running</small></div><div><span>Normal</span><strong>31</strong><small>4 running</small></div><div><span>Batch</span><strong>126</strong><small>bounded</small></div></div></section><section className="panel worker-card"><span className="live-dot"/><div><h2>kita-local-01</h2><p>Ollama · Qwen 2.5 VL · TEXT, VISION</p></div><b>Online</b><dl><div><dt>Heartbeat</dt><dd>8 sec ago</dd></div><div><dt>Throughput</dt><dd>41 jobs/hr</dd></div><div><dt>Current lease</dt><dd>job_7fa2</dd></div></dl></section></div><section className="data-panel job-table"><div className="table-head job-row"><span>Job</span><span>Capability</span><span>Priority</span><span>Status</span><span>Worker</span><span>Age</span><span/></div>{jobs.map(job=><div className="job-row table-row" key={job[0]}><span><strong>{job[0]}</strong><small className="mono">job_{job[0].slice(0,4).toLowerCase()}7f</small></span><span>{job[1]}</span><span><b className="type-badge">{job[2]}</b></span><span><b className={`status-pill ${job[3].toLowerCase()}`}>{job[3]}</b></span><span>{job[4]}</span><span>{job[5]}</span><span className="row-actions"><button onClick={()=>notify(`${job[0]} queued for retry`)}>Retry</button><button>•••</button></span></div>)}</section></>}

function ReviewView({notify}:{notify:(m:string)=>void}){const [decision,setDecision]=useState("Pending review");return <><PageHead eyebrow="Candidate 1 of 16" title="Review event candidate" description="Keep source evidence visible while resolving canonical fields" action={<b className="status-pill review">{decision}</b>}/><div className="review-workspace"><section className="evidence-pane"><div className="pane-head"><div><h2>Source evidence</h2><p>Anime Expo official website · fetched 2m ago</p></div><button>View raw ↗</button></div><Art tone="coral" label="AX 2027"/><div className="evidence-copy"><span>OFFICIAL WEBSITE</span><h3>Anime Expo returns July 2–5, 2027</h3><p>Join fans from around the world at the Los Angeles Convention Center for four days of anime, manga, gaming, guests, concerts, and industry programming.</p><dl><div><dt>Canonical URL</dt><dd>anime-expo.org/ax-2027</dd></div><div><dt>Content hash</dt><dd className="mono">sha256:9ac4…31bd</dd></div><div><dt>Trust</dt><dd>OFFICIAL · 0.98</dd></div></dl></div></section><section className="candidate-pane"><div className="pane-head"><div><h2>Proposed canonical result</h2><p>Deterministic parser + vision classification</p></div><b className="confidence">92% confidence</b></div><div className="candidate-fields"><ReviewField label="Event title" value="Anime Expo 2027" confidence="99%"/><ReviewField label="Event type" value="CONVENTION" confidence="98%"/><ReviewField label="Start date" value="July 2, 2027 · 9:00 AM" confidence="91%" warning="Conflicts with current Jul 3 start"/><ReviewField label="End date" value="July 5, 2027 · 6:00 PM" confidence="94%"/><ReviewField label="Venue" value="Los Angeles Convention Center" confidence="97%"/><ReviewField label="Fandom matches" value="Demon Slayer, Frieren, Hatsune Miku" confidence="84%" warning="2 inferred from hero image"/></div></section></div><div className="sticky-review-bar"><span><b>1 field conflict</b><small>Approval creates assertions, canonical changes, and one outbox event atomically.</small></span><div><button onClick={()=>{setDecision("Rejected");notify("Candidate rejected and audited")}}>Reject</button><button onClick={()=>notify("Existing event match selected")}>Merge / Match</button><button className="primary-button" onClick={()=>{setDecision("Approved");notify("Candidate approved; projection queued")}}>Approve candidate</button></div></div></>}
function ReviewField({label,value,confidence,warning}:{label:string;value:string;confidence:string;warning?:string}){return <label className={warning?"review-field warning-field":"review-field"}><span>{label}<b>{confidence}</b></span><input defaultValue={value}/>{warning?<small>⚠ {warning}</small>:<small>Source-supported · AUTO</small>}</label>}
