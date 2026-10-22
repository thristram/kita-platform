# KitaCon Crawler 技术说明

本文档说明 `workers/crawler` 的安装、启动、架构、数据存储以及 HTTP API。内容以当前仓库代码为准，适用于本地开发、Docker 运行和生产部署。

> 重要边界：Crawler worker 是常驻的后台队列消费者，不是 HTTP Server，不监听端口。本文第 3 节列出的 HTTP API 由 Web 应用的 `app/api/crawler/**` 提供；Web API 和 worker 通过同一个 Neon PostgreSQL 数据库协作。

待执行的安全架构迁移任务见 [`PENDING-control-plane-migration.md`](./PENDING-control-plane-migration.md)。该任务会在未来把 worker 的 Neon/R2 长期凭据替换为受控的内部 API 和短期 presigned object URLs；当前尚未执行。

## 1. Setup

### 1.1 代码位置

| 内容 | 路径 |
| --- | --- |
| Crawler Python 包 | `workers/crawler/` |
| Worker 入口和 CLI | `workers/crawler/src/kita_crawler/cli.py` |
| 抓取引擎 | `workers/crawler/src/kita_crawler/engine.py` |
| 业务编排 | `workers/crawler/src/kita_crawler/service.py` |
| 数据库访问/队列租约 | `workers/crawler/src/kita_crawler/repository.py` |
| Website / AnimeCons connectors | `workers/crawler/src/kita_crawler/connectors/` |
| Dynamic-content assessment | `workers/crawler/src/kita_crawler/dynamic_content.py` |
| Captured JSON record extraction | `workers/crawler/src/kita_crawler/structured_json.py` |
| Dockerfile | `docker/crawler.Dockerfile` |
| Web API | `app/api/crawler/` |
| 数据库 migrations | `infra/sql/` |

所有命令如果没有特别说明，都从仓库根目录执行。

### 1.2 Dependencies

#### 系统依赖

| Dependency | 版本/要求 | 用途 | 是否必须 |
| --- | --- | --- | --- |
| Python | `>=3.12,<3.15` | 运行 crawler worker | 是 |
| pip / venv | 与 Python 配套 | 创建隔离环境、安装依赖 | Standalone 模式必需 |
| Chromium | 由 Playwright 安装 | `DYNAMIC` 和 `STEALTH` 抓取 | 是，`doctor` 也会检查 |
| PostgreSQL / Neon | 可从 worker 主机访问 | source registry、持久化队列、运行状态、提取结果 | 是 |
| Node.js | 22.13+ | 执行 migrations 和启动 Web/API | 仅 worker 且数据库已迁移时可不安装 |
| npm | 与 Node.js 配套 | 安装 Web 依赖、运行 migrations 和 npm scripts | 同上 |
| Docker | 支持 Dockerfile 的现代版本 | 容器方式运行 | 仅 Docker 模式必需 |
| Cloudflare R2 | 两个 S3-compatible buckets | 生产环境保存 raw/media artifacts | 生产必需；本地可使用文件系统 |

Docker 镜像使用 `python:3.13.14-slim`，并在构建时通过 Playwright 安装 Chromium 及其 Linux 系统库。

#### Python 直接依赖

实际精确版本锁定在 `workers/crawler/requirements.lock`。主要直接依赖如下：

| Package | 当前版本 | 用途 |
| --- | --- | --- |
| `scrapling[fetchers]` | 0.4.15 | HTTP、动态浏览器和策略允许的 stealth fetch |
| `playwright` / `patchright` | lockfile 固定 | Chromium 浏览器运行时 |
| `psycopg[binary]` | 3.3.4 | PostgreSQL 队列、状态和结果读写 |
| `pydantic` | 2.13.4 | 严格请求、策略和提取模型 |
| `typer` | 0.27.1 | `crawler` CLI |
| `rich` | 14.3.4 | CLI 输出 |
| `boto3` | 1.43.81 | R2/S3-compatible object storage |
| `pillow` | 12.1.1 | 图片尺寸、格式和 hash 分析 |
| `pypdf` | 6.7.1 | PDF 文本抽取 |
| `python-dotenv` | 1.2.3 | 从当前工作目录加载 `.env.local` |
| `pytest` / `pytest-asyncio` | 9.1.1 / 1.4.0 | 测试 |

### 1.3 环境变量

Worker 启动时会读取进程环境，并尝试加载当前工作目录下的 `.env.local`。从仓库根目录运行时，使用根目录的 `.env.local` 即可。

#### 必需变量

| 变量 | 使用方 | 说明 |
| --- | --- | --- |
| `DATABASE_URL_UNPOOLED` | worker、migration | 推荐使用 Neon direct/unpooled connection；worker 优先读取它 |
| `DATABASE_URL` | Web API；worker fallback | Web/API 使用的数据库 URL；worker 在没有 unpooled URL 时回退到它 |
| `CRAWLER_ARTIFACT_MODE` | worker | `local` 或 `r2`；未设置时，如果 R2 endpoint/key/secret 都存在则自动选择 `r2`，否则选择 `local` |

#### Local artifact 模式

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST-pooler/DB?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://USER:PASSWORD@HOST/DB?sslmode=require

CRAWLER_ARTIFACT_MODE=local
CRAWLER_ARTIFACT_ROOT=var/crawler/artifacts
CRAWLER_WORKER_NAME=kita-local-crawler
CRAWLER_USER_AGENT=KitaConCrawler/0.1 (+https://kitacon.app/crawler-policy)
```

Local 模式分别写入：

```text
var/crawler/artifacts/raw/
var/crawler/artifacts/media/
```

Local 模式只适合开发和测试。Web API 的 artifact download routes 使用 R2 signer，因此 local artifact 不会通过这些 HTTP download routes 提供下载。

#### R2 artifact 模式

```dotenv
DATABASE_URL_UNPOOLED=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
CRAWLER_ARTIFACT_MODE=r2
CRAWLER_WORKER_NAME=kitacon-production-crawler
CRAWLER_USER_AGENT=KitaConCrawler/0.1 (+https://kitacon.app/crawler-policy)

R2_ENDPOINT_URL=https://ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=replace-me
R2_SECRET_ACCESS_KEY=replace-me
R2_RAW_BUCKET=kitacon-raw
R2_MEDIA_BUCKET=kitacon-media
```

`R2_ENDPOINT` 也可作为 `R2_ENDPOINT_URL` 的 alias。两个 bucket 必须提前创建。Worker token 需要对这两个 bucket 有 read/write/delete 权限；Web/API deployment 至少需要可以生成和使用 private object 的 signed GET。

#### 可选变量及默认值

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CRAWLER_ARTIFACT_ROOT` | `var/crawler/artifacts`；Docker image 中为 `/var/lib/kitacon-crawler` | Local artifact 根目录 |
| `CRAWLER_WORKER_NAME` | `kita-local-crawler` | Worker 注册名；数据库中有唯一约束 |
| `CRAWLER_WORKER_VERSION` | `0.1.0` | 写入 worker metadata 和 crawl-run snapshot |
| `CRAWLER_USER_AGENT` | `KitaConCrawler/0.1 (+https://kitacon.app/crawler-policy)` | 对外 fetch 的 User-Agent |
| `CRAWLER_ALLOW_PRIVATE_NETWORK` | `false` | 是否允许 private、loopback、link-local 等地址；正常部署应保持 `false` |
| `CRAWLER_DEFAULT_MAX_DEPTH` | `3` | 当前会被载入 settings；实际 run limit 以 `ingestion.source.max_depth` 为准 |
| `CRAWLER_DEFAULT_MAX_PAGES` | `100` | 当前会被载入 settings；实际 run limit 以 source policy 为准 |
| `CRAWLER_DEFAULT_CONCURRENCY` | `4` | 当前会被载入 settings；当前 worker loop 实际每次租用一个 job |
| `CRAWLER_DEFAULT_TIMEOUT_SECONDS` | `30` | 当前会被载入 settings；connector 生成的 `FetchPlan.timeout_seconds` 当前默认也是 30 秒 |

不要把 `.env.local` 提交到 Git。

### 1.4 首次初始化数据库

Crawler 依赖完整的 KitaCon schema，而不仅是 crawler 自己的几张表。新数据库需要依次应用仓库内全部 migrations：

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

推荐从仓库根目录执行：

```bash
npm install
npm run db:migrate
```

迁移使用 `DATABASE_URL_UNPOOLED`，如果没有则回退到 `DATABASE_URL`。Drizzle 会在 `drizzle.__drizzle_migrations` 记录已应用的 migration。`0007_event_content_graph.sql` 增加 schedule、exhibitors、guests、updates、activities、related subjects、ticket offers 和 sourced facts 的规范化表；字段映射见 [`../event-content-population.md`](../event-content-population.md)。

### 1.5 Docker build 和启动

#### Build image

Build context 必须是仓库根目录，因为 Dockerfile 会复制 `workers/crawler`：

```bash
docker build -f docker/crawler.Dockerfile -t kitacon-crawler:local .
```

镜像构建过程会：

1. 安装 `requirements.lock` 中的固定依赖；
2. 安装 Chromium 和所需 Linux libraries；
3. 安装 `kitacon-crawler` Python package；
4. 创建非 root 用户 `crawler`，UID 为 `10001`；
5. 设置 entrypoint 为 `crawler`，默认 command 为 `worker`。

#### 启动前健康检查

```bash
docker run --rm \
  --env-file .env.local \
  kitacon-crawler:local doctor
```

`doctor` 会验证：

- Scrapling import；
- Chromium executable；
- PostgreSQL/Neon connectivity；
- raw 和 media 两个 object store 的临时 write/head/read/signed-URL/delete round trip。

任何一项失败，进程 exit code 为 `1`。

#### Local artifact 模式启动

容器内 local storage 默认位于 `/var/lib/kitacon-crawler`。使用 bind mount 才能在容器重建后保留 artifacts：

```bash
mkdir -p var/crawler-docker

docker run -d \
  --name kitacon-crawler \
  --restart unless-stopped \
  --env-file .env.local \
  -v "$PWD/var/crawler-docker:/var/lib/kitacon-crawler" \
  kitacon-crawler:local worker
```

如果 `.env.local` 显式设置了相对的 `CRAWLER_ARTIFACT_ROOT=var/crawler/artifacts`，它会相对容器的 `/app` 解析，并绕过上面的 mount。Docker local 模式建议删除该变量，或明确设置：

```dotenv
CRAWLER_ARTIFACT_ROOT=/var/lib/kitacon-crawler
```

#### R2 模式启动

R2 模式不需要 artifact volume：

```bash
docker run -d \
  --name kitacon-crawler \
  --restart unless-stopped \
  --env-file .env.local \
  kitacon-crawler:local worker
```

Crawler 不开放 HTTP 端口，因此不需要 `-p`。

#### 运行管理

```bash
# 查看日志
docker logs -f kitacon-crawler

# 查看容器状态
docker ps --filter name=kitacon-crawler

# 停止
docker stop kitacon-crawler

# 删除已停止的容器；local artifact 是否保留取决于是否使用了 mount
docker rm kitacon-crawler
```

更新 crawler 代码后必须重新 build image 并重建容器；已运行的容器不会自动读取 host 上的新代码。

### 1.6 Standalone 启动

#### 安装

```bash
python3 -m venv workers/crawler/.venv
workers/crawler/.venv/bin/pip install --requirement workers/crawler/requirements.lock
workers/crawler/.venv/bin/pip install --no-deps --editable workers/crawler
workers/crawler/.venv/bin/python -m playwright install chromium
```

`--editable` 适合本地开发：修改 `workers/crawler/src` 后不需要重新安装 package。`--no-deps` 是安全的，因为前一步已从 lockfile 安装所有依赖。

Linux host 如果 Chromium 缺少系统 library，可使用：

```bash
workers/crawler/.venv/bin/python -m playwright install --with-deps chromium
```

该命令可能需要操作系统 package-manager 权限。

#### 验证

```bash
npm run crawler:doctor
```

等价于：

```bash
workers/crawler/.venv/bin/crawler doctor
```

#### 启动常驻 worker

```bash
npm run crawler:worker
```

或直接运行：

```bash
workers/crawler/.venv/bin/crawler worker
```

默认无任务时每 2 秒 poll 一次。可调整到 0.25–30 秒：

```bash
workers/crawler/.venv/bin/crawler worker --poll-seconds 5
```

按一次 `Ctrl+C` 停止继续租用任务。Worker 当前没有为正在执行的 job 延长 lease；默认 lease 为 120 秒，因此部署时应避免强制并行重复处理长任务，并依赖确定性 key/数据库约束完成幂等保护。

### 1.7 动态/客户端渲染页面

Website connector 默认使用 adaptive rendering，不需要为每个漫展手写规则：

```text
HTTP probe
  -> 检查页面语义、预期结构化记录、JS shell/custom element、嵌入平台
  -> 完整：保存 HTTP 结果
  -> 不完整：DYNAMIC + NETWORK_IDLE + bounded XHR capture
  -> 保存 rendered HTML 与 captured JSON
  -> 从 DOM/JSON 提取 schedule、exhibitor 等 records
```

目前识别 Aloompa、Sched、Eventeny、Whova 的平台级标记，同时也识别通用 React/Next/Nuxt/Angular 空壳和 schedule/program/exhibitor 等语义 URL。平台标记仅提供升级和等待提示；记录提取仍使用通用 JSON/DOM 结构。抓取的 XHR 默认最多 64 个、合计 25 MiB，仍受 source/run 总预算约束。

Source `configuration` 可设置：

```json
{
  "adaptive_dynamic": true,
  "render_selector": "optional reusable platform selector",
  "capture_xhr_patterns": ["graphql", "schedule", "sessions"]
}
```

请求显式指定 `fetch_mode_hint=HTTP` 或 source 配置 `adaptive_dynamic=false` 时不会自动升级。只有确实需要交互（点击日期、同意弹窗、滚动加载）的站点才应增加可复用的“平台 adapter”，不要增加漫展专用 connector。

#### 创建并批准 source

正常方式是通过 Console 或第 3 节的 API 创建并 review source。Crawler 只会处理：

- `enabled = true`；并且
- `terms_review_status = 'REVIEWED_ALLOWED'`

的 source。

Source policy 还控制 allowed domains/path、最大 depth/pages/bytes/runtime、fetch mode 和 stealth permission。

#### Enqueue 和处理

```bash
# 只创建 crawl_run 和首个 job
workers/crawler/.venv/bin/crawler run-source <source-uuid>

# 创建并立即处理一个 leased job
workers/crawler/.venv/bin/crawler run-source <source-uuid> --drain

# 处理最多 25 个 backlog jobs，然后退出
workers/crawler/.venv/bin/crawler drain --max-jobs 25
```

一次 `--drain` 只处理一个 job。一个 seed 可能发现更多页面并 enqueue child jobs，因此完成完整站点 crawl 应使用常驻 worker，或显式执行足够大的 bounded drain。

#### 其他 CLI

| 命令 | 行为 | 是否写数据库/存储 |
| --- | --- | --- |
| `crawler doctor` | 检查 package、Chromium、DB 和两个 object stores | 会创建并删除两个临时对象 |
| `crawler worker` | 持续 heartbeat、lease 和处理 jobs | 是 |
| `crawler drain --max-jobs N` | 最多处理 N 个 jobs 后退出 | 是 |
| `crawler run-source UUID` | 为已批准 source enqueue run/job | 是 |
| `crawler replay RAW_DOCUMENT_UUID` | 从 object store 读取已有 raw body 并重新 extraction，不访问原站 | 当前返回 extraction 统计；不会重新抓取 |
| `crawler inspect URL --no-persist` | 对授权的 public URL 做一次诊断 fetch/extraction | 不持久化 |
| `crawler reconcile-storage` | 审计旧的 pending object write intents | 默认 dry-run |
| `crawler reconcile-storage --apply` | 标记已恢复 intent，并删除 terminal、unreferenced 的精确对象 | 是，可能删除指定的孤儿对象 |

### 1.7 测试和检查

```bash
workers/crawler/.venv/bin/pytest workers/crawler/tests
npm run lint
npx tsc --noEmit
npm run crawler:doctor
```

`doctor` 会访问真实 DB 和 object store，不是纯 unit test。

## 2. Architecture

### 2.1 Block diagram

```mermaid
flowchart LR
    Operator[Operator / Browser]
    Web[Web Console + app/api/crawler]
    DB[(Neon PostgreSQL)]
    Worker[Crawler Worker\nTyper + Service + Repository]
    Policy[Source Policy\nallowlist + budgets]
    Connector[Connectors\nwebsite / animecons]
    Fetch[Scrapling Fetch Engine\nHTTP / Dynamic / Stealth]
    Internet[Approved Public Websites]
    Raw[(R2 Raw Bucket\nor local raw/)]
    Media[(R2 Media Bucket\nor local media/)]
    Signer[R2 Signed URL Service]

    Operator -->|create/review/run/status| Web
    Web -->|pooled SQL: enqueue + query| DB
    DB -->|lease job + policy| Worker
    Worker --> Policy
    Policy --> Connector
    Connector -->|FetchPlan + extraction contract| Fetch
    Fetch -->|GET only| Internet
    Internet -->|HTML/PDF/JSON/image| Fetch
    Worker -->|raw evidence| Raw
    Worker -->|qualified media| Media
    Worker -->|attempts, documents, chunks, graph, assertions, status| DB
    Web --> Signer
    Signer -->|302 signed GET| Raw
    Signer -->|302 signed GET| Media
```

### 2.2 组件职责

#### Web Console / API

- 创建 source；
- 记录 policy review 和 reviewer identity；
- enqueue `crawl_run` 和首个 `job`；
- 查询 worker heartbeat、run progress、job state 和 evidence；
- 为 R2 object 生成最长 15 分钟的 signed GET URL；
- 不在 HTTP request 内执行 crawl。

Web 端通过 `DATABASE_URL` 使用 Neon pooled connection。

#### Crawler CLI / Worker loop

- 使用 worker name 注册或更新 `ingestion.worker`；
- 每轮写 heartbeat；
- 从 PostgreSQL 原子 lease 一个可执行 job；
- 执行 fetch、extraction、discovery、media download 和持久化；
- 成功后更新 job/run/source sync state；
- 失败后进入指数退避，或在 terminal condition 下进入 `DEAD`。

Worker 优先使用 `DATABASE_URL_UNPOOLED`，通过 Psycopg 直接连接。

#### Repository / durable queue

Queue 存在 PostgreSQL 的 `ingestion.job` 中。Lease 查询使用 `FOR UPDATE SKIP LOCKED`，所以多个 worker 可安全竞争不同 job。默认 lease 时间为 120 秒。

Job 主要状态：

```mermaid
stateDiagram-v2
    [*] --> QUEUED
    QUEUED --> RUNNING: worker lease
    RETRY_WAIT --> RUNNING: not_before reached + lease
    RUNNING --> SUCCEEDED: persist completed
    RUNNING --> RETRY_WAIT: retryable error
    RUNNING --> DEAD: permanent error or attempts exhausted
```

默认 `max_attempts` 为 4。失败延迟为 `min(900, 2^attempt_count * 2)` 秒。`HTTP_404`、`HTTP_410`、`KeyError` 和 `ValueError` 被视为 permanent failure。

#### Connectors

当前内置两个 connector：

- `website`：解析普通官方站点的 JSON-LD、OpenGraph、链接、页面类型、文本 chunks 和 media candidates；
- `animecons`：确定性解析 AnimeCons listing/event detail，并可发现 event detail 和 official-site follow-on source。

Connector 接口只有三个动作：

1. `seed_requests(policy)`：生成 seed crawl request；
2. `select_fetch_plan(request, policy)`：选择 HTTP、DYNAMIC 或 STEALTH；
3. `extract(document, policy)`：返回 assertions、links、chunks、media 和 warnings。

#### Fetch engine

Fetch engine 使用 Scrapling：

- `HTTP`：普通 HTTP fetch，默认模式；
- `DYNAMIC`：使用 headless Chromium；
- `STEALTH`：只有 `source.allow_stealth = true` 才允许；
- Cloudflare/CAPTCHA solving 被明确关闭。

所有请求默认必须为 GET。URL 会 canonicalize，并检查：

- 仅允许 HTTP/HTTPS；
- 禁止 URL 内嵌 username/password；
- public-network 模式下仅允许 80/443；
- hostname 必须在 source allowlist；
- path 必须满足 allowed/denied prefix；
- DNS 结果不能是 private、loopback、link-local、multicast、reserved 或 unspecified 地址；
- response 不能超过剩余 run byte budget。

如果返回页面包含 CAPTCHA、安全验证或 access-denied 特征，结果会标记为 `BLOCKED_ACCESS_CONTROL`，不会尝试绕过。

#### Artifact stores

- Raw HTML、PDF、JSON/XHR、text 等写 raw store；
- 下载并通过检查的 image 写 media store；
- 每个 object 以 SHA-256 做内容识别；
- media 还会记录尺寸和 perceptual hash；
- 相同 URL + content hash 不创建新的 RawDocument version；
- 相同 media SHA-256 会复用已有 `media.asset`。

上传前创建 `ingestion.object_write_intent`，数据库持久化成功后将 intent 标记为 `COMMITTED`。如果进程在 object upload 与 DB commit 之间退出，可用 `reconcile-storage` 精确恢复或清理，而不需要枚举整个 bucket。

### 2.3 一次 crawl 如何与其他 components 交互

```mermaid
sequenceDiagram
    participant U as Operator
    participant A as Web API
    participant P as Neon PostgreSQL
    participant W as Crawler Worker
    participant S as Source Website
    participant O as Raw/Media Store

    U->>A: POST /api/crawler/sources/:id/run
    A->>P: INSERT crawl_run + URL_FETCH job
    A-->>U: 202 {runId, jobId}
    loop worker poll
        W->>P: heartbeat + lease with SKIP LOCKED
    end
    P-->>W: job payload + source_id
    W->>P: load reviewed source policy
    W->>S: policy-validated GET
    S-->>W: HTML/PDF/JSON/image
    W->>W: hash + extract + discover + classify
    W->>P: register object_write_intent
    W->>O: put immutable bytes
    W->>P: transactionally persist attempt/document/chunks/links/assertions/jobs
    W->>P: mark object intent COMMITTED + job SUCCEEDED
    U->>A: GET status/run/event evidence
    A->>P: query current state
    A-->>U: JSON
```

关键解耦点：

- Web API enqueue 后立即返回 `202`，不等待 crawl 完成；
- Worker 重启期间 job 仍保存在 PostgreSQL；
- Web API 与 worker 必须连接同一个 Neon database/branch；
- Web app 不调用 worker 的网络地址，worker 也不 callback Web app；
- UI 当前通过 `/api/crawler/status` 周期性读取进度；
- R2 signed download 由 Web API 生成，不暴露 bucket list API。

### 2.4 Source、Job 和结果写回的边界

#### Crawler 是否管理 source？

答案是：**source 的人工管理属于 Web/API 控制面；worker 读取并执行 source policy，但在 discovery workflow 中也会自动创建受控的 follow-on source。**

| 动作 | 负责组件 | 实现方式 |
| --- | --- | --- |
| 人工创建 source | Web API / Console | `POST /api/crawler/sources` 写 `ingestion.source` |
| Review、enable、disable、调整 limits | Web API / Console | `PATCH /api/crawler/sources/{id}` 更新 `ingestion.source` |
| 手动开始 run | Web API / Console，或 crawler CLI | API/CLI 直接向 Neon 写 `crawl_run` + `job` |
| 读取和执行 policy | Crawler worker | 用 job 的 `source_id` 直接查询 `ingestion.source` |
| 发现 official site | Connector + worker repository | 写 `discovered_url`、`source_candidate`，必要时创建 `OFFICIAL_WEBSITE` source |
| 自动批准发现的 official site | Worker repository | 只有父 AnimeCons source 显式设置 `follow_official_sites=true` 时才继承批准 |
| 抓取 source website | Crawler worker | 读取 job 后向经过 allowlist 验证的公网 URL 发 GET |

因此：

- Worker **不会**去 source website “拿 jobs”；source website 只提供被抓取的 HTML/PDF/JSON/image 内容。
- Worker **不会**调用 KitaCon Website API 获取 source policy；它直接查询 Neon。
- Source 是持久化的 registry/config，不是每个 job 都完整复制一份 source。Job 只保存 `source_id`，worker 每次执行时读取当前 source；同时 run 中保存一份 `policy_snapshot` 供预算和审计使用。
- Worker 的自动 source 创建不是通用 CRUD。它只发生在已抓取页面发现 `OFFICIAL_SITE` 时，并受父 source 的明确 approval scope 控制。

#### Worker 调用哪个 API 获取 job？

**没有这样的 API。当前实现不使用 HTTP job-pull endpoint。** Worker 用 Psycopg 直接连接 `DATABASE_URL_UNPOOLED` 指向的 Neon database，并执行数据库 lease。

执行顺序为：

1. `register_worker()`：在 `ingestion.worker` insert/update worker name、capabilities、version 和 heartbeat；
2. `heartbeat()`：每个 drain loop 更新 `last_heartbeat_at`；
3. `lease_job()`：在 transaction 中选择一个到期的 `QUEUED`/`RETRY_WAIT` job；
4. 使用 `FOR UPDATE SKIP LOCKED` 避免多个 workers 拿到同一个可用 job；
5. 把该 job 更新为 `RUNNING`、写 `lease_owner`、设置 120 秒 `lease_expires_at` 并增加 `attempt_count`；
6. SQL `RETURNING j.*` 把完整 job row 作为 Python dictionary 返回给 service。

等价的核心 SQL contract 是：

```sql
WITH next_job AS (
  SELECT id
  FROM ingestion.job
  WHERE status IN ('QUEUED', 'RETRY_WAIT')
    AND COALESCE(not_before, available_at) <= now()
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
  ORDER BY CASE priority
             WHEN 'REALTIME' THEN 0
             WHEN 'HIGH' THEN 1
             WHEN 'NORMAL' THEN 2
             ELSE 3
           END,
           created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE ingestion.job AS j
SET status = 'RUNNING',
    lease_owner = :worker_name,
    lease_expires_at = now() + interval '120 seconds',
    attempt_count = attempt_count + 1
FROM next_job
WHERE j.id = next_job.id
RETURNING j.*;
```

这是内部数据库 contract，不是 HTTP response。典型 lease result 如下：

```json
{
  "id": "job-uuid",
  "job_type": "URL_FETCH",
  "required_capability": "INGESTION",
  "status": "RUNNING",
  "priority": "NORMAL",
  "dedupe_key": "source-run:... or crawl:...",
  "payload": {},
  "source_id": "source-uuid",
  "crawl_run_id": "run-uuid",
  "raw_document_id": null,
  "attempt_count": 1,
  "max_attempts": 4,
  "available_at": "database timestamp",
  "not_before": "database timestamp",
  "lease_owner": "kita-local-crawler",
  "lease_expires_at": "database timestamp",
  "created_at": "database timestamp",
  "started_at": "database timestamp",
  "completed_at": null,
  "finished_at": null,
  "last_error": null,
  "last_error_class": null,
  "last_error_code": null,
  "last_error_message_redacted": null
}
```

Psycopg 会把 PostgreSQL `jsonb` 的 `payload` 解码为 Python dictionary。当前正常 crawl workflow 实际产生两类 jobs：`URL_FETCH` 和 `MEDIA_FETCH`。Lease query 还允许其他 ingestion job type，但当前 `CrawlerService.process_job()` 只有 `MEDIA_FETCH` 专用分支，其他类型都会按 `CrawlRequest` 处理，因此不能把任意 payload 的其他 job type 直接交给此 worker。

`GET /api/crawler/status` 只是给 UI/operator 查看 worker/run/job 状态，worker 不调用它，也不能用它 lease job。

#### `URL_FETCH` job payload

`URL_FETCH.payload` 遵循严格的 `CrawlRequest` model；未知字段会被拒绝。完整结构如下：

```json
{
  "request_id": "uuid",
  "source_id": "source-uuid",
  "url": "https://example.com/events/example",
  "canonical_url": "https://example.com/events/example",
  "page_type": "LISTING",
  "parent_request_id": null,
  "depth": 0,
  "method": "GET",
  "headers": {},
  "body": null,
  "dedupe_key": "stable request hash or source-run key",
  "expected_content_types": ["text/html"],
  "fetch_mode_hint": "AUTO",
  "render_wait": "DOM_CONTENT_LOADED",
  "render_selector": null,
  "capture_xhr_patterns": [],
  "locale_hint": "en-US",
  "not_before": null,
  "priority": "NORMAL",
  "metadata": {
    "auto_approve_official_site": false,
    "discover_linked_events": true
  }
}
```

字段说明：

| Field | 含义 |
| --- | --- |
| `request_id` | 逻辑 fetch request UUID；Connector/CLI 生成时可自动产生 |
| `source_id` | 用于重新读取完整 source policy；应与 job row 的 `source_id` 一致 |
| `url` | 实际请求 URL；fetch 前会重新进行 safety validation |
| `canonical_url` | 去掉 tracking/hash 等后的 canonical URL，用于去重和 graph |
| `page_type` | `LISTING`, `EVENT`, `OVERVIEW`, `SCHEDULE`, `GUESTS`, `MAP`, `OTHER` 等 page hint；PDF 由 `expected_content_types` 表达 |
| `parent_request_id` | 父请求；当前 discovered child 通常仍为 `null`，关系主要通过 RawDocument/URL graph 表达 |
| `depth` | 从 seed 开始的 crawl depth，seed 为 0 |
| `method` | 当前必须是 `GET` |
| `headers` | 额外请求头；敏感 header 在 fetch attempt 中会被 redacted |
| `body` | GET 通常为 `null` |
| `dedupe_key` | Request 级稳定 key；job row 会再加 run scope 形成唯一 dedupe key |
| `expected_content_types` | 期望内容类型，例如 HTML 或 PDF |
| `fetch_mode_hint` | `AUTO`, `HTTP`, `DYNAMIC`, `STEALTH`；最终仍受 connector/source policy 限制 |
| `render_*` | Browser fetch 的 wait condition/selector |
| `capture_xhr_patterns` | Dynamic fetch 时允许捕获的 XHR pattern |
| `locale_hint` | `Accept-Language`/browser locale hint |
| `not_before` | Model 中的时间 hint；实际调度以 job row `not_before` 为准 |
| `priority` | `REALTIME`, `HIGH`, `NORMAL` 等 priority |
| `metadata` | Connector-specific context，例如 AnimeCons follow-on approval 和 external event ID |

Web API 创建 seed job 时会写完整字段。Connector 自动创建 child job 时，Pydantic 会把未显式指定的字段补成 model defaults。Official-site follow-on payload 当前只显式保存核心字段，但读取时也由 Pydantic 补全 defaults。

#### `MEDIA_FETCH` job payload

页面 extraction 发现 media candidate 后，worker 会在同一个 DB transaction 中 enqueue `MEDIA_FETCH`：

```json
{
  "url": "https://example.com/images/hero.jpg",
  "canonical_url": "https://example.com/images/hero.jpg",
  "source_id": "source-uuid",
  "media_candidate_id": "media-candidate-uuid",
  "category": "EVENT_HERO",
  "root_event_id": "event-uuid or null",
  "parent_raw_document_id": "raw-document-uuid"
}
```

Media job 的 `max_attempts` 为 3；普通 URL job 为 4。执行 media job 时会：

- 仅接受 `image/*` response；
- 单个 response cap 为 50 MiB，同时不能超过 run 剩余 byte budget；
- 读取图片尺寸并生成 SHA-256/perceptual hash；
- 按 SHA-256 复用已有 `media.asset`；
- 更新 `media_candidate`，必要时创建 `media.assignment` 并更新 event internal cover。

#### Crawler 完成后是写 DB，还是 POST Website API？

**直接写 DB 和 object store，不会 POST Website API。** 完成一个 job 的数据流是：

```mermaid
flowchart LR
    Job[(Neon job row)] --> Worker[Crawler Worker]
    Worker --> Site[Source Website]
    Site --> Worker
    Worker --> Intent[(object_write_intent PENDING)]
    Worker --> Store[(R2/local object store)]
    Worker --> Result[(Neon result tables)]
    Result --> Done[(job/run status)]
    Done --> Commit[(object_write_intent COMMITTED)]
    API[Web API] -. later reads .-> Result
```

没有 outbound completion HTTP payload。`process_job()` 返回的 Python dictionary 只用于 CLI log/diagnostic，worker loop 不会把它发送出去。

普通 URL 成功时的内部 return value：

```json
{
  "job_id": "uuid",
  "raw_document_id": "uuid",
  "assertions": 5,
  "chunks": 8,
  "media": 3,
  "discoveries": 12
}
```

内容未变化时：

```json
{
  "job_id": "uuid",
  "raw_document_id": "existing-raw-document-uuid",
  "unchanged": true
}
```

Media 成功时：

```json
{
  "job_id": "uuid",
  "raw_document_id": "uuid",
  "asset_id": "uuid"
}
```

这些对象不是公开 API response。外部调用方通过 status/run/evidence API 从 DB 读取最终状态和数据。

#### 成功后直接写入哪些数据？

| 阶段 | 写入位置 | 主要内容 |
| --- | --- | --- |
| Upload 准备 | `ingestion.object_write_intent` | bucket/key/hash/size，状态 `PENDING` |
| Raw bytes | R2 raw bucket 或 local `raw/` | HTML、PDF、text、JSON/XHR |
| Fetch audit | `ingestion.fetch_attempt` | requested/final URL、HTTP status、mode、timing、redacted headers、hash |
| Document metadata | `ingestion.raw_document` | URL、document type、content hash、bucket/key、connector、event/page info |
| Searchable text | `ingestion.document_chunk` | heading、content、offset、full-text index |
| Extracted facts | `ingestion.assertion` | field/value/confidence/evidence locator/excerpt |
| Review payload | `ingestion.candidate` | 完整 ExtractionBatch 和 completeness |
| URL graph | `ingestion.discovered_url` | parent、normalized URL、type、priority、decision |
| Follow-on source | `ingestion.source_candidate`, `ingestion.source`, `ingestion.event_source` | discovered official/social/ticketing source 及 event relationship |
| Child work | `ingestion.job` | discovered URL jobs 和 media jobs |
| Media metadata | `ingestion.media_candidate` | URL、category、classification 和 fetch status |
| Downloaded media | R2 media bucket + `media.asset` | 图片 bytes、hash、dimensions、ownership |
| Event media link | `media.assignment`, `event.event` | role/default/pinned-safe cover 和 enrichment state |
| Run state | `ingestion.crawl_run` | counters、status、finish time、errors、budget stop |
| Source state | `ingestion.source_sync_state` | last fetch/success/change/hash/error |
| Job state | `ingestion.job` | `SUCCEEDED`、timestamps、清除 lease；或 retry/dead error fields |
| Upload commit | `ingestion.object_write_intent` | 关联 RawDocument/Asset，状态 `COMMITTED` |

主要 document/result writes 在数据库 transaction 中完成；object storage 无法与 PostgreSQL 使用同一个分布式 transaction，因此用 `object_write_intent` 做补偿和 reconciliation。

失败时同样不 POST API。Worker 直接把 job 更新为 `RETRY_WAIT` 或 `DEAD`，写入 `last_error_class`、`last_error_message_redacted`，并把 per-job error 合并到 `crawl_run.error_summary`。

### 2.5 Datastore

有两个持久化层。

#### Neon PostgreSQL：控制面和结构化数据

| Schema / table | 用途 |
| --- | --- |
| `ingestion.source` | Source registry、connector、URL、allowlist、policy review、crawl budgets |
| `ingestion.source_sync_state` | 最近 fetch/success/hash/error 和下次调度信息 |
| `ingestion.crawl_run` | 每次 run 的 policy/config snapshot、计数器、状态、budget stop reason |
| `ingestion.job` | 持久化 job queue、lease、attempt、retry 和 error |
| `ingestion.worker` | Worker identity、capabilities 和 heartbeat |
| `ingestion.fetch_attempt` | 每次网络 fetch 的 URL、status、mode、header 摘要、hash 和 timing |
| `ingestion.raw_document` | Raw artifact metadata、版本、R2 key、页面类型和关联 event |
| `ingestion.document_chunk` | HTML/PDF/text 的结构化 chunks 和 PostgreSQL full-text index |
| `ingestion.discovered_url` | URL discovery graph、decision、priority、parent/fetched document |
| `ingestion.assertion` | 带 evidence locator/excerpt 的结构化事实 |
| `ingestion.candidate` | 待后续 review/publish 的抽取 candidate |
| `ingestion.media_candidate` | 发现的 media、分类、下载状态和 artifact location |
| `ingestion.source_candidate` | 发现的 official site 等候选 source |
| `ingestion.event_source` | Event 与 source 的关系 |
| `ingestion.object_write_intent` | Object upload 与 DB commit 间的一致性/reconciliation 记录 |
| `event.event` | Canonical event；crawler 会关联或 enrichment |
| `media.asset` | 已下载、去重后的 media asset |
| `media.assignment` | Media 到 event/entity/venue 的 assignment；pinned/default 受保护 |

PostgreSQL 是 queue 和业务状态的 source of truth。R2 中有 object 但没有 DB reference 时，该 object 不会自动成为可见 evidence。

#### R2 或 local filesystem：二进制 evidence

| Store | 默认 bucket | 内容 |
| --- | --- | --- |
| Raw store | `kita-raw` | HTML、PDF、text、JSON/XHR 和其他 raw documents |
| Media store | `kita-media` | 下载并检查后的 images |

生产环境使用 R2。Local filesystem 没有跨主机共享和 deployment durability，不能用于多实例生产。

### 2.6 Budgets、幂等和一致性

- Run budget 包括最大 depth、pages、bytes 和 runtime；
- 达到 page limit 时，run 写入 `MAX_PAGES_REACHED`，超额 queued jobs 被关闭，discovery 仍保留为 deferred evidence；
- Job dedupe 使用数据库唯一 `dedupe_key`；
- RawDocument ID/object key 基于 job、content hash 和 URL 确定性生成；
- 新 run 抓到与旧 run 相同的页面时，仍会重新抽取并安排该页面发现的 child URLs。本次 run 会建立自己的 RawDocument、assertions、chunks 和 media candidates，供 Resolution Agent 按 run 汇总；相同原始内容复用旧 R2 object，不重复上传。`pages_unchanged` 记录这些页面，run 进度将它们计入已处理页数；
- Source enqueue CLI 支持可选 `idempotency_key`；Web API 每次手动 run 会创建新的 run ID；
- DB queue 支持多个 worker，但单个 worker 当前顺序处理 job；
- Source policy 在创建 run 时 snapshot 到 `crawl_run.policy_snapshot/config_snapshot`，用于审计。

### 2.7 当前实现注意事项

- Route handlers 中没有 crawler-specific authentication/authorization check。若 API 可从公网访问，应在应用或 edge/gateway 层统一加认证和角色授权。
- Worker 没有 HTTP health endpoint。健康度通过进程状态、`doctor` 和 `ingestion.worker.last_heartbeat_at` 判断；Dashboard 把 10 秒内有 heartbeat 的 worker 显示为 Online。
- Web download API 只支持 R2 signer；worker local artifact 模式用于开发，不等于 Web API 可下载 local file。
- `CRAWLER_DEFAULT_*` 环境变量已被 settings 读取，但 source-specific limits 主要来自数据库 policy；调整运行范围应 review 并更新 source。
- `robots_mode`、每分钟请求数和 per-domain concurrency 会被载入 policy model；当前 fetch path 尚未实现独立的 robots.txt parser/rate-limiter 调度器。不要把这些字段的存在当作完整的自动限速保证。
- `PATCH /sources/:id` 如果不传 `maxDepth` 或 `maxPagesPerRun`，当前实现会分别写回 3 和 100，而不是保留旧值。

## 3. API Interface

### 3.1 API 数量和通用约定

当前 Web app 提供 **22 个 crawler / candidate-review / resolution-observability HTTP endpoints**：

| # | Method | Path | 用途 |
| --- | --- | --- | --- |
| 1 | `POST` | `/api/crawler/sources` | 创建 source |
| 2 | `PATCH` | `/api/crawler/sources/{id}` | Review/enable/disable source policy |
| 3 | `POST` | `/api/crawler/sources/{id}/run` | Enqueue crawl |
| 4 | `GET` | `/api/crawler/status` | Dashboard worker/run/job 状态 |
| 5 | `GET` | `/api/crawler/runs/{id}` | Run 详情和 evidence |
| 6 | `POST` | `/api/crawler/runs/{id}/retry` | 基于旧 run 的 source 创建新 run |
| 7 | `GET` | `/api/crawler/raw-documents/{id}` | RawDocument 详情 |
| 8 | `GET` | `/api/crawler/raw-documents/{id}/download` | Raw artifact signed download |
| 9 | `GET` | `/api/crawler/media/{id}/download` | Media asset signed download |
| 10 | `GET` | `/api/crawler/events/{id}/evidence` | Event crawler evidence |
| 11 | `GET` | `/api/crawler/events/{id}/source-graph` | Event source graph 的精简视图 |
| 12 | `GET` | `/api/candidates` | 列出 editorial candidates |
| 13 | `GET` | `/api/candidates/{id}` | Candidate、assertions、chunks、media 和 event draft |
| 14 | `POST` | `/api/candidates/{id}/materialize` | 创建 `REVIEW` event 并绑定 evidence |
| 15 | `POST` | `/api/candidates/{id}/link` | 把 candidate evidence 绑定到已有 event |
| 16 | `POST` | `/api/candidates/{id}/reject` | 拒绝 candidate，但保留 raw evidence |
| 17 | `PUT` | `/api/candidates/{id}/draft` | 保存 schema-validated、versioned Event Content Bundle draft |
| 18 | `POST` | `/api/candidates/{id}/retry-resolution` | 使用同一 crawl run enqueue `LLM_REQUIRED` resolution |
| 19 | `GET` | `/api/resolution/status` | Resolution Agent heartbeat、job、model、token 和 error 状态 |
| 20 | `GET` | `/api/candidates/{id}/export` | 下载 raw documents、structured evidence、schema、prompt 和 original result ZIP |
| 21 | `POST` | `/api/candidates/{id}/import` | 把完整 `event-content-bundle/v2` JSON 保存为 versioned review override |
| 22 | `POST` | `/api/candidates/manual` | 从已有 Source 的最新 completed/partial crawl 创建人工 Event Candidate |

其中两个 event routes 读取同一个 evidence aggregate，但它们是两个独立的可调用 URL，因此总数按 19 计算。Crawler worker 本身开放 0 个 HTTP endpoint；它只提供 CLI，并通过数据库与这些 API 协作。

通用约定：

- Request/response 使用 JSON，download endpoints 除外；
- 所有 `{id}` 都应是 UUID；
- 时间一般输出 ISO-8601 UTC 字符串；
- mutation 成功通常返回 `201` 或 `202`；
- 验证/业务错误通常为 `400`，不存在为 `404`，重复 source 为 `409`；
- 无 version prefix，crawler management base path 为 `/api/crawler`，editorial review base path 为 `/api/candidates`；
- `status`、run detail 和 evidence endpoints 设置 `Cache-Control: no-store`；
- 没有 pagination query。Dashboard 固定最多返回 20 workers、50 runs、100 jobs；event evidence 固定最多返回 20 runs 和 100 documents；document chunks 固定最多 100。

### 3.2 Shared source response

创建和 review source 都返回下面的 `source`：

```json
{
  "source": {
    "id": "uuid",
    "name": "Fan Expo Canada",
    "type": "WEBSITE",
    "trust": "OFFICIAL",
    "status": "Healthy",
    "baseUrl": "https://example.com/event/",
    "lastSuccess": "5m ago",
    "nextRun": "Manual",
    "items": "12",
    "enabled": true,
    "policyStatus": "REVIEWED_ALLOWED",
    "policyNote": "Reviewed by ...",
    "contactIdentity": "operator@example.com",
    "dataOrigin": "LIVE",
    "maxDepth": 3,
    "maxPagesPerRun": 100,
    "connectorKey": "website",
    "followOfficialSites": false,
    "discoverLinkedEvents": true
  }
}
```

`lastSuccess`、`nextRun` 是 human-readable relative strings，不是 timestamps；`items` 当前也是 string。

### 3.3 `POST /api/crawler/sources`

创建 Website 或 AnimeCons source。创建不等于一定启用；`policyApproved=false` 时 source 默认 disabled。

Request body：

| Field | Type | Required | Rules / meaning |
| --- | --- | --- | --- |
| `name` | string | 是 | trim 后 1–160 chars |
| `url` | string | 是 | 最长 2000；必须是 HTTP/HTTPS、无 credentials、port 只能是 80/443 |
| `connectorKey` | `website \| animecons` | 否 | 默认 `website` |
| `trustLevel` | `OFFICIAL \| VERIFIED \| COMMUNITY` | 是 | Source trust |
| `policyApproved` | boolean | 是 | 是否启用并标为 `REVIEWED_ALLOWED` |
| `reviewNote` | string | 是 | 最长 2000；如果 approved，trim 后不能为空 |
| `contactIdentity` | string | 是 | 最长 320；可传空字符串 |
| `rootEventId` | UUID | 否 | 关联已有 canonical event |
| `followOfficialSites` | boolean | 否 | 发现 official site 后是否继承批准并 enqueue deep crawl |
| `discoverLinkedEvents` | boolean | 否 | 默认 `true` |

Example：

```bash
curl -X POST http://localhost:3009/api/crawler/sources \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Fan Expo Canada",
    "url": "https://example.com/event/",
    "connectorKey": "website",
    "trustLevel": "OFFICIAL",
    "policyApproved": false,
    "reviewNote": "",
    "contactIdentity": ""
  }'
```

Success：`201 Created`，body 为 shared source response。

Errors：

- `400 {"error":"..."}`：schema、URL 或 review rule 不合法；
- `409 {"error":"A source with this URL already exists"}`：URL 已存在且未提供 event attachment context。

如果同 URL 已存在且提供 `rootEventId`，API 会把已有 source attach 到 event，并以 `201` 返回已有 source。

### 3.4 `PATCH /api/crawler/sources/{id}`

Review source policy，并启用或禁用 source。

Path：`id` 必须是 source UUID。

Request body：

| Field | Type | Required | Rules / meaning |
| --- | --- | --- | --- |
| `approved` | boolean | 是 | `true` -> enabled + `REVIEWED_ALLOWED`; `false` -> disabled + `REVIEWED_DENIED` |
| `reviewNote` | string | 是 | 最大 2000；approved 时不能为空 |
| `contactIdentity` | string | 是 | 最大 320 |
| `maxDepth` | integer | 否 | 0–8；省略时当前实现写 3 |
| `maxPagesPerRun` | integer | 否 | 1–2000；省略时当前实现写 100 |
| `followOfficialSites` | boolean | 否 | 只在提供时更新 config |
| `discoverLinkedEvents` | boolean | 否 | 只在提供时更新 config |

Success：`200 OK`，body 为 shared source response。

Errors：

- `400`：UUID/schema/review rule 错误；
- `404 {"error":"Source not found"}`。

### 3.5 `POST /api/crawler/sources/{id}/run`

为已批准 source 创建新的 crawl run 和 seed job。无 request body。

前置条件：

- Source 存在；
- `enabled=true`；
- `terms_review_status=REVIEWED_ALLOWED`；
- Source config 或 `base_url` 中有 seed URL。

Success：`202 Accepted`

```json
{
  "runId": "uuid",
  "jobId": "uuid"
}
```

该响应只表示已 enqueue，不表示 crawl 已开始或完成。

Errors：

- `404 {"error":"Source not found"}`；
- `400`：source disabled、terms 未批准、无 seed URL，或数据库 enqueue 失败。

### 3.6 `GET /api/crawler/status`

返回 crawler dashboard 快照。无 input。

Success：`200 OK`

```json
{
  "checkedAt": "2026-10-02T12:00:00.000Z",
  "workers": [
    {
      "id": "uuid",
      "name": "kita-local-crawler",
      "version": "0.1.0",
      "state": "Online",
      "lastHeartbeatAt": "2026-10-02T11:59:58.000Z",
      "heartbeatAge": "2s ago"
    }
  ],
  "runs": [
    {
      "id": "uuid",
      "sourceId": "uuid",
      "sourceName": "Example",
      "status": "Running",
      "progress": 50,
      "pagesScheduled": 4,
      "pagesFetched": 2,
      "pagesFailed": 0,
      "pagesBlocked": 0,
      "assertions": 8,
      "candidates": 1,
      "media": 3,
      "createdAt": "ISO-8601",
      "startedAt": "ISO-8601 or null",
      "finishedAt": null
    }
  ],
  "jobs": [
    {
      "id": "uuid",
      "runId": "uuid or null",
      "sourceId": "uuid or null",
      "sourceName": "Example",
      "type": "Url Fetch",
      "capability": "INGESTION",
      "priority": "NORMAL",
      "status": "Running",
      "worker": "kita-local-crawler",
      "age": "10s ago",
      "attemptCount": 1,
      "maxAttempts": 4,
      "lastError": "",
      "dataOrigin": "LIVE"
    }
  ]
}
```

`Online` 表示 heartbeat 在最近 10 秒内。`progress` 使用 `(fetched + failed + blocked) / scheduled` 计算并 cap 到 100。

Error：`500 {"error":"Could not read crawler status"}`。

### 3.7 `GET /api/crawler/runs/{id}`

返回一个 crawl run 及其 URL graph、documents、media candidates 和 source candidates。

Path：`id` 必须是 crawl-run UUID。

Success：`200 OK`

```json
{
  "run": {
    "id": "uuid",
    "sourceId": "uuid",
    "sourceName": "Example",
    "baseUrl": "https://example.com/",
    "rootEventId": "uuid or null",
    "rootUrl": "https://example.com/",
    "status": "RUNNING",
    "trigger": "MANUAL",
    "scheduledAt": "ISO-8601 or null",
    "startedAt": "ISO-8601 or null",
    "finishedAt": "ISO-8601 or null",
    "pagesScheduled": 10,
    "pagesFetched": 4,
    "pagesUnchanged": 1,
    "pagesFailed": 0,
    "pagesBlocked": 0,
    "documentsCreated": 4,
    "bytesFetched": 123456,
    "mediaDiscovered": 3,
    "logoStatus": "FOUND",
    "configSnapshot": {},
    "errors": {},
    "policySnapshot": {}
  },
  "discoveries": [],
  "documents": [],
  "media": [],
  "sourceCandidates": []
}
```

Array element 主要字段：

- `discoveries`：`id`, `crawl_run_id`, `source_id`, `root_event_id`, `parent_raw_document_id`, `discovered_url`, `normalized_url`, `anchor_text`, `link_kind`, `page_hint`, `priority_score`, `decision`, `decision_reason`, `discovered_at`, `fetched_raw_document_id`, `metadata`；
- `documents`：`id`, `canonical_url`, `document_type`, `page_type`, `title`, `fetched_at`, `content_hash`, `mime_type`, `byte_size`, `processing_status`, `r2_bucket`, `r2_key`；
- `media`：`id`, `resolved_url`, `category`, `classification_score`, `fetch_status`, `r2_bucket`, `r2_key`, `width`, `height`, `mime_type`；
- `sourceCandidates`：`id`, `candidate_type`, `url`, `display_name`, `confidence`, `status`, `created_source_id`, `evidence`。

Errors：`400` invalid UUID；`404` run not found。

### 3.8 `POST /api/crawler/runs/{id}/retry`

根据旧 run 找到其 source，并创建一个全新的 run/job。它不会修改或复用旧 run。无 request body。

Success：`202 Accepted`

```json
{
  "runId": "new-run-uuid",
  "jobId": "new-job-uuid"
}
```

Errors：

- `400 {"error":"Invalid crawl run id"}`；
- `400 {"error":"Crawl run not found"}`；
- `400`：原 source 当前不满足 enqueue 前置条件。

### 3.9 `GET /api/crawler/raw-documents/{id}`

返回 RawDocument、最多 100 个 text chunks、extraction candidates 和 media candidates。

Success：`200 OK`

```json
{
  "document": {
    "id": "uuid",
    "source_id": "uuid",
    "source_name": "Example",
    "crawl_run_id": "uuid or null",
    "root_event_id": "uuid or null",
    "document_type": "HTML",
    "canonical_url": "https://example.com/page",
    "title": "Page title",
    "text_preview": "...",
    "fetched_at": "ISO-8601",
    "content_hash": "sha256",
    "mime_type": "text/html",
    "r2_bucket": "kita-raw",
    "r2_key": "...",
    "processing_status": "EXTRACTED",
    "created_at": "ISO-8601"
  },
  "chunks": [
    {
      "id": "uuid",
      "chunk_index": 0,
      "heading_path": "Guests",
      "content": "...",
      "language": "en",
      "char_start": 0,
      "char_end": 1000,
      "metadata": {}
    }
  ],
  "candidates": [
    {
      "id": "uuid",
      "candidate_type": "...",
      "confidence": 0.9,
      "status": "PENDING",
      "payload": {},
      "created_at": "ISO-8601"
    }
  ],
  "media": [
    {
      "id": "uuid",
      "resolved_url": "https://...",
      "category": "EVENT_LOGO",
      "classification_score": 90,
      "fetch_status": "FETCHED",
      "width": 1000,
      "height": 500,
      "mime_type": "image/png"
    }
  ]
}
```

`document` 会包含 `ingestion.raw_document` 的其他数据库字段；上面列出主要调用字段。

Errors：`400` invalid UUID；`404` raw document not found。

### 3.10 `GET /api/crawler/raw-documents/{id}/download`

为 RawDocument 对应的 private object 生成 signed URL。

Success：`302 Found`，`Location` 指向 R2 signed GET URL，默认有效期 900 秒。多数 HTTP clients 会自动 follow redirect，最终 response body 是原始 bytes，content type 由 R2 object 决定。

Errors：

- `400 {"error":"Invalid raw document id"}`；
- `404 {"error":"Raw document not found"}`；
- `503 {"error":"..."}`：R2 配置缺失、bucket 不在 allowlist 或签名失败。

### 3.11 `GET /api/crawler/media/{id}/download`

为 `media.asset` 对应的 private object 生成 signed URL。这里的 `{id}` 是 **media asset UUID**，不是 `ingestion.media_candidate.id`。

Success：`302 Found`，行为和 raw download 相同。

Errors：

- `400 {"error":"Invalid media asset id"}`；
- `404 {"error":"Media artifact not found"}`；
- `503 {"error":"..."}`：R2 signer 失败。

### 3.12 `GET /api/crawler/events/{id}/evidence`

返回 event 级别的完整 crawler aggregate。

Success：`200 OK`

```json
{
  "event": {
    "id": "uuid",
    "canonical_name": "Event name",
    "official_url": "https://example.com/",
    "enrichment_state": "OFFICIAL_SITE_CRAWLING",
    "internal_cover_asset_id": "uuid or null"
  },
  "runs": [],
  "sources": [],
  "documents": [],
  "media": [],
  "graph": []
}
```

Array element 主要字段：

- `runs`：`id`, `status`, `scheduled_at`, `started_at`, `finished_at`, page counters, `documents_created`, `media_discovered`, `logo_discovery_status`, `error_summary`；
- `sources`：`id`, `name`, `source_type`, `base_url`, `trust_level`, `enabled`, `relation_type`, `confidence`；
- `documents`：`id`, `canonical_url`, `document_type`, `page_type`, `title`, `fetched_at`, `mime_type`, `byte_size`；
- `media`：asset `id`, `detected_category`, `source_url`, `r2_bucket`, `r2_key`, dimensions, mime type，以及 assignment `role`, `is_default_internal`, `pinned`；
- `graph`：discovered URL `id`, parent/fetched document IDs, normalized URL, anchor, link kind, page hint, priority, decision 和 reason。

Errors：`400` invalid event UUID；`404` event not found。

### 3.13 Candidate review APIs

Website connector 抓取完成后不会自动发布 Event。页面级 extraction Candidates 作为内部 evidence 保留；Console 默认只展示 Resolution Agent 对整个 crawl run 生成的 aggregate `EVENT_RESOLUTION` Candidate。编辑器用 Overview、Schedule、Exhibitors、Related Fandoms、Updates 五个稳定 URL 展示接近最终 Event 页面的人类可读预览，原始 assertions/chunks/media 收进 evidence drawer，再选择以下三种结果：

1. 创建新的 `REVIEW` Event；
2. 把 evidence 关联到已有 Event；
3. 拒绝 candidate，同时保留 RawDocument 和全部 evidence。

一次完整 crawl run 的跨页面合并由独立 Resolution Agent 完成；它可以调用 Anime Knowledge Service 做 LLM + Bangumi 语义解析，但不能绕过人工 review 自动发布。确定性结果仍可人工批准，也可从 Candidate 页面以 `LLM_REQUIRED` 模式重新解析而无需重抓。

#### `GET /api/candidates?status=PENDING&limit=250`

返回按“有标题、confidence、创建时间”排序的 candidate 摘要。`status` 支持 `PENDING`、`APPROVED`、`REJECTED`，`limit` 为 `1..250`。Pending 队列只包含 `published_event_id IS NULL` 的可操作项目；AnimeCons 或 event-scoped crawl 已经绑定 canonical Event 的 candidates 不会重复进入人工队列。

```json
{
  "candidates": [
    {
      "id": "candidate-uuid",
      "candidateType": "DOCUMENT_EXTRACTION",
      "status": "PENDING",
      "confidence": 1,
      "publishedEventId": null,
      "sourceName": "Anime Expo Official",
      "canonicalUrl": "https://www.anime-expo.org/",
      "pageType": "LISTING",
      "proposedTitle": "Anime Expo 2026",
      "proposedStartAt": "2026-07-02T08:09:00-07:00",
      "proposedLocation": "Los Angeles Convention Center",
      "processingMode": "DETERMINISTIC_FALLBACK"
    }
  ]
}
```

#### `GET /api/candidates/{id}`

返回 candidate summary 加上：

- `rawDocumentId` 和原始 extraction `payload`；
- `assertions[]`：field、raw/normalized value、confidence、locator、excerpt；
- `chunks[]`：最多 100 个结构化文本块；
- `media[]`：最多 48 个高分 media candidates；
- `draft`：从 assertions 确定性生成、可由编辑者修改的 canonical event 表单；
- `bundle`：当前有效的 Event Content Bundle v2；如果存在 human draft，优先返回 `review.draftBundle`，否则返回原始 resolution `result`；
- `draftRevision` / `draftSavedAt`：人工编辑 revision 和保存时间；
- `existingEvents[]`：用于 Link Existing Event 的选择项；Console 在本地按标题、状态或日期搜索过滤；
- `processing`：默认收起的处理审计信息，包含 `mode`、model provider/name、prompt version、input/output token metrics、duration、warnings、resolution `jobId`、`crawlRunId`、evidence document count，以及最近一次 review mutation failure。

Console 会把 `processing.mode` 显示为以下 badge：

- `LLM_KB` → **LLM + KB**：Knowledge Service 的模型与 Bangumi KB 结果通过 schema validation；
- `DETERMINISTIC_FALLBACK` → **Deterministic fallback**：原本配置了 LLM + KB，但 Knowledge Service/model 失败或超出 budget，Resolution Agent 提交 deterministic baseline；
- `DETERMINISTIC_ONLY` → **Deterministic only**：这条 Candidate 本来就是规则解析，不尝试 LLM。

`processing.lastReviewFailure` 来自 Candidate payload 的 `review.lastFailure`，用于在刷新页面后仍能定位 materialize/link/reject 失败。它只保存经过 secret redaction 的 message、稳定错误编号和 correlation reference，不保存数据库 credentials。

#### `PUT /api/candidates/{id}/draft`

Input：`{ "bundle": <event-content-bundle/v2> }`。

服务端用共享 `eventBundleSchema` 验证完整 bundle，然后写入 Candidate payload 的 `review.draftBundle`，递增 `review.draftRevision` 并写 `review.draftSavedAt`。原始 `result` 不变。只有 `status='PENDING' AND published_event_id IS NULL` 可以保存。Success：`200 { "bundle": {}, "revision": 2, "savedAt": "..." }`。

保存失败时编辑弹窗保持打开并显示错误。Schema 校验错误返回字段路径和 `INVALID_CANDIDATE_DRAFT`；未预期的持久化错误返回 `CANDIDATE_DRAFT_SAVE_FAILED` 与可在服务端日志查找的 `errorId`。保存时间及 JSON 导入元数据在 PostgreSQL `jsonb_build_object` 中使用显式 `text` 类型，避免参数类型无法推断（`42P18`）。

#### `POST /api/candidates/{id}/retry-resolution`

无 request body。它从 Candidate 的原 resolution job 取得 crawl run/source scope，新建 high-priority `EVENT_RESOLUTION` job，payload 含 `resolutionMode='LLM_REQUIRED'` 和 `retryOfCandidateId`。它不会访问网站。Knowledge Service 或模型不可用时 Agent 必须 fail/retry job，不能再次 silent fallback。Success：`202 { "jobId": "...", "crawlRunId": "...", "status": "QUEUED" }`。

#### `GET /api/candidates/{id}/export`

返回 `application/zip`。ZIP 包含本 Candidate evidence scope 内全部 byte-for-byte RawDocument、assertions、chunks、media-candidate metadata、原始 resolution payload、运行时 JSON Schema、manifest 和 Codex prompt。R2/local object key 不会写入公开 manifest；单个 artifact 无法读取时会生成对应 `.unavailable.txt`，而不是让整个 package 失败。该接口只读，不创建 job、不修改 Candidate，也不重新 crawl。

#### `POST /api/candidates/{id}/import`

Request：`{ "filename": "event-bundle.json", "bundle": { ... } }`。API 完整校验 `event-content-bundle/v2`、Bangumi encoded ID、URL/enum，以及所有 document UUID 是否属于该 Candidate。Success 返回 effective bundle、递增的 `revision`、`savedAt` 和 `processingMode='MANUAL_JSON'`。原 `payload.result` 保持不变。

#### `POST /api/candidates/manual`

Request：`{ "sourceId": "uuid", "name": "Event name", "bundle"?: { ... } }`。Source 必须存在且至少有一个 `COMPLETED`/`PARTIAL` crawl run 和 RawDocument。最新 eligible run 的全部 documents 会成为新 `PENDING EVENT_RESOLUTION` Candidate 的 evidence。Success：`201 { "candidateId": "..." }`。Console `/events/new` 调用该 API 并进入相同的 Candidate staged editor。

完整人工 Codex A/B 流程、ZIP 文件表和 failure contract 见 [`../specs/codex-event-resolution-ab-test.md`](../specs/codex-event-resolution-ab-test.md)。

#### `GET /api/resolution/status`

返回 `RESOLUTION_AGENT` workers 和 `EVENT_RESOLUTION` jobs，包括 mode、attempt、model provider/name、prompt version、tokens、duration、document count、warnings、Candidate link 和 bounded error。Console 在 `/resolution-jobs` 使用此接口；`/crawl-jobs` 明确排除这些 workers/jobs。

#### `POST /api/candidates/{id}/materialize`

Expected input：

```json
{
  "title": "Anime Expo 2026",
  "eventType": "CONVENTION",
  "startAt": "2026-07-02T15:09:00.000Z",
  "endAt": "2026-07-06T01:00:00.000Z",
  "timezone": "America/Los_Angeles",
  "officialUrl": "https://www.anime-expo.org/",
  "summary": "Editor-reviewed summary",
  "venueName": "Los Angeles Convention Center",
  "addressLine1": "1201 S Figueroa St",
  "city": "Los Angeles",
  "region": "CA",
  "countryCode": "US",
  "postalCode": "90015"
}
```

Success：`200 { "eventId": "...", "reused": false }`。

审批会创建或复用 exact-name/city venue、创建 `status=REVIEW` / `data_origin=LIVE` Event、写入 summary、`ingestion.event_source` 和 `event.event_evidence`，并把同一 crawl run 的 assertions、media candidates 和 `root_event_id` 关联到 Event。对于 `event-content-bundle/v2` Candidate，会优先读取 `review.draftBundle`，没有 draft 才读取原始 `result`，然后幂等 upsert links、facts、tickets、exhibitors、sessions、guests、updates、activities 和 related subjects。Candidate 更新为 `APPROVED` 并保存 `published_event_id`；重复调用不会重复创建 Event 或内容记录。

`published_event_id IS NULL` 表示 Candidate **尚未绑定 Event**，正是允许 `materialize` 创建新 Review Event 的前置条件，并不是错误状态。只有 `status='PENDING' AND published_event_id IS NULL` 的 Candidate 可以创建；成功后两者原子更新为 `APPROVED` 和新 Event ID。

#### `POST /api/candidates/{id}/link`

Input：`{ "eventId": "existing-event-uuid" }`。

Success：`200 { "eventId": "...", "reused": false }`。该接口不覆盖 Event canonical fields，只增加 source/evidence 关系并回填 candidate、assertions、RawDocument 和 media candidate 的 event linkage。

#### `POST /api/candidates/{id}/reject`

无 request body。Success：`200 { "status": "REJECTED" }`。拒绝不会删除 RawDocument、chunks、assertions 或 media candidates。

Mutation errors：`400` input validation；`404` candidate/event 不存在；`409` candidate 已被另一位编辑者处理；`500` persistence failure。未预期的 mutation failure 会返回并持久化真实错误编号与 correlation reference：

```json
{
  "error": "Could not create review event: <safe message> · REVIEW_EVENT_CREATE_FAILED · reference 2e9f…",
  "errorCode": "REVIEW_EVENT_CREATE_FAILED",
  "errorId": "2e9f…"
}
```

如果底层 driver 提供 PostgreSQL code（例如 `23505`），`errorCode` 会保留该真实 code；否则使用 action-specific stable code。Console 会立即显示完整 `error`，并在 Candidate 的 **More info** 中显示最后一次已持久化 failure。下一次 materialize/link 成功后会清除旧 failure。

### 3.14 `GET /api/crawler/events/{id}/source-graph`

返回 event evidence 的精简 projection，适合只需要 source 和 URL graph 的调用方。

Success：`200 OK`

```json
{
  "event": {},
  "sources": [],
  "graph": []
}
```

字段与上一节对应部分完全相同，不包含 `runs`、`documents` 和 `media`。

Errors：`400` invalid event UUID；`404` event not found。

### 3.15 跨页面 Resolution 链路

官方站 crawl run 完成后，KitaCon 会创建一个 `EVENT_RESOLUTION` job。Crawler 不直接调用模型，也不把 87 个页面级 Candidates 当成 87 个 Events。完整链路是：

```text
Crawler RawDocuments/assertions/chunks
  -> KitaCon scoped resolution API
  -> Resolution Agent（租约、证据边界、确定性 baseline、evidence 去重/排序到自适应的最高 15k budget）
  -> Anime Knowledge Service（Bangumi 检索 + 24k 完整 prompt budget + Ollama + schema validation）
  -> Resolution Agent
  -> KitaCon one event-level review Candidate
```

职责边界：

- Crawler 只负责抓取和保存可追溯 evidence；
- KitaCon 主站拥有 job、Candidate、Event、Neon 和 R2 权限；
- Resolution Agent 只通过受控 API 租 job、读本次 run 的 evidence、提交一个结果；
- 重复 description、assertions、chunks 和 media 在 Resolution Agent 中确定性去重；不同值的核心字段保留为冲突证据，完整原始 evidence 仍保存在 KitaCon；
- Website connector 会按 `SCHEDULE`、`PROGRAMMING`、`EXHIBITORS`、`VENDORS`、`ARTIST_ALLEY`、`GUESTS`、`NEWS` 和 `ANNOUNCEMENTS` 页面类型，从 JSON-LD 与语义 DOM cards 生成 `content.*` assertions；
- Resolution Agent 将这些 assertions 规范化为 `event-content-bundle/v2`，并在模型结果之上保留所有确定性记录；
- 只有当该 run 不再有 `URL_FETCH` / `MEDIA_FETCH` 工作时才 enqueue 聚合 resolution；dedupe key 包含最终 document count，避免 crawl 中途短暂进入 `COMPLETED` 时提前解析；
- Candidate queue 默认只显示 `EVENT_RESOLUTION`，逐页 `DOCUMENT_EXTRACTION` 仅作为内部 evidence 保留；完成的 run 可通过 `POST /api/crawler/runs/{id}/resolve` 重新聚合而无需重抓；
- 可抓字段、Bangumi/LLM 责任以及 mock 中属于平台数据的字段，见 [`../event-content-population.md`](../event-content-population.md)；
- Anime Knowledge Service 拥有 Bangumi snapshots、检索、prompt、Ollama 和文件名解析，不持有 KitaCon 数据库或 R2 credentials；
- Knowledge Service 加入 baseline 和 Bangumi graph 后再次检查完整 prompt，超预算的 direct request 在调用 Ollama 前返回 `413`；
- Knowledge Service 不可用时，Resolution Agent 仍提交一个带 warning 的确定性 review Candidate。
- 如果 editor 明确触发 `LLM_REQUIRED` retry，Knowledge Service/model 失败必须作为 Resolution Job failure 显示，不能提交另一个 deterministic fallback。
- `/crawl-jobs` 只显示 crawler workers/jobs；`/resolution-jobs` 只显示 Resolution Agent 和 `EVENT_RESOLUTION` jobs。

详细 contracts 与 setup：

- [`packages/resolution-agent/README.md`](../../packages/resolution-agent/README.md)
- [`packages/anime-knowledge-service/README.md`](../../packages/anime-knowledge-service/README.md)

## 4. 推荐的本地端到端启动顺序

```bash
# 1. 安装 Web 和 crawler dependencies
npm install
python3 -m venv workers/crawler/.venv
workers/crawler/.venv/bin/pip install --requirement workers/crawler/requirements.lock
workers/crawler/.venv/bin/pip install --no-deps --editable workers/crawler
workers/crawler/.venv/bin/python -m playwright install chromium

# 2. 配置 .env.local 后迁移数据库
npm run db:migrate

# 3. 验证 worker runtime
npm run crawler:doctor

# 4. Terminal A: 启动 Web/API
npm run dev

# 5. Terminal B: 启动 worker
npm run crawler:worker

# 6. Terminal C（语义解析可选）: 启动 Ollama 后启动 Knowledge Service
npm run knowledge:dev

# 7. Terminal D（语义解析可选）: 启动 Resolution Agent
npm run agent:dev
```

然后在 Console 创建 source、完成 policy review 并选择 **Run now**。也可调用：

```bash
curl -X POST http://localhost:3009/api/crawler/sources/<source-uuid>/run
curl http://localhost:3009/api/crawler/status
```

如果 run 一直是 `QUEUED`，首先检查 worker 日志和 `/api/crawler/status` 中的 heartbeat；如果 job 是 `RETRY_WAIT` 或 `DEAD`，检查 `lastError` 及 run detail 中的 `errors`。
