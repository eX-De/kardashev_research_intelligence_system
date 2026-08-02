# Kardashev Research Intelligence System (KRIS)

[简体中文](README.md) | English

Kardashev Research Intelligence System (KRIS) is a research-intelligence workspace for individuals and small teams. It connects Obsidian project notes, newly published arXiv papers, PDF full text, LLM judgments, and Markdown artifacts into a recoverable daily intelligence pipeline. The dashboard handles configuration, scheduling, triage, and reading, while long-lived and manually editable content remains primarily in Obsidian Markdown, database records, and generated `artifacts`.

KRIS can also receive experiment progress from [eX-De/kris-agent](https://github.com/eX-De/kris-agent). After an agent completes an experiment, refactor, or evaluation in a code workspace, it can push a structured experiment report to KRIS. KRIS stores the report as a project artifact and adds it to project context so later paper recommendations, project search, and daily reports can use the actual engineering progress.

For notes, KRIS can connect directly to a local Obsidian vault or read remote Obsidian Markdown from OSS, S3, R2, or another S3-compatible object store. A local Obsidian installation can use the [Remotely Save](https://github.com/remotely-save/remotely-save) plugin to synchronize with the same bucket. A server-hosted KRIS instance can then synchronize those notes and append generated artifacts under a dedicated output prefix. More note-taking and knowledge-base integrations may be added later.

## Deployment Options

KRIS supports two primary deployment modes:

- Docker: recommended for servers and long-running environments. The default image is `exde1968/kardashev-research-intelligence-system:latest`. The repository's [docker-compose.yml](docker-compose.yml) starts PostgreSQL 17, Docker secrets, and optional Nginx HTTPS. To pin or roll back a version, set `KRIS_IMAGE` in `.env` to a version or `sha-*` tag.
- Source: recommended for local development and fast debugging. Install the Node and Python dependencies, configure a PostgreSQL connection, and run the built dashboard with `npm start`.

Minimal Docker Compose example, after preparing `secrets/*.txt` as described in the Docker Compose section:

```powershell
Copy-Item .env.example .env
docker compose up -d
```

For production, use the repository's [docker-compose.yml](docker-compose.yml) so PostgreSQL, secret files, and the optional HTTPS reverse proxy remain aligned. Source deployments also require PostgreSQL through `DATABASE_URL` or `POSTGRES_*` settings.

## Best Practices

For long-term use, self-host KRIS on an always-on server with [docker-compose.yml](docker-compose.yml) and PostgreSQL 17. Keep only essential administration endpoints such as SSH exposed. Do not expose ports `3000`, `5432`, or other internal service ports directly to the internet. For public access, prefer Cloudflare Tunnel over opening origin ports.

Running KRIS on a server turns it into a persistent research hub. It can execute `run-daily` on a schedule, continuously synchronize notes, fetch arXiv papers, generate reports, and preserve task history. You can reach the same dashboard from multiple devices, while [kris-agent](https://github.com/eX-De/kris-agent) can report progress from separate code workspaces at any time. This is better suited to accumulated project context, automated reports, and cross-device collaboration than starting KRIS temporarily on a personal computer.

Recommended topology:

- `kris.example.com`: the user-facing KRIS dashboard. Point a Cloudflare Tunnel public hostname to `http://localhost:3000` or `http://app:3000`, configure it as a self-hosted Cloudflare Access application, and allow only your account, team email addresses, or identity-provider users.
- `kris-agent.example.com`: the experiment-report endpoint for [kris-agent](https://github.com/eX-De/kris-agent). It may point to the same KRIS service, but a separate hostname makes it easier to apply a narrower Cloudflare Access service token, WAF rules, rate limits, and log filters. KRIS should still use a strong `KRIS_AGENT_TOKEN`, sent by agents in `x-experiment-agent-token`.

Cloudflare Tunnel creates an outbound-only connection from `cloudflared` to Cloudflare. Users and agents access Cloudflare hostnames, and Cloudflare forwards traffic to the local KRIS service, allowing the server firewall to keep inbound application ports closed. See the official documentation for [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), [Published applications](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/), and [Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).

Additional recommendations:

- Use Docker Compose and PostgreSQL 17 for long-running deployments. Source deployments should also connect to PostgreSQL.
- Store a stable random value in `panel_session_secret.txt`; otherwise existing login sessions become invalid after a restart.
- Use different strong random values for `panel_password.txt` and `kris_agent_token.txt`. Give the agent token only to automated callers.
- Without the Nginx profile, keep `APP_HOST_BIND=127.0.0.1` or block public access to port `3000` with a firewall. Cloudflare Tunnel normally does not require publicly exposed ports `80` or `443`.
- Back up the PostgreSQL volume `pgdata17` and `./data` regularly. The former contains the primary business database; the latter contains PDF/TXT caches, remote Obsidian mirrors, and other file data.
- Store LLM provider credentials, remote Obsidian storage credentials, Cloudflare tokens, and similar secrets in secret files or secure server-side configuration. Never commit them to Git.
- Protect `kris.example.com` with Access login. Use an Access service token or equivalent machine identity for `kris-agent.example.com`, while retaining KRIS's `KRIS_AGENT_TOKEN` validation as a second layer.
- Prefer a remote Obsidian connection for server deployments. A local Obsidian instance can synchronize through [Remotely Save](https://github.com/remotely-save/remotely-save) to OSS, S3, or R2, while KRIS reads the same bucket with `OBSIDIAN_STORAGE_BACKEND=oss`, `s3`, or `r2`.
- Set `OBSIDIAN_REMOTE_OUTPUT_PREFIX` to a dedicated directory such as `Research Intelligence`. KRIS only appends generated artifacts under that prefix and does not overwrite or delete original notes.
- The following sanitized Alibaba Cloud OSS RAM policy is a starting point. `oss:ListObjects` requires bucket-level authorization, while `oss:GetObject` and `oss:PutObject` use object-level resources. Replace `YOUR_BUCKET_NAME` with your bucket name:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "oss:ListObjects",
      "Resource": "acs:oss:*:*:YOUR_BUCKET_NAME"
    },
    {
      "Effect": "Allow",
      "Action": [
        "oss:GetObject",
        "oss:PutObject"
      ],
      "Resource": "acs:oss:*:*:YOUR_BUCKET_NAME/*"
    }
  ]
}
```

## Core Capabilities

- Project context: synchronize research notes from a local Obsidian vault or remote OSS/S3/R2 object storage, and identify project home pages, project folders, and project status.
- Paper discovery: fetch papers from configured arXiv categories, run abstract-level prefiltering, cache PDF/TXT full text, split documents into chunks, and retrieve supporting evidence.
- Project matching: compare full-text evidence with project context and generate project-level candidate papers, LLM judgments, and recommendation states.
- Experiment progress intake: receive structured experiment reports from [kris-agent](https://github.com/eX-De/kris-agent) or other scripts and preserve them as project artifacts and context.
- Paper reading: import arXiv or PDF links, upload local PDFs, import cleaned webpage text, generate full-paper reports, chat with paper context, and save reading notes to Obsidian.
- Unified search: search papers, research artifacts, projects, and individual user questions with quick lexical search or explicitly selected deep search.
- Bilingual interface: switch between Simplified Chinese and English, including localized system notifications and language-aware default paper-reading prompts.
- Automated artifacts: generate daily reports, paper reports, project indexes, experiment-progress records, and other Markdown artifacts, with optional Obsidian export.
- Scheduling and recovery: the Node service manages manual jobs, startup daily runs, scheduled jobs, and the paper-report queue; the worker records job history and supports daily-pipeline recovery and retry.
- Deployment choice: Docker Compose provides PostgreSQL 17 by default; source deployments connect through `DATABASE_URL` or `POSTGRES_*`; an optional Nginx HTTPS reverse proxy is available.

## Technology Stack

| Layer | Implementation |
| --- | --- |
| Frontend | Vite, React 19, React Router, React Markdown, KaTeX/GFM |
| API service | Native Node HTTP server for static assets, authentication, SSE, online CRUD/read operations, and job enqueueing |
| Worker | Persistent Python worker service for `worker_jobs`, files and Obsidian, arXiv, RAG, LLM calls, and report generation |
| Database | PostgreSQL; Docker Compose provides PostgreSQL 17 and uses pgvector for vector retrieval |
| Deployment | `npm start`, split development processes, Docker Compose, and an optional Nginx profile |

## Repository Structure

```text
.
├── src/                         # React dashboard
├── public/                      # Static assets, including research-mark.svg
├── worker/                      # Python worker, API adapters, database, and pipeline logic
├── tests/                       # unittest and Node tests
├── deploy/nginx/                # Optional HTTPS reverse-proxy template and certificates
├── secrets/                     # Docker secret examples; real *.txt files are not committed
├── data/                        # PDF/TXT caches, remote vault mirror, and runtime files
├── server.js                    # Node API/static/scheduler service
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## Source Deployment

Requirements:

- Node.js `>=22.12.0`
- Python `>=3.11`

Local PowerShell example:

```powershell
npm ci

python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

Copy-Item .env.example .env
# Edit .env and configure DATABASE_URL or POSTGRES_HOST/PORT/DB/USER/PASSWORD
npm run init-db
npm start
```

Open:

```text
http://localhost:3000
```

Source mode requires PostgreSQL. Set `DATABASE_URL` / `DATABASE_URL_FILE`, or provide `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` / `POSTGRES_PASSWORD_FILE`. To start the entire stack quickly, use Docker Compose. If a virtual environment is not active, set `PYTHON_BIN` in `.env` to its Python executable, for example `.venv\Scripts\python.exe`.

`server.js` does not initialize the schema on every API request. Before the first source-mode start, or after a schema update, run `npm run init-db`. The Docker image entry command still runs `python -m worker.cli init-db` before starting the Node service.

`KRIS_JOB_BACKEND=queue` is the default job backend. Node writes daily pipelines, synchronization, fetching, and report jobs to `worker_jobs`. After building the frontend, `npm start` starts both the Node API/static service and the persistent Python worker.

To debug the worker separately, open another terminal and run:

```powershell
npm run worker
```

Set `KRIS_JOB_BACKEND=cli` only when you temporarily need the legacy Node-spawned CLI behavior.

On first entry, use onboarding to configure Obsidian or create the first in-system project. Then configure arXiv, RAG, LLM providers, and automation policies in Settings.

## Development Mode

Start three terminals during development:

```powershell
# Terminal 1: API and worker proxy
npm run start:api

# Terminal 2: persistent Python worker
npm run worker

# Terminal 3: Vite development server
npm run dev
```

Open:

```text
http://localhost:5173
```

Vite proxies `/api` to `http://localhost:3000`. In production mode, `npm start` first builds the frontend into `dist/`, then starts `server.js` and `python -m worker.service`. If `dist/` does not exist, Node falls back to serving `public/`.

## Dashboard Navigation

- Home: daily-pipeline state, project/paper/artifact/knowledge-context metrics, notifications, and recent updates.
- Papers:
  - Inbox: inspect recommended papers, evidence, and project judgments; save or discard papers and trigger full-paper reports. The detail header can open the corresponding Paper Library entry or Chat directly.
  - Paper Library: filter, search, and maintain papers; switch among Project Overview, Paper Report, and Metadata; manage project associations, sources, PDFs, and report state. Links from Inbox, unified search, or external deep links automatically locate the target's list page, and manual pagination immediately loads the first paper on the new page.
  - Chat: browse paper reports and user questions by paper and continue a conversation using full text, reference papers, and project context.
- Projects: project list, project creation, notifications, and project statistics.
- Project details: edit keywords and Obsidian paths, associate papers and notes, and inspect candidate papers, experiment progress, and project artifacts.
- Artifacts: filter artifacts by type, scope, and state; read Markdown and source data; export to Obsidian. Unified-search and deep-link navigation synchronizes the list to the target page.
- Tasks: run the daily pipeline, synchronize Obsidian, fetch arXiv, cache full text, generate reports, and inspect job history and backend execution state.
- Settings: inspect database status and configure Obsidian, arXiv, RAG, LLM providers, model routing, scheduling, and local path selection.

## Daily Pipeline

`run-daily` is the core system job. The worker records stage-level progress and supports recovery or retry after failure:

1. Synchronize context sources: local or remote Obsidian, project notes, and project knowledge documents.
2. Fetch arXiv: import metadata using the configured categories, lookback window, and result limit.
3. Build the daily snapshot: record the paper set handled by this run.
4. Cache full text: download PDFs and extract TXT with PyMuPDF.
5. Global ranking: match research context through embeddings, keywords, and configured searchers.
6. Project ranking: restrict retrieval to each project's associated context.
7. Project judgment: use an LLM to generate structured judgments for each project-paper-evidence combination.
8. Synchronize recommendations: update project-paper recommendation states.
9. Paper reports: process reports for recommended or manually requested papers through the queue.
10. Archive zero-hit papers to reduce later noise.
11. Generate the daily-report artifact with metrics, candidates, risks, and next actions.

Common commands:

```powershell
npm run run-daily
npm run sync-obsidian
npm run fetch-arxiv
npm run cache-arxiv-text
npm run generate-paper-reports
npm run generate-reports
```

Recovery and retry commands can call the worker directly:

```powershell
python -m worker.cli resume-daily --job-id 123
python -m worker.cli retry-daily
python -m worker.cli generate-paper-reports --limit 10
```

## Configuration

Copy `.env.example` to `.env` before editing it. `.env` contains startup-level configuration and non-secret Docker Compose interpolation. Store Docker passwords, tokens, and the session secret in `./secrets/*.txt`. Business settings saved through the dashboard are written to PostgreSQL and override matching `.env` defaults at runtime.

Key startup settings:

- `PORT`: Node service port, default `3000`.
- `DATABASE_URL` / `DATABASE_URL_FILE`: PostgreSQL connection URL. These take precedence when set.
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` / `POSTGRES_PASSWORD_FILE`: PostgreSQL fields used when `DATABASE_URL` is absent. Docker Compose points them to its bundled PostgreSQL 17 service by default.
- `PYTHON_BIN`: Python command used only by the `KRIS_JOB_BACKEND=cli` fallback and a small number of interactive CLI fallbacks.
- `KRIS_REQUEST_TIMING_LOG`: set to `1` or `true` to emit a `KRIS_REQUEST_TIMING` line for each regular `/api/*` request, including method, path, status, duration, worker command, and response size.
- `KRIS_WORKER_TIMING_LOG`: set to `1` or `true` to emit Python worker CLI timing for connection, schema initialization, stale cleanup, handler work, and total duration.
- `KRIS_STALE_JOB_CLEANUP_ENABLED` / `KRIS_STALE_JOB_CLEANUP_INTERVAL_MS`: control Node's stale-job cleanup timer, enabled by default with a 60,000 ms interval.
- `KRIS_WORKER_HEARTBEAT_INTERVAL_SECONDS` / `KRIS_WORKER_HEARTBEAT_TTL_SECONDS`: the Worker writes instance and current-task heartbeats every 5 seconds by default; Node considers it offline after 15 seconds without a heartbeat.
- `KRIS_WORKER_MONITOR_INTERVAL_MS`: interval for Node to inspect Worker availability and stalled queues, default 5,000 ms.
- `KRIS_WORKER_JOB_STALE_AFTER_SECONDS`: lease recovery threshold for `worker_jobs.running`, default 90 seconds. The Worker renews the lease while running; after a disconnect, a timed-out job is requeued while attempts remain, or failed and synchronized to `job_runs` after exhaustion.
- `KRIS_JOB_BACKEND`: job execution backend, default `queue`. Node writes `worker_jobs` for `python -m worker.service`; set it to `cli` only for temporary legacy fallback.
- `KRIS_OUTBOX_POLLER_ENABLED` / `KRIS_OUTBOX_POLL_INTERVAL_MS`: control Node polling of the `app_events` outbox and forwarding to `/api/events`, enabled by default at 1,000 ms. Node write endpoints and the persistent worker both write cache-invalidation events to `app_events`.
- `KRIS_WORKER_POLL_INTERVAL_MS` / `KRIS_WORKER_INIT_DB_ON_START`: configure queue polling and schema initialization for the persistent worker.
- `KRIS_READER_FOLLOWUPS_SYNC_FALLBACK_ENABLED`: controls the synchronous interactive CLI fallback for selected-text follow-up questions. When `false`, the endpoint returns `reader_followups_sync_fallback_disabled` until an asynchronous suggestion result flow is available.
- Node owns online settings, job summary/history, health, notifications, projects, artifacts, library, inbox, paper details, feedback, recommendations, reader list/detail, and report-control APIs. Python owns heavy/action jobs such as the daily pipeline, synchronization, fetching, ranking, artifact export, reader imports/saves, report generation, LLM operations, and Obsidian file work. Reader streaming chat and optional follow-up questions remain interactive CLI fallbacks rather than regular CRUD/read operations.
- `KRIS_PG_POOL_MAX`, `KRIS_PG_IDLE_TIMEOUT_MS`, `KRIS_PG_CONNECTION_TIMEOUT_MS`: Node PostgreSQL connection-pool settings. Schema ownership remains with `npm run init-db` and the Python worker.
- `PANEL_PASSWORD` / `PANEL_PASSWORD_FILE`: single-password protection. An empty value enables passwordless mode.
- `PANEL_SESSION_SECRET` / `PANEL_SESSION_SECRET_FILE`: session-signing secret. Use a stable value in long-running deployments.
- `PANEL_COOKIE_SECURE`: set to `true` when accessed over HTTPS.
- `KRIS_AGENT_TOKEN` / `KRIS_AGENT_TOKEN_FILE`: restricted token for external experiment-report agents.

Obsidian settings:

- `OBSIDIAN_VAULT_PATH`: local vault path.
- `OBSIDIAN_INCLUDE_DIRS`, `OBSIDIAN_INCLUDE_TAGS`: scan scope and tag filters.
- `OBSIDIAN_PROJECT_CENTER_TAGS`: tag combinations used to identify project home pages.
- `OBSIDIAN_STORAGE_BACKEND`: `local`, `oss`, `s3`, or `r2`.
- `OBSIDIAN_REMOTE_*`: remote endpoint, region, bucket, prefix, credentials, mirror path, and output prefix. OSS uses the Alibaba Cloud client; `s3` and `r2` use an S3-compatible API.
- A local Obsidian installation can synchronize through [Remotely Save](https://github.com/remotely-save/remotely-save) to an OSS/S3-compatible bucket that KRIS reads in remote mode.
- Remote mode appends generated artifacts only under `OBSIDIAN_REMOTE_OUTPUT_PREFIX`; it does not overwrite or delete existing Obsidian objects.
- More note-taking and knowledge-base integrations may be added later. The recommended path today is Obsidian + Remotely Save + OSS/S3-compatible storage.

arXiv and RAG settings:

- `ARXIV_CATEGORIES`, `ARXIV_DAILY_LOOKBACK_DAYS`, `ARXIV_MAX_RESULTS`: fetch scope.
- `ARXIV_CACHE_FULL_TEXT`, `ARXIV_PDF_DIR`, `ARXIV_TEXT_DIR`: full-text cache policy and paths.
- `RAG_SCORE_THRESHOLD`, `RAG_TOP_K`, `RAG_SEARCHERS`: evidence retrieval and retention policy.
- `RAG_PREFILTER_*`: abstract prefilter threshold, top-k, minimum fallback count, and upper limit.
- Vector retrieval uses PostgreSQL/pgvector by default and does not require a separate backend setting.

LLM providers use OpenAI-compatible APIs. Configure them in the dashboard or initialize defaults in `.env`:

```env
LLM_PROVIDERS_JSON=[{"id":"provider-id","name":"Provider Name","base_url":"https://example.com/v1","api_key":"replace-me","chat_models":["chat-model-name"],"embedding_models":["embedding-model-name"]}]
LLM_CHAT_PROVIDER_ID=provider-id
LLM_CHAT_MODEL=chat-model-name
LLM_EMBEDDING_PROVIDER_ID=provider-id
LLM_EMBEDDING_MODEL=embedding-model-name
PAPER_REPORT_PROVIDER_ID=provider-id
PAPER_REPORT_MODEL=chat-model-name
PROJECT_CHAT_PROFILE_PROVIDER_ID=provider-id
PROJECT_CHAT_PROFILE_MODEL=chat-model-name
READER_CHAT_PROVIDER_ID=provider-id
READER_CHAT_MODEL=chat-model-name
```

After synchronizing project context, the daily pipeline incrementally generates a complete project Chat profile based on an input hash. It calls the model again only when project content or model configuration changes. For each paper, users can choose whether Reader Chat injects project context. The injected set includes formally associated projects and the complete profiles of `pending` or `accepted` project recommendations; it does not generate a separate short Chat profile. The toggle is available when any such relationship exists and remains disabled otherwise. `PROJECT_CHAT_PROFILE_*` selects a provider and model for profile generation and falls back to `LLM_CHAT_*` when empty. If no usable model exists, this stage is skipped without blocking paper fetching or matching.

Reader Chat can persist up to three reference papers for the active paper. The selector only offers papers with completed TXT extraction, does not display token estimates, and does not additionally truncate the combined input. Messages are assembled in this order: `current paper full text → reference paper full text → existing report → project profiles → conversation history`. Assistant messages record the reference-paper IDs actually used.

Without an LLM provider, KRIS can still initialize PostgreSQL, synchronize Obsidian, fetch arXiv, cache full text, and save feedback. Embedding, LLM judgment, report generation, and Chat operations may be skipped, fail with an actionable message, or use a limited local fallback depending on the feature.

## API and Integrations

`server.js` does not use Express. The persistent Node API reads and writes PostgreSQL directly and handles authentication, SSE, cache invalidation, online CRUD/read operations, and `worker_jobs` enqueueing. The Python worker service processes heavy and action jobs, then writes `app_events` so Node can forward cache-invalidation events. Major API groups include:

- Authentication: `/api/auth/status`, `/api/auth/login`, `/api/auth/logout`
- Projects: list, detail, save, Obsidian export, project index, and paper/note associations
- Settings and health: `/api/settings`, `/api/health`, `/api/local-path/select`
- Jobs: scheduler, startup daily run, run/resume/retry daily, individual worker jobs, and history
- Papers: inbox, library, paper details, feedback, recommendations, and report queue
- Reader: PDF/URL/web imports, PDF serving, streaming Chat, Obsidian save, and follow-up questions
- Artifacts: list, detail, and Obsidian export
- External experiment reports: `GET /api/projects` and `POST /api/experiments/reports`

External agents authenticate with `x-experiment-agent-token: <KRIS_AGENT_TOKEN>` and receive access only to the project list and experiment-report endpoints, not the complete dashboard API.

### External Experiment Report Agent

KRIS provides a restricted integration for Codex, Claude Code, or custom scripts to report experiment progress to a selected project:

- `GET /api/projects`: list projects so the agent can select `project_id`.
- `POST /api/experiments/reports`: submit an experiment report.

Both endpoints accept `x-experiment-agent-token: <KRIS_AGENT_TOKEN>`. This token does not grant access to the full dashboard API. Leaving `KRIS_AGENT_TOKEN` empty disables the external agent integration.

PowerShell example:

```powershell
$headers = @{ "x-experiment-agent-token" = $env:KRIS_AGENT_TOKEN }
$body = @{
  project_id = 1
  title = "RAG reranker ablation"
  markdown = "## Task`n`nRun an ablation study for the reranker configuration."
  report_json = @{
    task_summary = "Evaluate reranker configurations"
    results = @("Saved experiment results", "Updated project context")
    next_actions = @("Increase the sample size")
  }
  source_agent = "codex"
  idempotency_key = "workspace-a:ragrerank:2026-05-23"
  metadata = @{ workspace = "D:/coding/project-a" }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/experiments/reports" -Headers $headers -ContentType "application/json" -Body $body
```

Payload rules:

- `project_id`: required positive integer referencing an existing project.
- `title`: required, at most 240 characters.
- `markdown`: required, at most 200,000 characters; used as the artifact body and a project-context source.
- `report_json`: required object containing the structured experiment summary.
- `source_agent`: optional, default `manual`; allowed values are `codex`, `claude-code`, and `manual`.
- `idempotency_key`: required, at most 240 characters. Reusing the key updates the same report instead of creating a duplicate.
- `metadata`: optional object for caller context such as workspace, commit, or run ID.

On success, KRIS creates or updates an `experiment_report` artifact and a project knowledge document with relation `experiment_progress`. Later project-context retrieval and paper matching can use this progress. If Obsidian is configured, KRIS attempts to export the report to the project's output directory; export failure does not block database persistence.

## Docker Compose

The default published image is `exde1968/kardashev-research-intelligence-system:latest`. The repository's [docker-compose.yml](docker-compose.yml) starts PostgreSQL 17 and includes:

- `db`: `pgvector/pgvector:pg17`, storing data in the named volume `pgdata17`.
- `app`: Node 22 plus a Python virtual environment. It runs `python -m worker.cli init-db` before starting `node server.js`.
- `worker`: the same image running `python -m worker.service`, consuming `worker_jobs` and writing the `app_events` outbox.
- `./data:/data`: PDF/TXT caches, the remote Obsidian mirror, and other file data.
- Secrets are mounted only through `_FILE` paths; non-secret configuration remains in environment variables.

Prepare secrets:

```powershell
Copy-Item .env.example .env
New-Item -ItemType Directory -Force secrets
Set-Content -NoNewline secrets/postgres_password.txt "replace-with-db-password"
Set-Content -NoNewline secrets/panel_password.txt "replace-with-panel-password-or-empty"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | Set-Content -NoNewline secrets/panel_session_secret.txt
Set-Content -NoNewline secrets/kris_agent_token.txt "replace-with-agent-token-or-empty"
```

Start:

```powershell
docker compose up -d
```

Update to the latest Docker Hub image:

```powershell
docker compose pull app
docker compose up -d app
```

The dashboard periodically checks GitHub version tags and releases. When an update is available, Home shows a consolidated notification with dialogs for release notes, source update commands, and Docker update commands. The default repository is `exde1968/kardashev-research-intelligence-system`. Disable or replace it in `.env`:

```env
KRIS_UPDATE_CHECK_ENABLED=true
KRIS_UPDATE_REPOSITORY=exde1968/kardashev-research-intelligence-system
```

To pin or roll back a deployment, set `KRIS_IMAGE` in `.env`, for example:

```env
KRIS_IMAGE=exde1968/kardashev-research-intelligence-system:sha-abc1234
```

Open `http://localhost:3000`, or use the port configured through `APP_HOST_PORT`. An empty `panel_password.txt` enables passwordless mode. An empty `kris_agent_token.txt` disables external experiment-report submission.

To access a local Obsidian vault from a container, mount the vault in `docker-compose.yml` and set `OBSIDIAN_VAULT_PATH` to the in-container path, such as `/vault`.

## Nginx HTTPS

The optional `nginx` profile redirects HTTP to HTTPS and proxies to the internal `app:3000` service. Prepare certificates at:

```text
deploy/nginx/certs/fullchain.pem
deploy/nginx/certs/privkey.pem
```

Set in `.env`:

```env
PANEL_COOKIE_SECURE=true
APP_HOST_BIND=127.0.0.1
NGINX_SERVER_NAME=research.example.com
```

Start:

```powershell
docker compose --profile nginx up -d
```

`APP_HOST_BIND=127.0.0.1` prevents port `3000` from remaining directly exposed on public host interfaces.

## Script Reference

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Build the frontend into `dist/` |
| `npm run preview` | Preview the frontend build |
| `npm start` | Build the frontend and start the Node service plus persistent Python worker |
| `npm run start:api` | Start only the Node API/static service |
| `npm run init-db` | Initialize or migrate the current PostgreSQL schema |
| `npm run sync-obsidian` | Synchronize Obsidian and project context |
| `npm run fetch-arxiv` | Fetch arXiv and cache full text retained by prefiltering |
| `npm run cache-arxiv-text` | Backfill PDF/TXT caches for stored papers |
| `npm run generate-paper-reports` | Process the paper-report queue |
| `npm run generate-reports` | Generate the daily-report artifact |
| `npm run run-daily` | Run the complete daily pipeline |
| `npm run test` | Run Python unittest and Node helper tests |
| `npm run test:python` | Run Python unittest only |
| `npm run test:node` | Run Node tests only; the PostgreSQL smoke test is skipped when `TEST_DATABASE_URL` is unset |
| `npm run check` | Run Node syntax checks and tests, build the frontend, and compile Python sources |

## Verification

```powershell
npm run test
npm run check
```

`npm run test` executes `python -m unittest discover -s tests` and `node --test tests/node/*.test.js`. `npm run check` checks the Node server modules, runs Node helper/event/settings/jobs/health tests, builds the frontend, and runs `python -m compileall worker tests`. To enable the Node PostgreSQL smoke test, set `TEST_DATABASE_URL` to a dedicated test database, never a development or production database.

## Troubleshooting

- `python` is not on PATH: activate the virtual environment or set `PYTHON_BIN` in `.env`.
- Login state disappears after restart: configure a stable `PANEL_SESSION_SECRET` or `PANEL_SESSION_SECRET_FILE`.
- Docker cannot see a local Obsidian vault: mount the vault and use its in-container path.
- Reports or Chat fail: verify the LLM provider API key, base URL, model names, and the `PAPER_REPORT_*` / `READER_*` routing settings.
- The daily pipeline stops: inspect Tasks or `/api/jobs/history`, then use `resume-daily` or `retry-daily`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
