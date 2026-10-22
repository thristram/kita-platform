"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Database, FileJson, LoaderCircle, Upload } from "lucide-react";
import type { ConsoleSource } from "@/db/console";

const eventNameFromJson = (value: string): string => {
  if (!value.trim()) return "";
  try {
    const parsed = JSON.parse(value) as { event?: { name?: unknown } };
    return typeof parsed.event?.name === "string" ? parsed.event.name.trim() : "";
  } catch {
    return "";
  }
};

async function createDraft(input: { sourceId: string; name: string; bundle?: unknown }): Promise<{ candidateId: string }> {
  const response = await fetch("/api/candidates/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({})) as { candidateId?: string; error?: string };
  if (!response.ok || !body.candidateId) throw new Error(body.error || "Could not create manual event draft");
  return { candidateId: body.candidateId };
}

export function ManualEventWorkspace({ sources, notify }: { sources: ConsoleSource[]; notify: (message: string) => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sourceId, setSourceId] = useState(sources[0]?.id || "");
  const [name, setName] = useState(sources[0] ? `${sources[0].name} event` : "");
  const [json, setJson] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => sources.find((source) => source.id === sourceId), [sourceId, sources]);
  const jsonEventName = useMemo(() => eventNameFromJson(json), [json]);
  const effectiveName = name.trim() || jsonEventName || (selected ? `${selected.name} event` : "");

  const changeSource = (nextSourceId: string) => {
    const previousSuggestion = selected ? `${selected.name} event` : "";
    const nextSource = sources.find((source) => source.id === nextSourceId);
    setSourceId(nextSourceId);
    setName((current) => !current.trim() || current === previousSuggestion ? nextSource ? `${nextSource.name} event` : "" : current);
  };

  const loadJson = (value: string, nextFilename = "") => {
    const importedName = eventNameFromJson(value);
    setJson(value);
    setFilename(nextFilename);
    if (importedName) setName(importedName);
  };

  const submit = async () => {
    if (!sourceId || !effectiveName) return notify("Choose a source and enter an event name");
    setBusy(true);
    try {
      const bundle = json.trim() ? JSON.parse(json) as unknown : undefined;
      const result = await createDraft({ sourceId, name: effectiveName, ...(bundle === undefined ? {} : { bundle }) });
      router.push(`/candidates/${result.candidateId}/overview`);
    } catch (error) {
      notify(error instanceof SyntaxError ? "Imported file is not valid JSON" : error instanceof Error ? error.message : "Could not create event draft");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <div className="page-head"><div><p className="eyebrow">Editorial creation</p><h1>Create event</h1><p>Start from an existing crawler source, then edit the complete event in the Candidate-style staged editor.</p></div></div>
    <section className="manual-event-layout">
      <div className="manual-event-form panel">
        <div className="panel-head"><div><h2>Source-backed draft</h2><p>The selected source supplies evidence, media, provenance, and future crawl updates.</p></div><Database size={20}/></div>
        <label><span>Existing source</span><select value={sourceId} onChange={(event) => changeSource(event.target.value)}><option value="">Choose a source…</option>{sources.map((source) => <option value={source.id} key={source.id}>{source.name} · {source.status}</option>)}</select></label>
        <label><span>Event name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={selected ? `${selected.name} event` : "Event name"}/></label>
        <div className="manual-source-summary"><span className={`worker-beacon ${selected?.enabled ? "online" : "offline"}`}/><span><b>{selected?.name || "No source selected"}</b><small>{selected ? `${selected.baseUrl} · ${selected.items} stored items` : "Select a source that already has a completed crawl."}</small></span></div>
        <button className="primary-button manual-continue" disabled={busy || !sourceId || !effectiveName} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={15}/> : <ArrowRight size={15}/>} Continue to full editor</button>
      </div>
      <div className="manual-json-panel panel">
        <div className="panel-head"><div><h2>Optional Codex JSON</h2><p>Import a complete Event Content Bundle now, or do it later from the Candidate editor.</p></div><FileJson size={20}/></div>
        <input ref={fileRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void file.text().then((value) => loadJson(value, file.name)); }}/>
        <button className="manual-file-button" onClick={() => fileRef.current?.click()}><Upload size={15}/><span><b>{filename || "Choose JSON file"}</b><small>event-content-bundle/v2</small></span></button>
        <label><span>Or paste JSON</span><textarea rows={14} value={json} onChange={(event) => loadJson(event.target.value)} placeholder={'{\n  "schemaVersion": "event-content-bundle/v2",\n  ...\n}'}/></label>
        <p>The API validates the full schema and rejects unknown source-document IDs before anything is saved.</p>
      </div>
    </section>
  </>;
}
