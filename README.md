# KitaCon

KitaCon is an anime and Japanese pop-culture event intelligence platform with a dense operator Console, a customer discovery view, a policy-first web crawler, and Neon Postgres as the durable source of truth.

## What is implemented

| Area | Status |
| --- | --- |
| Operator Console (`/`) | Database-backed events, media, sources, jobs, totals, and settings |
| Customer discovery (`/discover`) | Database-backed `serving.event_listing` query |
| Neon Postgres | Connected to project `sweet-resonance-98374848` in organization `org-mute-snow-95755930` |
| Schema and sample data | Migrations `0001` and `0002` applied to `production/neondb` |
| Mock-data controls | Records tagged `MOCK`; database switch can exclude them from customer queries |
| Crawler | Python worker with Scrapling HTTP, Dynamic, and policy-gated Stealth modes |
| Crawler queue | Durable PostgreSQL leasing with retries and `FOR UPDATE SKIP LOCKED` |
| Raw evidence | Local artifact storage by default, S3-compatible R2 storage when configured |

The Console uses the compact visual system from the supplied references: a 224px sidebar, 54px toolbar, 32px controls, 6-8px radii, Geist-like system typography, fine borders, and one purple accent.

## Requirements

- Node.js 22.13 or newer
- npm
- Python 3.12 through 3.14
- A linked Neon project
- Docker only if you want to run the crawler container

## First-time setup

Install the web application and crawler:

```bash
npm install
python3 -m venv workers/crawler/.venv
workers/crawler/.venv/bin/pip install --requirement workers/crawler/requirements.lock
workers/crawler/.venv/bin/pip install --no-deps --editable workers/crawler
workers/crawler/.venv/bin/python -m playwright install chromium
```

Create `.env.local` with the linked database credentials:

```dotenv
# Pooled URL for the web application
DATABASE_URL=postgresql://...-pooler.../neondb

# Direct URL for migrations and the long-running crawler worker
DATABASE_URL_UNPOOLED=postgresql://.../neondb

NEON_BRANCH=production
```

Do not commit `.env.local`. Apply every checked-in migration and start the site:

```bash
npm run db:migrate
PORT=3001 npm run dev
```

Routes:

- `http://localhost:3001/` - operator Console
- `http://localhost:3001/discover` - customer discovery
- `http://localhost:3001/api/health/db` - live Neon health check

## Neon database

The configured environment is:

- Organization: `Li` (`org-mute-snow-95755930`)
- Project: `KitaCon` (`sweet-resonance-98374848`)
- Branch: `production`
- Database: `neondb`
- Region: `aws-us-east-2`

To link a fresh checkout to the existing project:

```bash
neon auth
neon link
neon env pull
```

Select organization **Li**, project **KitaCon**, and branch **production** when prompted.

### Creating a database for a manual deployment

1. Create or choose a Neon project. Neon creates the default `neondb` database for a new project.
2. Put the pooled and direct connection strings in the deployment secret manager.
3. Run `npm run db:migrate` once from a trusted build or administration environment.
4. Deploy the web app with `DATABASE_URL` available at runtime.
5. Deploy the crawler separately with `DATABASE_URL_UNPOOLED` and artifact-storage variables.

The migration files are the deployment database scripts. Do not manually create the tables in the Neon console.

```text
infra/sql/0001_kita_foundation.sql
infra/sql/0002_crawler_and_mock_data.sql
```

Drizzle records applied migrations in `drizzle.__drizzle_migrations`, so rerunning the command applies only pending migrations.

## Mock data and customer visibility

Migration `0002_crawler_and_mock_data.sql` writes sample records directly to Neon. Each seeded event, entity, venue, source, media asset, and serving projection has `data_origin = 'MOCK'`. The Console displays a Mock label on these records.

The runtime setting is stored in `system.runtime_setting` under `consumer_show_mock_data`.

Use **Console -> Settings -> General -> Show mock data** to change it. When disabled:

- operator records remain stored and visible;
- customer queries exclude `serving.event_listing.data_origin = 'MOCK'`;
- no records are deleted.

The same control is available at `GET/POST /api/settings/mock-data`.

## Crawler architecture

The crawler lives in `workers/crawler` and follows a raw-first pipeline:

```text
reviewed source policy
  -> PostgreSQL crawl_run + job
  -> Scrapling HTTP fetch
  -> optional Dynamic browser fetch
  -> policy-gated Stealth fetch
  -> raw document in local/R2 storage
  -> JSON-LD, OpenGraph, link, and media extraction
  -> assertions + media candidates + editorial candidate
```

Important behavior:

- Sources are denied by default until enabled and marked `REVIEWED_ALLOWED`.
- Fetches are GET-only, domain/path allowlisted, and reject credentials, unusual ports, and private/link-local IPs.
- HTTP is the default. Dynamic mode runs Chromium. Stealth mode must be explicitly allowed by source policy.
- CAPTCHA solving is disabled.
- Raw bodies are stored before extraction so a document can be replayed without another network request.
- Job leasing is atomic and safe for multiple workers.
- Failures use exponential retry delay and end in `DEAD` after the attempt budget.

### Review and enable a source

The three sample source records are deliberately disabled and have an unknown terms review. Review the site's robots rules and terms, then update only the approved source in Neon:

```sql
UPDATE ingestion.source
SET enabled = true,
    terms_review_status = 'REVIEWED_ALLOWED',
    terms_reviewed_at = now(),
    terms_review_note = 'Reviewed by <name> on <date>'
WHERE id = '<source-uuid>';
```

Find the source IDs in the Console or query:

```sql
SELECT id, name, enabled, terms_review_status
FROM ingestion.source
ORDER BY name;
```

### Run the crawler

Check all local dependencies and Neon connectivity:

```bash
npm run crawler:doctor
```

Start a continuous worker:

```bash
npm run crawler:worker
```

In a second terminal, enqueue an approved source:

```bash
workers/crawler/.venv/bin/crawler run-source <source-uuid>
```

You can also use **Sources -> Run now** in the Console. The button is disabled until the source policy is approved.

For local development, enqueue and process one source immediately:

```bash
workers/crawler/.venv/bin/crawler run-source <source-uuid> --drain
```

Process a bounded backlog, replay evidence, or inspect without persistence:

```bash
workers/crawler/.venv/bin/crawler drain --max-jobs 25
workers/crawler/.venv/bin/crawler replay <raw-document-uuid>
workers/crawler/.venv/bin/crawler inspect https://example.com/events/example --no-persist
```

`inspect` permits the requested public hostname for that diagnostic run. Use it only for sites you are authorized to inspect.

### Crawler artifacts

Local mode is the default and stores raw artifacts under `var/crawler/artifacts`:

```dotenv
CRAWLER_ARTIFACT_MODE=local
CRAWLER_ARTIFACT_ROOT=var/crawler/artifacts
CRAWLER_WORKER_NAME=kita-local-crawler
CRAWLER_USER_AGENT=KitaConCrawler/0.1 (+https://kitacon.app/crawler-policy)
```

For S3-compatible Cloudflare R2 storage:

```dotenv
CRAWLER_ARTIFACT_MODE=r2
R2_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_RAW_BUCKET=kitacon-raw
```

The current Sites hosting manifest has no R2 binding, so production crawler artifacts remain local until these R2 credentials and bucket are provisioned for the worker.

### Docker

```bash
docker build -f docker/crawler.Dockerfile -t kitacon-crawler .
docker run --env-file .env.local kitacon-crawler doctor
docker run --env-file .env.local kitacon-crawler worker
```

## Packages

Web UI and data:

- React 19, Vinext, Vite, and Tailwind CSS 4
- shadcn/ui with the unified `radix-ui` package
- Lucide React icons
- TanStack Table
- React Hook Form and Zod
- next-themes and Sonner
- Drizzle ORM and `@neondatabase/serverless`

Crawler:

- Scrapling `0.4.15`
- Playwright and Patchright browser runtimes through Scrapling fetchers
- Psycopg 3 for the durable worker queue
- Pydantic models and Typer/Rich CLI
- Boto3 for S3-compatible R2 storage
- Pytest and pytest-asyncio

Exact Python versions are locked in `workers/crawler/requirements.lock`.

## Validation commands

```bash
npm run lint
npx tsc --noEmit
npm test
workers/crawler/.venv/bin/pytest workers/crawler/tests
npm run crawler:doctor
```

## Repository map

```text
app/                         Console, customer UI, and API routes
components/ui/               shadcn/Radix components
db/                          Neon client and database queries
docker/crawler.Dockerfile    Standalone crawler image
infra/sql/                   Versioned PostgreSQL migrations and mock seed
workers/crawler/             Python crawler, connectors, CLI, and tests
packages/                    Shared auth, contracts, and domain code
docs/                        Architecture notes
```
