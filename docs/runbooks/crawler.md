# Crawler runbook

## Health check

```bash
npm run crawler:doctor
```

The command must report Scrapling, Chromium, Neon, and the selected artifact mode.

## Start a worker

```bash
npm run crawler:worker
```

For a bounded batch:

```bash
npm run crawler:drain -- --max-jobs 25
```

AnimeCons discovery can enqueue event-detail and official-site follow-on runs. Keep the continuous worker running until the dashboard has no queued/running jobs, or choose a `--max-jobs` value large enough for the configured page budget. The source policy controls `discover_linked_events` and `follow_official_sites`; the latter must only be enabled when the review explicitly covers bounded first-party follow-on crawling.

If AnimeCons returns `BLOCKED_ACCESS_CONTROL`, do not attempt to bypass its verification. Add the discovered/known official website as a reviewed Website Source and run it directly; official-site enrichment, R2 evidence, media, and retrieval remain fully available.

## Dynamic schedule is missing

The Website connector now performs an HTTP probe and automatically escalates incomplete AUTO requests to the browser runtime. Inspect the persisted RawDocument metadata for `quality_signals.dynamic_escalation`, `fetch_mode: DYNAMIC`, and `captured_xhr`.

If the browser-rendered DOM still lacks records:

1. inspect the captured JSON RawDocuments (`connector_key=captured_xhr`);
2. confirm the schedule link was classified as `SCHEDULE` or `PROGRAMMING`;
3. add a reusable platform-level capture pattern or wait selector to the Source configuration;
4. add a platform adapter only when the site requires interaction or a non-generic JSON shape.

Do not add a convention-specific selector as the first response. Existing runs cannot acquire missing network responses retroactively, so a crawler capture change requires a new crawl. Evidence preparation/resolution changes do not require a recrawl.

## Repeat crawl completes after only the seed URL

Check the run's `pages_unchanged`, `pages_scheduled`, and `documents_created` counters. A previous worker version stopped at an unchanged seed page without scheduling its discovered links, leaving a completed run with `0 fetched / 1 unchanged` and no current-run evidence. Restart the crawler worker after updating it, then start one fresh run from Sources. The worker now re-extracts unchanged pages, queues their child URLs for the new run, and gives the new run its own evidence rows while reusing the existing raw object in storage. Previously completed runs are not repaired retroactively.

```sql
SELECT id,status,pages_scheduled,pages_fetched,pages_unchanged,documents_created
FROM ingestion.crawl_run
WHERE id='<crawl-run-uuid>';
```

If a fresh run still schedules only one page, inspect the Source's `max_pages_per_run`, `max_depth`, and allowed paths, then inspect the seed RawDocument's discovered links and their decisions. A page budget of 1 intentionally prevents child jobs.

## Source will not enqueue

Check the registry row:

```sql
SELECT id,name,enabled,terms_review_status,allowed_domains,allowed_path_prefixes,
       denied_path_prefixes,default_fetch_mode,allow_stealth
FROM ingestion.source
WHERE id='<source-uuid>';
```

The source must be enabled and `terms_review_status` must be `REVIEWED_ALLOWED`. Do not change those values until the site policy has actually been reviewed.

## Job is retrying

```sql
SELECT id,status,attempt_count,max_attempts,not_before,
       last_error_class,last_error_message_redacted
FROM ingestion.job
WHERE id='<job-uuid>';
```

Retry delay is exponential and capped at 15 minutes. A job becomes `DEAD` after the attempt budget. Inspect the related `ingestion.fetch_attempt` and `ingestion.crawl_run` before creating a new job.

If an older worker reports `could not determine data type of parameter $6` while persisting a Website document, stop and restart the worker so it loads the candidate-insert UUID cast fix. The exhausted job is already `DEAD`; use the Console run Retry action (which creates a fresh crawl run) after the restart rather than waiting for that job to lease again.

If a browser job reports `re.PatternError: global flags not at the start of the expression`, update and restart the crawler worker. The XHR capture pattern was being wrapped around a leading `(?i)` flag, which caused repeated Playwright response and route errors. The corrected worker scopes inline flags before combining patterns and validates the final expression before opening Chromium. An interrupted `RUNNING` job becomes leasable after its lease expires (120 seconds by default); check Crawl Jobs before starting another run. If the job has become `DEAD`, retry that run from the Console.

## Replay extraction

```bash
workers/crawler/.venv/bin/crawler replay <raw-document-uuid>
```

Replay reads the stored body and does not contact the source.

## Resolution started before the crawl finished

Migration `0008_resolution_after_crawl_quiescence.sql` makes aggregate resolution depend only on crawler-job quiescence and checks that no URL/media work remains. Per-document `DOCUMENT_EXTRACTION` candidates are internal evidence and are hidden from the default review queue; editors review only `EVENT_RESOLUTION` candidates.

After restarting the updated Resolution Agent, re-resolve a completed run without crawling again:

```bash
curl -X POST http://localhost:3009/api/crawler/runs/<crawl-run-id>/resolve
```

Candidate queue now shows the latest resolution status, source name, and document count. A successful later aggregate supersedes pending page-level and older aggregate Candidates from the same run.

Crawler execution is monitored at `/crawl-jobs`. LLM/knowledge and deterministic aggregate work is monitored separately at `/resolution-jobs`; resolution-agent heartbeats do not appear as crawler workers.

For a pending Candidate labelled `Deterministic fallback` or `Deterministic only`, use **Re-run with LLM** in the Candidate editor. This creates an `LLM_REQUIRED` resolution job over the stored crawl run and does not fetch the website again. If the Knowledge Service, snapshot, or Ollama model is unavailable, this retry fails visibly in Resolution Jobs instead of silently returning another deterministic Candidate.

## Graceful shutdown

Press Ctrl+C once. The worker stops leasing new work. An expired lease becomes available to another worker.
