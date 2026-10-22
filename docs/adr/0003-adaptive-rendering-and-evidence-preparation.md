# ADR 0003: Adaptive rendering and deterministic evidence preparation

Status: accepted and implemented
Date: 2026-10-08

## Context

Convention sites commonly ship an HTML shell and render schedules, exhibitors, or guests through JavaScript and XHR/GraphQL. A source-by-source selector catalog does not scale. Sending all raw pages directly to a model also wastes context on duplicate navigation, media variants, and repeated records.

## Decision

Use two model-independent stages before resolution.

1. The crawler starts with an HTTP probe. It scores generic signals: embedded event-platform markers, empty application roots/custom elements, semantic schedule/exhibitor URLs, and the absence of expected structured records. An AUTO request above the threshold is re-fetched with Scrapling's browser runtime, `NETWORK_IDLE`, optional provider selector, and bounded XHR capture. Explicit HTTP policy is respected.
2. `@kita/evidence-pipeline` prepares the complete crawl-run evidence. It groups duplicates and creates provenance-preserving indexes. The raw artifacts stay immutable and remain available for audits and Codex.

Known platforms such as Aloompa, Sched, Eventeny, and Whova contribute detection/wait hints, not convention-specific parsing. Captured JSON is processed by a generic nested-record extractor; explicit adapters may be added only when a platform's data shape cannot be recovered safely.

## Consequences

- Dynamic browser cost is paid only when an HTTP response appears incomplete.
- Schedule and exhibitor data rendered client-side becomes first-class RawDocuments/assertions.
- Codex and the local agent share the same deterministic preparation semantics.
- The model sees less repeated context, but no raw evidence is destroyed.
- Sites that require interaction beyond load/network idle may still need a reusable platform adapter.

## Guardrails

- captured XHR is limited to 64 artifacts and 25 MiB per page by default;
- normal response/run budgets and domain policy still apply;
- browser escalation is disabled by an explicit HTTP hint or `adaptive_dynamic: false`;
- captured JSON creates records only on a compatible page type and only when minimum identity/time/location shape checks pass;
- credentials remain in the crawler/control-plane environment, never in exported bundles.
