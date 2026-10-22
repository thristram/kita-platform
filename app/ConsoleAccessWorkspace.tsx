"use client";

import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Search } from "lucide-react";

type Group = { key: string; name: string; description: string; permissions: string[] };
type Principal = { id: string; email: string | null; status: string; last_seen_at: string | null; groups: string[] };

export function ConsoleAccessWorkspace({ currentPrincipalId }: { currentPrincipalId: string }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [principals, setPrincipals] = useState<Principal[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    const response = await fetch("/api/access", { cache: "no-store" });
    const body = await response.json() as { error?: string; groups: Group[]; principals: Principal[] };
    if (!response.ok) throw new Error(body.error ?? "Could not load access grants");
    setGroups(body.groups);
    setPrincipals(body.principals);
  }

  useEffect(() => {
    let active = true;
    fetch("/api/access", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { error?: string; groups: Group[]; principals: Principal[] };
        if (!response.ok) throw new Error(body.error ?? "Could not load access grants");
        return body;
      })
      .then((body) => { if (active) { setGroups(body.groups); setPrincipals(body.principals); } })
      .catch((failure) => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, []);
  const visible = useMemo(() => principals.filter((principal) => !query || `${principal.email ?? ""} ${principal.id}`.toLowerCase().includes(query.toLowerCase())), [principals, query]);

  async function toggle(principal: Principal, group: Group) {
    const enabled = !principal.groups.includes(group.key);
    const requestId = `${principal.id}:${group.key}`;
    setBusy(requestId); setError("");
    try {
      const response = await fetch("/api/access/grants", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: principal.id, groupKey: group.key, enabled }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update permission group");
      await load();
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(""); }
  }

  return <><div className="page-head"><div><p className="eyebrow">Security</p><h1>Access control</h1><p>Grant KitaCon permission groups to identities that have signed in at least once.</p></div></div>
    <section className="panel access-panel"><div className="panel-head"><div><h2>Permission groups</h2><p>Identity-provider roles do not grant Console access.</p></div><ShieldCheck size={20}/></div>
      <div className="access-groups">{groups.map((group) => <article key={group.key}><strong>{group.name}</strong><p>{group.description}</p><small>{group.permissions.join(" · ")}</small></article>)}</div>
    </section>
    <section className="panel access-panel"><div className="panel-head"><div><h2>People</h2><p>New accounts appear here after their first successful OIDC sign-in.</p></div></div>
      <label className="access-search"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email or principal ID" aria-label="Search Console users"/></label>
      {error ? <p role="alert" className="access-error">{error}</p> : null}
      <div className="access-users">{visible.map((principal) => <article key={principal.id} className="access-user"><div><strong>{principal.email ?? "No email"}</strong><small>{principal.status} · {principal.id === currentPrincipalId ? "You" : principal.id}</small></div><div className="access-grants">{groups.map((group) => <label key={group.key}><input type="checkbox" checked={principal.groups.includes(group.key)} disabled={Boolean(busy)} onChange={() => void toggle(principal, group)}/>{group.name}</label>)}</div></article>)}</div>
      {!visible.length ? <p className="access-empty">No matching signed-in identities.</p> : null}
    </section></>;
}
