"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, BrainCircuit, Clock3, FileText, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { ResolutionDashboardStatus } from "@/db/resolutionDashboard";
import { compareValues, nextSort, SortHeader, TablePagination, TableSearch, type SortDirection } from "./ConsoleTableControls";

const pretty = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Not started";

async function loadStatus(): Promise<ResolutionDashboardStatus> {
  const response = await fetch("/api/resolution/status", { cache: "no-store" });
  const body = await response.json() as ResolutionDashboardStatus & { error?: string };
  if (!response.ok) throw new Error(body.error || "Could not load resolution jobs");
  return body;
}

export function ResolutionJobsWorkspace({ notify }: { notify: (message: string) => void }) {
  type JobSort = "sourceName" | "mode" | "documentCount" | "status" | "worker" | "createdAt";
  type AgentSort = "name" | "state" | "model" | "lastHeartbeatAt";
  const [status, setStatus] = useState<ResolutionDashboardStatus>({ checkedAt: new Date(0).toISOString(), workers: [], jobs: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [jobQuery, setJobQuery] = useState("");
  const [jobStatus, setJobStatus] = useState("ALL");
  const [jobSortField, setJobSortField] = useState<JobSort>("createdAt");
  const [jobSortDirection, setJobSortDirection] = useState<SortDirection>("desc");
  const [jobPage, setJobPage] = useState(1);
  const [agentQuery, setAgentQuery] = useState("");
  const [agentState, setAgentState] = useState("ALL");
  const [agentSortField, setAgentSortField] = useState<AgentSort>("lastHeartbeatAt");
  const [agentSortDirection, setAgentSortDirection] = useState<SortDirection>("desc");
  const [agentPage, setAgentPage] = useState(1);
  const pageSize = 5;

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try { setStatus(await loadStatus()); }
    catch (error) { if (!quiet) notify(error instanceof Error ? error.message : "Could not load resolution jobs"); }
    finally { setLoading(false); if (!quiet) setRefreshing(false); }
  }, [notify]);

  useEffect(() => { const initial = window.setTimeout(() => void refresh(true), 0); const interval = window.setInterval(() => void refresh(true), 4_000); return () => { window.clearTimeout(initial); window.clearInterval(interval); }; }, [refresh]);

  const visibleJobs = useMemo(() => { const needle = jobQuery.trim().toLowerCase(); return status.jobs.filter((job) => jobStatus === "ALL" || pretty(job.status) === jobStatus).filter((job) => !needle || [job.sourceName, job.id, job.worker, job.modelName, job.promptVersion, job.error].some((value) => value.toLowerCase().includes(needle))).sort((left, right) => compareValues(left[jobSortField] ?? "", right[jobSortField] ?? "", jobSortDirection)); }, [jobQuery, jobSortDirection, jobSortField, jobStatus, status.jobs]);
  const visibleAgents = useMemo(() => { const needle = agentQuery.trim().toLowerCase(); return status.workers.filter((agent) => agentState === "ALL" || agent.state === agentState).filter((agent) => !needle || `${agent.name} ${agent.id} ${agent.version} ${agent.model}`.toLowerCase().includes(needle)).sort((left, right) => compareValues(left[agentSortField] || "", right[agentSortField] || "", agentSortDirection)); }, [agentQuery, agentSortDirection, agentSortField, agentState, status.workers]);
  const jobPageCount = Math.max(1, Math.ceil(visibleJobs.length / pageSize));
  const agentPageCount = Math.max(1, Math.ceil(visibleAgents.length / pageSize));
  const pagedJobs = visibleJobs.slice((Math.min(jobPage, jobPageCount) - 1) * pageSize, Math.min(jobPage, jobPageCount) * pageSize);
  const pagedAgents = visibleAgents.slice((Math.min(agentPage, agentPageCount) - 1) * pageSize, Math.min(agentPage, agentPageCount) * pageSize);
  const sortJobs = (field: JobSort) => { const next = nextSort(jobSortField, jobSortDirection, field); setJobSortField(next.field); setJobSortDirection(next.direction); };
  const sortAgents = (field: AgentSort) => { const next = nextSort(agentSortField, agentSortDirection, field); setAgentSortField(next.field); setAgentSortDirection(next.direction); };
  const active = status.jobs.filter((job) => ["QUEUED", "RETRY_WAIT", "RUNNING", "LEASED"].includes(job.status)).length;
  const llm = status.jobs.filter((job) => job.modelProvider !== "deterministic" && job.modelProvider !== "pending").length;
  const failed = status.jobs.filter((job) => ["DEAD", "FAILED"].includes(job.status)).length;
  const statuses = [...new Set(status.jobs.map((job) => job.status))].sort();

  return <>
    <div className="page-head"><div><p className="eyebrow">Resolution control</p><h1>Resolution jobs</h1><p>Monitor LLM, knowledge-base, and deterministic event processing separately from crawling.</p></div><button className="secondary-button jobs-refresh" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} className={refreshing ? "spin" : ""}/><span>{refreshing ? "Refreshing" : "Refresh"}</span></button></div>
    <section className="metrics compact-metrics resolution-metrics"><article><span className="metric-icon violet"><Bot size={18}/></span><span>Agents online</span><strong>{status.workers.filter((worker) => worker.state === "Online").length}</strong><small>{status.workers.length} registered</small></article><article><span className="metric-icon blue"><Clock3 size={18}/></span><span>Active jobs</span><strong>{active}</strong><small>Queued or running</small></article><article><span className="metric-icon green"><BrainCircuit size={18}/></span><span>LLM completed</span><strong>{llm}</strong><small>Knowledge enriched</small></article><article><span className="metric-icon amber"><TriangleAlert size={18}/></span><span>Failed</span><strong>{failed}</strong><small>Needs attention</small></article></section>
    <div className="worker-dashboard-grid">
      <section className="panel worker-table-panel"><div className="panel-head"><div><h2>Resolution jobs</h2><p>Inference state, model provenance, and output</p></div><span>{visibleJobs.length} jobs</span></div><div className="worker-panel-tools"><TableSearch value={jobQuery} onChange={(value) => { setJobQuery(value); setJobPage(1); }} placeholder="Search resolution jobs..."/><label className="table-select"><select value={jobStatus} onChange={(event) => { setJobStatus(event.target.value); setJobPage(1); }} aria-label="Resolution job status"><option value="ALL">All statuses</option>{statuses.map((item) => <option key={item}>{pretty(item)}</option>)}</select></label></div><div className="compact-table resolution-compact-table"><div className="table-head resolution-compact-row"><SortHeader label="Job" field="sourceName" activeField={jobSortField} direction={jobSortDirection} onSort={sortJobs}/><SortHeader label="Method" field="mode" activeField={jobSortField} direction={jobSortDirection} onSort={sortJobs}/><SortHeader label="Docs" field="documentCount" activeField={jobSortField} direction={jobSortDirection} onSort={sortJobs}/><SortHeader label="Status" field="status" activeField={jobSortField} direction={jobSortDirection} onSort={sortJobs}/><SortHeader label="Worker" field="worker" activeField={jobSortField} direction={jobSortDirection} onSort={sortJobs}/><span/></div>{pagedJobs.map((job) => <div className="resolution-compact-row table-row" key={job.id}><span><strong>{job.sourceName}</strong><small>{job.id.slice(0, 8)} · attempt {job.attempt}/{job.maxAttempts}</small></span><span><b>{job.mode === "LLM_REQUIRED" ? "LLM required" : job.modelProvider === "deterministic" ? "Deterministic" : "LLM + KB"}</b><small>{job.modelName} · {job.inputTokens?.toLocaleString() || 0} in / {job.outputTokens?.toLocaleString() || 0} out</small></span><span>{job.documentCount}</span><span><b className={`status-pill ${job.status.toLowerCase()}`}>{pretty(job.status)}</b>{job.error ? <small title={job.error}>{job.errorCode || job.error}</small> : null}</span><span>{job.worker}<small>{time(job.startedAt)}</small></span><span>{job.candidateId ? <Link href={`/candidates/${job.candidateId}/overview`}>Review</Link> : job.status === "RUNNING" ? <LoaderCircle className="spin" size={15}/> : <FileText size={15}/>}</span></div>)}{!loading && !pagedJobs.length ? <div className="compact-empty"><FileText size={18}/><span><strong>No matching resolution jobs</strong><small>Jobs appear after a crawl becomes quiescent.</small></span></div> : null}</div><TablePagination page={Math.min(jobPage, jobPageCount)} pageCount={jobPageCount} onPage={setJobPage}/></section>
      <section className="panel worker-table-panel"><div className="panel-head"><div><h2>Resolution agents</h2><p>Workers that lease EVENT_RESOLUTION jobs</p></div><span>{status.workers.filter((worker) => worker.state === "Online").length} online</span></div><div className="worker-panel-tools"><TableSearch value={agentQuery} onChange={(value) => { setAgentQuery(value); setAgentPage(1); }} placeholder="Search resolution agents..."/><label className="table-select"><select value={agentState} onChange={(event) => { setAgentState(event.target.value); setAgentPage(1); }} aria-label="Resolution agent state"><option value="ALL">All states</option><option>Online</option><option>Offline</option></select></label></div><div className="compact-table resolution-agent-table"><div className="table-head resolution-agent-row"><SortHeader label="Agent" field="name" activeField={agentSortField} direction={agentSortDirection} onSort={sortAgents}/><SortHeader label="Model" field="model" activeField={agentSortField} direction={agentSortDirection} onSort={sortAgents}/><SortHeader label="State" field="state" activeField={agentSortField} direction={agentSortDirection} onSort={sortAgents}/><SortHeader label="Heartbeat" field="lastHeartbeatAt" activeField={agentSortField} direction={agentSortDirection} onSort={sortAgents}/></div>{pagedAgents.map((agent) => <div className="resolution-agent-row table-row" key={agent.id}><span><i className={`worker-beacon ${agent.state.toLowerCase()}`}/><span><strong>{agent.name}</strong><small>{agent.version}</small></span></span><span>{agent.model}</span><span><b className={`status-pill ${agent.state === "Online" ? "completed" : "draft"}`}>{agent.state}</b></span><span>{time(agent.lastHeartbeatAt)}</span></div>)}{!pagedAgents.length ? <div className="compact-empty"><Bot size={18}/><span><strong>No matching resolution agents</strong><small>Start the agent or change the filters.</small></span></div> : null}</div><TablePagination page={Math.min(agentPage, agentPageCount)} pageCount={agentPageCount} onPage={setAgentPage}/></section>
    </div>
  </>;
}
