# KitaCon

KitaCon is an anime and Japanese pop-culture event intelligence platform with a dense operator Console, a customer discovery view, a policy-first web crawler, and Neon Postgres as the durable source of truth.

## What is implemented

| Area | Status |
| --- | --- |
| Operator Console (`/`) | Database-backed events, media, sources, jobs, totals, settings, and editable event workspaces |
| Customer discovery (`/discover`) | Database-backed `serving.event_listing` query |
| Neon Postgres | Connected to project `sweet-resonance-98374848` in organization `org-mute-snow-95755930` |
| Schema and sample data | Migrations `0001`–`0003` applied to `production/neondb` |
| Mock-data controls | Records tagged `MOCK`; database switch can exclude them from customer queries |
| Crawler | Python worker with adaptive HTTP-to-Dynamic rendering, bounded XHR capture, and policy-gated Stealth mode |
| Crawler queue | Durable PostgreSQL leasing with retries and `FOR UPDATE SKIP LOCKED` |
| Dashboard crawler controls | Add/review sources, enqueue crawls, and poll live worker/run/job progress |
| Evidence and media | Immutable RawDocuments, structural chunks/FTS, source graph, separate raw/media R2 adapters, and signed retrieval |
| Evidence Pipeline | Shared TypeScript run-level deduplication, collection merge, provenance/conflicts, and lossless Bundle v2 indexes |
| Resolution Agent | Standalone worker that consumes prepared evidence, builds a deterministic baseline, and submits one Event Candidate per official-site crawl |
| Anime Knowledge Service | Standalone Bangumi snapshot/import, bounded Ollama prompts, search, filename/event-resolution API, and read-only local Codex MCP |
| Console authentication | Standards-based OIDC login (initially thristram-auth) with KitaCon-owned permission groups and audited Owner grants |

The Console uses the compact visual system from the supplied references: a 224px sidebar, 54px toolbar, 32px controls, 6-8px radii, Geist-like system typography, fine borders, and one purple accent.

## Requirements

- Node.js 22.13 or newer
- npm
- Python 3.12 through 3.14
- A linked Neon project
- Docker only if you want to run the crawler container

Semantic resolution uses these optional standalone packages:

- [Anime Knowledge Service](packages/anime-knowledge-service/README.md)
- [Evidence Pipeline](packages/evidence-pipeline/README.md)
- [Resolution Agent](packages/resolution-agent/README.md)

For the Codex event-resolution A/B test, the Knowledge Service also provides a [read-only Bangumi MCP adapter](packages/anime-knowledge-service/docs/mcp.md). It exposes subject/person lookup without invoking the local model.

## First-time setup

Install the web application and crawler:

```bash
npm install
python3 -m venv workers/crawler/.venv
workers/crawler/.venv/bin/pip install --requirement workers/crawler/requirements.lock
workers/crawler/.venv/bin/pip install --no-deps --editable workers/crawler
workers/crawler/.venv/bin/python -m playwright install chromium
```

Copy `.env.example` to `.env.local` and add the linked database credentials and OIDC settings. Keep local object storage only for development. See the [Console auth runbook](docs/runbooks/console-auth.md) before applying the access migration or bootstrapping the first Owner:

```dotenv
# Pooled URL for the web application
DATABASE_URL=postgresql://...-pooler.../neondb

# Direct URL for migrations and the long-running crawler worker
DATABASE_URL_UNPOOLED=postgresql://.../neondb

NEON_BRANCH=production

CRAWLER_ARTIFACT_MODE=local
CRAWLER_ARTIFACT_ROOT=var/crawler/artifacts

KITA_AUTH_ISSUER=<issuer from OIDC discovery>
KITA_AUTH_CLIENT_ID=<registered client ID>
KITA_AUTH_CLIENT_SECRET=<registered client secret>
KITA_APP_URL=http://localhost:3009
KITA_SESSION_SECRET=<random 32+ character string>
```

Do not commit `.env.local`. Apply every checked-in migration and start the site:

```bash
npm run db:migrate
npm run dev
```

Routes:

- `http://localhost:3009/` - operator Console
- `http://localhost:3009/sign-in` - OIDC sign-in for the operator Console
- `http://localhost:3009/settings/access` - Owner-only permission-group grants
- `http://localhost:3009/events/<event-uuid>` - canonical event editor
- `http://localhost:3009/events/new` - create a manual Event draft backed by an existing crawler Source
- `http://localhost:3009/discover` - customer discovery
- `http://localhost:3009/discover/events/<event-uuid>` - customer-style operator preview
- `http://localhost:3009/api/health/db` - authenticated Neon health check

Event cards carry their canonical Neon UUID into the event editor. **Save changes** updates `event.event` and the primary `event.event_text` summary; **Publish/Unpublish** synchronizes `serving.event_listing`; and **Fandom Links** writes `event.event_entity` relationships. The customer discovery list only includes serving rows whose status is `PUBLISHED`.

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
infra/sql/0003_crawler_evidence_graph.sql
infra/sql/0004_object_write_reconciliation.sql
infra/sql/0005_resolution_agent.sql
infra/sql/0006_resolution_job_scope.sql
infra/sql/0007_event_content_graph.sql
infra/sql/0008_resolution_after_crawl_quiescence.sql
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

The crawler lives in `workers/crawler`, keeps Scrapling behind KitaCon-owned fetch contracts, and follows a raw-first pipeline:

```text
reviewed source policy
  -> PostgreSQL crawl_run + job
  -> Scrapling HTTP probe
  -> completeness/client-rendering detection
  -> optional Dynamic browser + rendered DOM + bounded XHR/GraphQL capture
  -> policy-gated Stealth fetch
  -> immutable raw bytes in R2 raw/media buckets
  -> RawDocument metadata + structural chunks in Neon
  -> JSON-LD, OpenGraph, PDF/text, link graph, and media extraction
  -> assertions + source/media/editorial candidates
  -> pinned-safe internal cover resolution
```

Important behavior:

- Sources are denied by default until enabled and marked `REVIEWED_ALLOWED`.
- Fetches are GET-only, domain/path allowlisted, and reject credentials, unusual ports, and private/link-local IPs.
- HTTP is the default. AUTO requests escalate to Chromium when a semantic content page is incomplete or looks client-rendered. Explicit HTTP policy does not escalate. Stealth mode must be explicitly allowed by source policy.
- CAPTCHA solving is disabled.
- Raw bodies are stored before extraction so a document can be replayed without another network request.
- An unchanged URL/content hash writes a fetch attempt but does not create another RawDocument version.
- AnimeCons listing and event-detail pages use the deterministic `animecons` connector. The seed page may fan out to bounded event-detail jobs, but child detail pages do not recursively enqueue sibling events; each event is linked to a live canonical event record and its official URL becomes a Website Source.
- **Follow every discovered official website** is an explicit AnimeCons source-policy option. When selected during review, the approval is inherited by discovered first-party sites and each receives its own bounded deep crawl. When cleared, official sites remain pending for separate review.
- Official-site discovery is bounded by depth, page, byte, and runtime budgets and records accepted, deferred, ignored, review-required, and blocked links.
- HTML, JSON/XHR, text, and PDF content is chunked and indexed in Postgres for bounded event-scoped retrieval.
- Qualifying media is downloaded, hashed, deduplicated, stored in the media bucket, and assigned without overriding pinned defaults.
- Job leasing is atomic and safe for multiple workers.
- Failures use exponential retry delay and end in `DEAD` after the attempt budget.

### Review and enable a source

The three sample source records are deliberately disabled and have an unknown terms review. The normal workflow is now in the Console:

1. Open **Sources** and choose **Add source**.
2. Choose **Official website** or **AnimeCons event**, then enter a public HTTP(S) event-detail or listing seed URL. The source is stored in Neon immediately.
3. For AnimeCons, choose whether to discover linked event pages and whether reviewed approval should extend to each discovered official website.
4. Review the seed and intended official-site follow-on scope, including applicable `robots.txt` and terms. Add a review note and enable the source only when authorized.
5. Choose **Run now**, or open **Crawl Jobs**, select the source, and choose **Start crawl**.

New sources are denied by default. Approval updates `terms_review_status`, records the review note and reviewer identity, and enables the source. If you need to perform the same operation administratively, use:

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

The **Crawl Jobs** page is database-backed and refreshes every 2.5 seconds. It shows:

- worker registrations and whether their heartbeat is fresh;
- crawl-run page counts and progress;
- queued, leased, running, retrying, and failed jobs;
- the worker currently holding each lease.
- an **Inspect** view for run metrics, the discovered URL graph, RawDocuments, media candidates, follow-on source candidates, raw download, and retry.

Each event editor also has a **Crawler** tab. It shows attached sources, the most recent run, documents, graph edges, downloaded media, errors, and signed download links. If an event has an official URL but no source, **Create official source** attaches a disabled source so its policy can be reviewed before **Run crawl** becomes available.

### Review extracted event candidates

The **Candidates** page is the editorial bridge between crawler extraction and canonical Events. The queue contains aggregate `EVENT_RESOLUTION` records, not one Event per crawled page. Opening a Candidate renders the same Overview, Schedule, Exhibitors, Related Fandoms, and Updates information architecture as the public Event mock. Sections are view-first and use pencil actions for typed editing; provenance stays in a separate human-readable evidence drawer.

- **Create Review Event** creates a non-public `REVIEW` event and carries forward source/evidence provenance;
- **Link Existing Event** attaches the evidence without overwriting that event's canonical fields;
- **Reject candidate** closes the queue item while retaining all raw evidence.

Candidate edits are validated as Event Content Bundle v2 and saved under a versioned `review.draftBundle`; the original model result remains immutable. Materialization uses the saved draft. Candidate actions are idempotent and website crawls do not silently publish Events. A deterministic Candidate can be re-run with `LLM_REQUIRED` using the same evidence without crawling again. **Export raw bundle** creates a lossless Candidate Evidence Bundle v2: all scoped raw documents remain present, while `prepared/` provides deduplicated collections, provenance and conflicts so Codex does not reread redundant pages; **Import JSON** validates the returned complete bundle and saves it as a new review revision. `/events/new` starts the same editor from an existing Source and optionally accepts a complete JSON bundle immediately. Event, session, exhibitor, and update editors use the event-scoped media picker to select crawler assets without copying URLs by hand. See the [Candidate Editor and Resolution Jobs spec](docs/specs/candidate-editor-and-resolution-jobs.md), [Codex Event Resolution A/B spec](docs/specs/codex-event-resolution-ab-test.md), [ready-to-use Codex prompt](docs/prompts/codex-event-resolution.md), the [adaptive rendering/evidence ADR](docs/adr/0003-adaptive-rendering-and-evidence-preparation.md), and the detailed API contract in [`docs/crawler/README.md`](docs/crawler/README.md#313-candidate-review-apis).

### Resolution Agent

Completed crawler runs now enqueue one `EVENT_RESOLUTION` job. The standalone TypeScript worker in [`packages/resolution-agent`](packages/resolution-agent/README.md) leases that job through a scoped internal API, uses [`packages/evidence-pipeline`](packages/evidence-pipeline/README.md) to prepare a lossless provenance view, builds one deterministic baseline, then ranks model evidence under the configured 15k ceiling and dynamically reserves room before calling [`packages/anime-knowledge-service`](packages/anime-knowledge-service/README.md). Knowledge Service performs one schema-constrained enrichment call inside the 24k complete-prompt budget and merges the bounded patch back into the full deterministic bundle. The Agent creates one event-level review Candidate; it does not receive database, R2, Bangumi, Ollama, or model-file credentials and does not publish Events. `/crawl-jobs` manages crawler work only; `/resolution-jobs` manages model/knowledge work, agents, metrics, warnings, and failures.

```bash
npm run agent:build
npm run agent:test
npm run agent:dev
```

The package includes its requirements, architecture/ADR, setup, API/input/output contracts, KB rules, Docker instructions, and operations guide. Configure the same 32-character-or-longer secret as `RESOLUTION_AGENT_TOKEN` on the main site and `KITACON_AGENT_TOKEN` in the Agent.

**Start crawl** creates a `crawl_run` plus a durable `job` in Neon. It does not launch a process inside the browser or web host. If no worker is online, the job remains queued and will be leased when a worker connects.

For local development, enqueue and process one source immediately:

```bash
workers/crawler/.venv/bin/crawler run-source <source-uuid> --drain
```

For the canonical Fan Expo Canada flow, add this as an **AnimeCons event** source:

```text
https://animecons.com/events/info/26503/fan-expo-canada-2026
```

Enable **Discover linked AnimeCons events** to follow other event-detail links found on the seed page. Enable **Follow every discovered official website** to create, approve, and queue a separate deep official-site crawl for every discovered event. The worker then processes the chain:

```text
AnimeCons seed/listing -> AnimeCons event detail -> canonical event + official Website Source
  -> official homepage -> guests/schedule/programming/exhibitors/tickets/maps/news/media
```

The official spider defaults to depth 3 and remains capped by each source's maximum pages, bytes, runtime, and per-domain request limits. A single `--drain` only processes one leased job; use the continuous worker or a larger bounded drain to finish the complete fan-out.

If the worker reports `MAX_PAGES_REACHED`, it has reached the source's safety limit; it is not a fetch or database failure. New runs reserve their run-wide page slots before jobs are inserted, defer excess discovered URLs in the source graph, and close any queued overflow in one operation. Increase **Maximum pages per run** in the source policy before starting a new run only when the broader crawl is intentional. Rebuild/restart a local Docker worker after updating crawler code, because an existing container continues to use its old image.

AnimeCons may return a Cloudflare security-verification `403` from datacenter or automated browser networks. The worker records this as `BLOCKED_ACCESS_CONTROL`; it does not solve CAPTCHAs or bypass the challenge. In that case, create the known first-party URL as an **Official website** source (for this example, `https://fanexpohq.com/fanexpocanada/`) and run the downstream deep crawl directly. The raw-evidence and official-site pipeline does not depend on AnimeCons remaining reachable.

Process a bounded backlog, replay evidence, or inspect without persistence:

```bash
workers/crawler/.venv/bin/crawler drain --max-jobs 25
workers/crawler/.venv/bin/crawler replay <raw-document-uuid>
workers/crawler/.venv/bin/crawler inspect https://example.com/events/example --no-persist
```

`inspect` permits the requested public hostname for that diagnostic run. Use it only for sites you are authorized to inspect.

### Crawler artifacts

Local mode is for development and tests only. It stores raw and media artifacts under separate subdirectories of `var/crawler/artifacts`:

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
R2_MEDIA_BUCKET=kitacon-media
```

`R2_ENDPOINT` is accepted as an alias for the spec's environment-variable name.

Create both buckets before starting the production worker. Give the API token object read/write/delete access to only those buckets. The same R2 variables are required on the web/API deployment so it can issue bounded signed GET URLs; no application path lists either bucket.

`npm run crawler:doctor` validates Scrapling, Chromium, Neon, and performs an actual temporary write/head/read/signed-URL/delete round trip against **both** configured stores. In `r2` mode it fails startup validation if either bucket or credential set is unusable.

If a worker stops after object upload but before the Neon transaction commits, the deterministic key and `ingestion.object_write_intent` make the write recoverable without bucket enumeration. Reconcile only old, targeted intents with:

```bash
workers/crawler/.venv/bin/crawler reconcile-storage --older-than-minutes 30 --limit 100
```

That command is a read-only dry run. After reviewing its counts, add `--apply` to mark repaired intents and delete only terminal, unreferenced objects addressed by those intents.

### Docker

```bash
docker build -f docker/crawler.Dockerfile -t kitacon-crawler .
docker run --env-file .env.local kitacon-crawler doctor
docker run --env-file .env.local kitacon-crawler worker
```

## Production hosting

Use two deployments connected to the same Neon database:

```text
browser -> web app/API -> Neon <- always-on crawler worker
          signed GET   -> R2 raw + media buckets
```

- **Web app:** this checkout is currently built for the existing OpenAI Sites project (`vinext` + Cloudflare-compatible output). Set `DATABASE_URL` to the pooled Neon connection string there. If Vercel is your required target, migrate the frontend build to a standard Next.js deployment first; this repository is not a drop-in Vercel build today.
- **Crawler:** deploy `docker/crawler.Dockerfile` as an always-on **Render Background Worker**. Set `DATABASE_URL_UNPOOLED` to the direct connection string for the same Neon branch and configure the R2 variables above.
- **Artifacts:** use R2 in production. A worker host's local filesystem is not durable across replacements and deploys.

Do not run the continuous `crawler worker` command as a Vercel Function. Functions are request-scoped and have a maximum duration; the crawler is a persistent queue consumer with heartbeats. Vercel Services are also request-oriented and currently a private-beta product, so they are not the default deployment target for this worker.

### Deploy the crawler on Render

The checked-in `render.yaml` is a Blueprint for the crawler worker:

1. Push this repository to your Git provider.
2. In Render, create a new Blueprint and select the repository.
3. Render finds the `kitacon-crawler` background worker and builds `docker/crawler.Dockerfile`.
4. Enter the secret values requested by the Blueprint: `DATABASE_URL_UNPOOLED`, `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. The Blueprint supplies `R2_RAW_BUCKET=kitacon-raw` and `R2_MEDIA_BUCKET=kitacon-media`.
5. Deploy. Within about ten seconds of startup, **Crawl Jobs -> Worker heartbeats** should show `kitacon-render-crawler` as **Online**.

To operate without a Blueprint, create a Docker Background Worker manually with the same Dockerfile and environment variables. The image already starts `crawler worker`; no separate start command is needed.

Whichever web host you use, it and Render must point to the same Neon branch. The web API only enqueues and reads state; the Render worker leases and processes it. This means **Start crawl** continues to work even while the worker is restarting—the job remains in PostgreSQL.

## Packages

Web UI and data:

- React 19, Vinext, Vite, and Tailwind CSS 4
- shadcn/ui with the unified `radix-ui` package
- Lucide React icons
- TanStack Table
- React Hook Form and Zod
- next-themes and Sonner
- Drizzle ORM and `@neondatabase/serverless`
- AWS SDK S3 client and presigner for private R2 downloads

Crawler:

- Scrapling `0.4.15`
- Playwright and Patchright browser runtimes through Scrapling fetchers
- Psycopg 3 for the durable worker queue
- Pydantic models and Typer/Rich CLI
- Boto3 for S3-compatible R2 storage
- Pillow for dimensions and perceptual hashes
- pypdf for native PDF text extraction
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
render.yaml                  Render background-worker deployment Blueprint
infra/sql/                   Versioned PostgreSQL migrations and mock seed
workers/crawler/             Python crawler, connectors, CLI, and tests
packages/                    Shared auth, contracts, and domain code
packages/resolution-agent/   KitaCon event-resolution job worker
packages/anime-knowledge-service/ Reusable Bangumi + local-model domain service
docs/                        Architecture notes
```
