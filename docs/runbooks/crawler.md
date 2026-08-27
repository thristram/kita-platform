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

## Replay extraction

```bash
workers/crawler/.venv/bin/crawler replay <raw-document-uuid>
```

Replay reads the stored body and does not contact the source.

## Graceful shutdown

Press Ctrl+C once. The worker stops leasing new work. An expired lease becomes available to another worker.
