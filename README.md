# Kardashev Research Intelligence System (KRIS)

Kardashev Research Intelligence System (KRIS) 是一个面向个人或小团队的科研情报工作台：它把 Obsidian 项目笔记、arXiv 新论文、PDF 全文、LLM 判断和 Markdown 产物串成一条可恢复的每日情报流水线。Dashboard 负责配置、调度、筛选和阅读；可长期保存和人工编辑的内容仍以 Obsidian Markdown、数据库记录和 `artifacts` 产物为主。

KRIS 还可以作为实验进展接收端，与 [eX-De/kris-agent](https://github.com/eX-De/kris-agent) 配合使用。agent 在代码工作区完成实验、重构或评测后，可以把结构化实验报告推送到 KRIS；KRIS 会把报告保存为项目 artifact，并写入项目上下文，让后续论文推荐、项目检索和日报生成能读到真实研发进展。

在笔记侧，KRIS 支持直接连接本地 Obsidian vault，也支持通过 OSS、S3 或 R2 这类 S3-compatible 对象存储读取远端 Obsidian Markdown。本地 Obsidian 可以使用 [Remotely Save](https://github.com/remotely-save/remotely-save) 插件同步到同一个 OSS/S3-compatible bucket，服务器上的 KRIS 再从对象存储同步笔记并把系统产物追加写回固定输出前缀。后续会继续扩展更多外部笔记软件和知识库连接方式。

## 部署方式

KRIS 支持两种主要部署方式：

- Docker 部署：推荐用于服务器或长期运行环境。默认发布镜像为 `exde1968/kardashev-research-intelligence-system:latest`；建议直接使用仓库内的 [docker-compose.yml](docker-compose.yml)，它会启动 PostgreSQL 17、secrets 和可选 Nginx HTTPS。需要固定版本或回滚时，可在 `.env` 中设置 `KRIS_IMAGE` 为版本 tag 或 `sha-*` tag。
- 源代码部署：推荐用于本地开发和快速调试。直接从仓库安装 Node/Python 依赖，配置 PostgreSQL 连接后使用 `npm start` 启动构建后的 dashboard。

最小 Docker Compose 运行示例（按本文 Docker Compose 章节准备 `secrets/*.txt` 后执行）：

```powershell
Copy-Item .env.example .env
docker compose up -d
```

生产部署建议使用本文后面的 [Docker Compose](docker-compose.yml) 配置，以便启用 PostgreSQL、secret 文件和 HTTPS 反向代理。本地源代码部署也需要通过 `DATABASE_URL` 或 `POSTGRES_*` 连接 PostgreSQL。

## 最佳实践

推荐把 KRIS 自部署在一台长期在线的服务器上，用 [docker-compose.yml](docker-compose.yml) 启动应用和 PostgreSQL 17。服务器上只保留必要的管理入口，例如 SSH；不要把 `3000`、`5432` 或其它内部服务端口直接暴露到公网。若需要公网访问，优先使用 Cloudflare Tunnel，而不是开放源站端口。

服务器部署的主要收益是让 KRIS 成为持续运行的研究中枢：它可以每天按固定时间自动执行 `run-daily`，持续同步笔记、抓取 arXiv、生成报告和维护任务历史；你可以从任意设备访问同一个 dashboard；[kris-agent](https://github.com/eX-De/kris-agent) 也可以在不同代码工作区完成实验后随时把进展推送回来。相比只在个人电脑临时启动，服务器模式更适合长期积累项目上下文、自动化日报和跨设备协作。

推荐拓扑：

- `kris.example.com`：面向使用者的 KRIS Dashboard。Cloudflare Tunnel public hostname 指向服务器本机的 `http://localhost:3000` 或 `http://app:3000`；在 Cloudflare Access 中把它配置为 self-hosted application，只允许你的账号、团队邮箱或身份提供商用户访问。
- `kris-agent.example.com`：面向 [kris-agent](https://github.com/eX-De/kris-agent) 的实验报告上报入口。它可以指向同一个 KRIS 服务，但建议单独建 hostname，便于设置更窄的 Cloudflare Access service token、WAF 规则、速率限制和日志筛选。KRIS 侧仍要配置高强度 `KRIS_AGENT_TOKEN`，agent 请求同时携带 `x-experiment-agent-token`。

Cloudflare Tunnel 的价值是让 `cloudflared` 从服务器向 Cloudflare 建立 outbound-only 连接；用户和 agent 都访问 Cloudflare hostname，Cloudflare 再把流量转发到本机 KRIS 服务。这样服务器防火墙可以保持入站业务端口关闭。Cloudflare 官方文档可参考：[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)、[Published applications](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/) 和 [Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/)。

其它推荐配置：

- 使用 Docker Compose + PostgreSQL 17 作为默认长期运行方式；本地源代码部署也连接 PostgreSQL。
- 为 `panel_session_secret.txt` 写入固定随机值；否则重启后已有登录 session 会失效。
- 为 `panel_password.txt` 和 `kris_agent_token.txt` 使用不同的高强度随机值；agent token 只给自动化调用方。
- 如果不使用 Nginx profile，保持 `APP_HOST_BIND=127.0.0.1` 或通过防火墙阻断公网访问 `3000`；如果使用 Cloudflare Tunnel，通常不需要直接暴露 `80/443`。
- 定期备份 PostgreSQL volume `pgdata17` 和 `./data`；前者是主业务数据库，后者保存 PDF/TXT 缓存、远端 Obsidian 镜像等文件数据。
- 把 LLM provider、Obsidian 远端存储、Cloudflare token 等密钥放在 secret 文件或服务端安全配置里，不要提交到 Git。
- 为 `kris.example.com` 开启 Access 登录保护；为 `kris-agent.example.com` 使用 Access service token 或等价的机器身份控制，并保留 KRIS 自身的 `KRIS_AGENT_TOKEN` 校验作为第二层保护。
- 服务器部署时优先使用远端 Obsidian 连接：本地 Obsidian 通过 [Remotely Save](https://github.com/remotely-save/remotely-save) 同步到 OSS/S3/R2，KRIS 使用 `OBSIDIAN_STORAGE_BACKEND=oss`、`s3` 或 `r2` 读取同一 bucket。这样服务器不需要挂载你的桌面 vault，也更适合跨设备和长期运行。
- 远端 Obsidian 模式建议把 `OBSIDIAN_REMOTE_OUTPUT_PREFIX` 设为独立目录，例如 `Research Intelligence`；KRIS 只在该输出前缀下追加系统产物，不覆盖或删除你的原始笔记。
- 阿里云 OSS RAM policy 可以从下面的去敏模板开始。`oss:ListObjects` 需要授权到 bucket 级资源；`oss:GetObject` 和 `oss:PutObject` 授权到对象级资源即可。把 `YOUR_BUCKET_NAME` 替换为你的 bucket 名：

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

## 主要能力

- 项目上下文：从 Obsidian 本地 vault 或 OSS/S3/R2 远端对象存储同步研究笔记，识别项目主页、项目文件夹和项目状态。
- 论文发现：按配置的 arXiv 分类抓取论文，做摘要级粗筛、PDF/TXT 缓存、正文分块和证据检索。
- 项目匹配：把论文正文证据与项目上下文匹配，生成项目级候选论文、LLM 判定和推荐状态。
- 实验进展接收：通过 [kris-agent](https://github.com/eX-De/kris-agent) 或其它脚本上报结构化实验报告，沉淀为项目 artifact 和项目上下文。
- 论文阅读：支持导入 arXiv URL 或上传 PDF，生成全文报告，与论文上下文对话，保存阅读笔记到 Obsidian。
- 自动产物：生成日报、论文报告、项目索引、实验进展记录等 Markdown artifact，并可导出到 Obsidian。
- 调度与恢复：Node 服务管理手动任务、启动时每日任务、定时任务和论文报告队列；worker 记录任务历史并支持每日流程恢复/重试。
- 部署选择：Docker Compose 默认使用 PostgreSQL 17；源代码部署通过 `DATABASE_URL` 或 `POSTGRES_*` 连接 PostgreSQL；可选 Nginx HTTPS 反向代理。

## 技术栈

| 层 | 实现 |
| --- | --- |
| 前端 | Vite, React 19, React Router, React Markdown, KaTeX/GFM |
| API 服务 | 原生 Node HTTP server，负责静态资源、认证、SSE、在线 CRUD/read 和任务 enqueue |
| Worker | 常驻 Python worker service，负责 `worker_jobs` 中的重任务、文件/Obsidian、arXiv、RAG、LLM 和报告生成 |
| 数据库 | PostgreSQL；Docker Compose 默认提供 PostgreSQL 17，并使用 pgvector 作为向量能力路径 |
| 部署 | `npm start`、开发双进程、Docker Compose、可选 Nginx profile |

## 仓库结构

```text
.
├── src/                         # React dashboard
├── public/                      # 静态资源，包含 research-mark.svg
├── worker/                      # Python worker、API 适配、数据库和流水线逻辑
├── tests/                       # unittest 测试
├── deploy/nginx/                # 可选 HTTPS 反向代理模板和证书目录
├── secrets/                     # Docker Compose secrets 示例说明，真实 *.txt 不进 Git
├── data/                        # PDF/TXT 缓存、远端 vault 镜像等运行数据
├── server.js                    # Node API/static/scheduler 服务
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## 源代码部署

要求：

- Node.js `>=22.12.0`
- Python `>=3.11`

本地 PowerShell 示例：

```powershell
npm ci

python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

Copy-Item .env.example .env
# 编辑 .env，配置 DATABASE_URL 或 POSTGRES_HOST/PORT/DB/USER/PASSWORD
npm run init-db
npm start
```

打开：

```text
http://localhost:3000
```

源代码模式需要 PostgreSQL。可以在 `.env` 中直接填写 `DATABASE_URL` / `DATABASE_URL_FILE`，也可以设置 `POSTGRES_HOST`、`POSTGRES_PORT`、`POSTGRES_DB`、`POSTGRES_USER` 和 `POSTGRES_PASSWORD` / `POSTGRES_PASSWORD_FILE`。如果只想快速跑完整栈，直接使用 Docker Compose。如果没有激活虚拟环境，可在 `.env` 中把 `PYTHON_BIN` 指向虚拟环境里的 Python，例如 `.venv\Scripts\python.exe`。

`server.js` 不会在每个 API 请求里重复初始化 schema；源代码模式首次启动或 schema 更新后，先运行 `npm run init-db`。Docker 镜像启动命令仍会先执行 `python -m worker.cli init-db`，再启动 Node 服务。

`KRIS_JOB_BACKEND=queue` 是默认任务后端。源代码模式下，Node 负责把每日流程、同步、抓取、报告生成等重任务写入 `worker_jobs`，`npm start` 会在构建后同时启动 Node API/static 服务和常驻 Python worker。

如需单独调试 worker，可另开终端运行：

```powershell
npm run worker
```

如需临时恢复旧的 Node spawn CLI 行为，可设置 `KRIS_JOB_BACKEND=cli`。

首次进入 dashboard 后，按 onboarding 配置 Obsidian 或创建第一个系统内项目，再到“设置”里配置 arXiv、RAG、LLM provider 和自动化策略。

## 开发模式

开发时启动三个终端：

```powershell
# 终端 1：API 和 worker 代理
npm run start:api

# 终端 2：常驻 Python worker
npm run worker

# 终端 3：Vite dev server
npm run dev
```

访问：

```text
http://localhost:5173
```

Vite 会把 `/api` 代理到 `http://localhost:3000`。生产模式下 `npm start` 会先构建前端到 `dist/`，再同时启动 `server.js` 和 `python -m worker.service`；如果 `dist/` 不存在，Node 会回退服务 `public/`。

## Dashboard 导航

- 首页：每日流程状态、项目/论文/产物/知识上下文指标、提醒和最近更新。
- 论文：
  - 待判断：查看推荐论文、证据、项目判定，保存或丢弃，触发全文报告。
  - 仓库：筛选、搜索和维护已保存论文，更新阅读状态。
  - 报告队列：导入 URL/PDF，生成、取消、重试、删除论文报告，阅读 PDF/Markdown 并聊天。
- 项目：项目列表、新建项目、提醒和项目统计。
- 项目详情：编辑项目关键词与 Obsidian 路径，关联论文/笔记，查看候选论文、实验进展和项目产物。
- 产物：按类型、范围和状态筛选 artifact，查看 Markdown 与来源数据，导出到 Obsidian。
- 任务：运行每日流程、同步 Obsidian、抓取 arXiv、缓存全文、生成报告，查看任务历史和报告队列。
- 设置：配置数据库可见状态、Obsidian、arXiv、RAG、LLM provider、模型路由、调度策略和本地路径选择。

## 每日流水线

`run-daily` 是系统的核心任务。当前 worker 按阶段记录进度，失败后可恢复或重试：

1. 同步上下文来源：本地/远端 Obsidian、项目笔记、项目知识文档。
2. 抓取 arXiv：按分类、回看天数和结果上限导入论文元数据。
3. 构建每日快照：记录本次运行要处理的论文集合。
4. 缓存全文：下载 PDF，用 PyMuPDF 提取 TXT。
5. 全局排序：用 embedding、关键词、首页等 searcher 匹配研究上下文。
6. 项目排序：把检索范围限制到项目关联上下文。
7. 项目判定：用 LLM 对“项目 × 论文 × 证据”生成结构化判断。
8. 同步推荐：生成项目论文推荐状态。
9. 论文报告：为推荐或手动触发的论文处理报告队列。
10. 归档零命中论文：降低后续噪音。
11. 生成日报 artifact：汇总指标、候选论文、风险和下一步动作。

常用命令：

```powershell
npm run run-daily
npm run sync-obsidian
npm run fetch-arxiv
npm run cache-arxiv-text
npm run generate-paper-reports
npm run generate-reports
```

恢复和重试可直接调用 worker：

```powershell
python -m worker.cli resume-daily --job-id 123
python -m worker.cli retry-daily
python -m worker.cli generate-paper-reports --limit 10
```

## 配置

复制 `.env.example` 为 `.env` 后再修改。`.env` 适合放本地启动级配置和非密钥 Docker Compose 插值；Docker 密码、token、session secret 应放到 `./secrets/*.txt`。Dashboard 保存的业务配置会写入数据库，并作为 `.env` 默认值之上的运行配置。

关键启动配置：

- `PORT`：Node 服务端口，默认 `3000`。
- `DATABASE_URL` / `DATABASE_URL_FILE`：PostgreSQL 连接串；设置后优先使用。
- `POSTGRES_HOST`、`POSTGRES_PORT`、`POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD` / `POSTGRES_PASSWORD_FILE`：未设置 `DATABASE_URL` 时使用的 PostgreSQL 连接参数；Docker Compose 会默认连接内置 PostgreSQL 17。
- `PYTHON_BIN`：仅在 `KRIS_JOB_BACKEND=cli` 回退或少量交互式 CLI fallback 时使用的 Python 命令。
- `KRIS_REQUEST_TIMING_LOG`：设为 `1`/`true` 时，Node 为每个普通 `/api/*` 请求输出 `KRIS_REQUEST_TIMING` 日志，包含 method、path、status、duration、worker command 和 response size。
- `KRIS_WORKER_TIMING_LOG`：设为 `1`/`true` 时，Python worker CLI 输出 `KRIS_WORKER_TIMING` 日志，包含 connect、init_db、stale cleanup、handler 和 total 耗时。
- `KRIS_STALE_JOB_CLEANUP_ENABLED` / `KRIS_STALE_JOB_CLEANUP_INTERVAL_MS`：控制 Node 启动后执行的 stale job cleanup 定时任务，默认启用且间隔 60000ms。
- `KRIS_WORKER_JOB_STALE_AFTER_SECONDS`：`worker_jobs.running` 的恢复阈值，默认 1800 秒；超时后 attempts 未耗尽会重排队，耗尽则失败并同步 `job_runs`。
- `KRIS_JOB_BACKEND`：任务执行后端，默认 `queue`。Node 会写入 `worker_jobs`，由 `python -m worker.service` 常驻 worker 执行；设为 `cli` 可临时回退旧的 Node spawn CLI 行为。
- `KRIS_OUTBOX_POLLER_ENABLED` / `KRIS_OUTBOX_POLL_INTERVAL_MS`：控制 Node 轮询 `app_events` outbox 并转发到 `/api/events`，默认启用且间隔 1000ms。Node 写接口和常驻 worker 的缓存失效事件都会写入 `app_events`；关闭 poller 时，Node 写接口会回退到进程内 SSE，worker 侧仍保留旧 stderr progress 兼容路径。
- `KRIS_WORKER_POLL_INTERVAL_MS` / `KRIS_WORKER_INIT_DB_ON_START`：控制常驻 Python worker 的队列轮询间隔和启动时 schema 初始化。
- `KRIS_READER_FOLLOWUPS_SYNC_FALLBACK_ENABLED`：控制 Reader 选中文本 follow-up questions 的同步交互式 CLI fallback，默认启用；设为 `false` 时该接口返回 `reader_followups_sync_fallback_disabled`，直到前端有异步建议结果流。
- Node 固定负责在线读写 API：settings、jobs summary/history、health summary、notifications、projects、artifacts、library、inbox、paper detail/feedback/recommendation、Reader 列表/详情/报告控制。Python worker 负责 heavy job 和 action job：daily pipeline、同步/抓取/排序、artifact export、Reader 导入/保存、报告生成、LLM/Obsidian 文件操作。Reader streaming chat 和可开关的 follow-up questions 仍是交互式 CLI fallback，不属于普通 CRUD/read 数据面。
- `KRIS_PG_POOL_MAX`、`KRIS_PG_IDLE_TIMEOUT_MS`、`KRIS_PG_CONNECTION_TIMEOUT_MS`：Node 侧 PostgreSQL 连接池参数。当前 schema 初始化仍由 `npm run init-db` / Python worker schema owner 负责。
- `PANEL_PASSWORD` / `PANEL_PASSWORD_FILE`：单密码保护；为空时无密码模式。
- `PANEL_SESSION_SECRET` / `PANEL_SESSION_SECRET_FILE`：session 签名密钥；长期部署应固定。
- `PANEL_COOKIE_SECURE`：HTTPS 访问时设为 `true`。
- `KRIS_AGENT_TOKEN` / `KRIS_AGENT_TOKEN_FILE`：外部实验报告 agent 的受限 token。

Obsidian：

- `OBSIDIAN_VAULT_PATH`：本地 vault 路径。
- `OBSIDIAN_INCLUDE_DIRS`、`OBSIDIAN_INCLUDE_TAGS`：扫描范围和标签过滤。
- `OBSIDIAN_PROJECT_CENTER_TAGS`：用于识别项目主页的标签组合。
- `OBSIDIAN_STORAGE_BACKEND`：`local`、`oss`、`s3` 或 `r2`。
- `OBSIDIAN_REMOTE_*`：远端对象存储 endpoint、region、bucket、prefix、凭证、镜像目录和输出前缀。OSS 使用阿里云 OSS 客户端；`s3` / `r2` 使用 S3-compatible API。
- 本地 Obsidian 可通过 [Remotely Save](https://github.com/remotely-save/remotely-save) 同步到 OSS/S3-compatible bucket，KRIS 再以远端模式读取同一个 bucket。
- 远端模式只在 `OBSIDIAN_REMOTE_OUTPUT_PREFIX` 下追加系统产物，不覆盖或删除已有 Obsidian 对象。
- 未来会提供更多外部笔记软件和知识库连接方式；当前推荐路径是 Obsidian + Remotely Save + OSS/S3-compatible storage。

arXiv 与 RAG：

- `ARXIV_CATEGORIES`、`ARXIV_DAILY_LOOKBACK_DAYS`、`ARXIV_MAX_RESULTS`：抓取范围。
- `ARXIV_CACHE_FULL_TEXT`、`ARXIV_PDF_DIR`、`ARXIV_TEXT_DIR`：全文缓存策略和目录。
- `RAG_SCORE_THRESHOLD`、`RAG_TOP_K`、`RAG_SEARCHERS`：证据检索和保留策略。
- `RAG_PREFILTER_*`：摘要级粗筛阈值、top-k、保底数量和上限。
- 向量能力默认走 PostgreSQL/pgvector 路径，无需单独配置 backend。

LLM provider 使用 OpenAI-compatible 接口配置。建议在 dashboard 设置页维护，也可用 `.env` 初始化默认值：

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

每日流程会在同步项目上下文后，按输入哈希增量生成完整的项目 Chat 摘要；只有项目资料或模型配置发生变化时才会再次请求模型。论文 Reader Chat 可由用户逐篇选择是否注入项目上下文；注入范围包含正式关联项目及 `pending` / `accepted` 推荐项目的完整摘要，不会另外生成短版 Chat 上下文。存在其中任意一种项目关系时开关即可用，全部不存在时开关保持禁用，后端也不会注入。`PROJECT_CHAT_PROFILE_*` 可指定该步骤使用的 provider 和模型；留空时会回退到默认 `LLM_CHAT_*`，未配置可用模型时该步骤只会跳过，不会阻断论文抓取和匹配。

Reader Chat 还支持为当前论文持久化选择最多 3 篇参考论文。选择器只允许加入已经完成 TXT 提取的论文，不展示 token 估算，也不对组合后的总输入做额外裁剪。消息按 `当前论文全文 → 参考论文全文 → 已有报告 → 项目摘要 → 历史对话` 组织，并在助手消息中记录实际使用的参考论文 ID。

未配置 LLM provider 时，系统仍可初始化数据库、同步 Obsidian、抓取 arXiv、缓存全文和保存反馈；embedding、LLM 判定、报告生成或对话会跳过、失败或使用有限的本地说明，取决于具体功能。

## API 和集成

`server.js` 不使用 Express；Node 常驻 API 直接读写 PostgreSQL 并负责认证、SSE、缓存失效、在线 CRUD/read 和 `worker_jobs` enqueue。Python worker service 处理重任务/action job，完成后通过 `app_events` outbox 让 Node 转发缓存失效事件。主要 API 类别包括：

- 认证：`/api/auth/status`、`/api/auth/login`、`/api/auth/logout`
- 项目：项目列表、详情、保存、Obsidian 导出、项目索引、关联论文/笔记
- 设置和健康：`/api/settings`、`/api/health`、`/api/local-path/select`
- 任务：scheduler、startup daily、run/resume/retry daily、单项 worker 任务、任务历史
- 论文：inbox、library、paper detail、feedback、recommendation、report queue
- Reader：PDF/URL 导入、PDF 服务、streaming chat、保存 Obsidian、follow-up questions
- Artifacts：列表、详情、导出 Obsidian
- 外部实验报告：`GET /api/projects` 和 `POST /api/experiments/reports`

外部 agent 只能通过 `x-experiment-agent-token: <KRIS_AGENT_TOKEN>` 访问项目列表和实验报告上报接口，不会获得完整 dashboard API 权限。

### 外部实验报告 Agent

KRIS 提供一个受限接入口，方便 Codex、Claude Code 或手工脚本把实验进展写回指定项目：

- `GET /api/projects`：读取项目列表，供 agent 选择 `project_id`。
- `POST /api/experiments/reports`：上报实验报告。

这两个接口可以用 `x-experiment-agent-token: <KRIS_AGENT_TOKEN>` 认证；该 token 只放开这两个 agent 接口，不会放开完整 dashboard API。`KRIS_AGENT_TOKEN` 为空时，外部 agent 入口等同关闭。

请求示例：

```powershell
$headers = @{ "x-experiment-agent-token" = $env:KRIS_AGENT_TOKEN }
$body = @{
  project_id = 1
  title = "RAG reranker ablation"
  markdown = "## 本次任务`n`n对 reranker 配置做消融实验。"
  report_json = @{
    task_summary = "测试 reranker 配置"
    results = @("保存实验结果", "更新项目上下文")
    next_actions = @("扩大样本")
  }
  source_agent = "codex"
  idempotency_key = "workspace-a:ragrerank:2026-05-23"
  metadata = @{ workspace = "D:/coding/project-a" }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/experiments/reports" -Headers $headers -ContentType "application/json" -Body $body
```

Payload 约束：

- `project_id`：必填，正整数，必须指向已有项目。
- `title`：必填，最多 240 字符。
- `markdown`：必填，最多 200000 字符，作为 artifact 正文和项目上下文来源。
- `report_json`：必填对象，保存结构化实验摘要。
- `source_agent`：可选，默认 `manual`；允许值为 `codex`、`claude-code`、`manual`。
- `idempotency_key`：必填，最多 240 字符；相同 key 会更新同一份实验报告，而不是重复创建。
- `metadata`：可选对象，用于保存 workspace、commit、run id 等调用方上下文。

写入成功后，KRIS 会创建或更新一个 `experiment_report` artifact，同时写入项目知识文档，relation 为 `experiment_progress`，后续项目上下文检索和论文匹配会读到这份实验进展。若已配置 Obsidian，本次实验报告会尝试导出到项目输出目录；导出失败不会阻断报告入库。

## Docker Compose

默认发布镜像是 `exde1968/kardashev-research-intelligence-system:latest`。仓库内的 [docker-compose.yml](docker-compose.yml) 默认拉取该镜像，并启动 PostgreSQL 17：

- `db`：`pgvector/pgvector:pg17`，数据在 named volume `pgdata17`。
- `app`：Node 22 + Python venv，启动时先执行 `python -m worker.cli init-db`，再运行 `node server.js`。
- `worker`：与 app 使用同一镜像，运行 `python -m worker.service`，消费 `worker_jobs` 并写入 `app_events` outbox。
- `./data:/data`：PDF/TXT 缓存、远端 Obsidian 镜像等文件数据。
- 密钥只以 `_FILE` 路径形式注入容器；非密钥配置仍通过环境变量传入。

准备：

```powershell
Copy-Item .env.example .env
New-Item -ItemType Directory -Force secrets
Set-Content -NoNewline secrets/postgres_password.txt "replace-with-db-password"
Set-Content -NoNewline secrets/panel_password.txt "replace-with-panel-password-or-empty"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | Set-Content -NoNewline secrets/panel_session_secret.txt
Set-Content -NoNewline secrets/kris_agent_token.txt "replace-with-agent-token-or-empty"
```

启动：

```powershell
docker compose up -d
```

更新到 Docker Hub 上最新的 `latest` 镜像：

```powershell
docker compose pull app
docker compose up -d app
```

Dashboard 会定期检查 GitHub 版本 tag/release。发现新版本时，首页“通知”会显示统一的更新提醒，并提供三个弹窗：查看更新说明、复制源码更新命令、复制 Docker 更新命令。默认检查仓库为 `exde1968/kardashev-research-intelligence-system`；如需关闭或改仓库，可在 `.env` 中设置：

```env
KRIS_UPDATE_CHECK_ENABLED=true
KRIS_UPDATE_REPOSITORY=exde1968/kardashev-research-intelligence-system
```

如果需要固定部署某个版本或回滚，把 `.env` 里的 `KRIS_IMAGE` 改成对应 tag，例如：

```env
KRIS_IMAGE=exde1968/kardashev-research-intelligence-system:sha-abc1234
```

访问 `http://localhost:3000`，或按 `.env` 中的 `APP_HOST_PORT` 访问。`panel_password.txt` 为空时保持无密码模式；`kris_agent_token.txt` 为空时关闭外部实验报告上报。

如果容器需要访问本地 Obsidian vault，在 `docker-compose.yml` 中挂载 vault，并把 `OBSIDIAN_VAULT_PATH` 设置为容器内路径，例如 `/vault`。

## Docker Hub 自动构建

仓库内的 [.github/workflows/dockerhub.yml](.github/workflows/dockerhub.yml) 会在 GitHub Actions 中构建 Dockerfile，并把镜像推送到 Docker Hub。首次使用前，在 GitHub 仓库的 `Settings` -> `Secrets and variables` -> `Actions` -> `Secrets` 中添加：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名。
- `DOCKERHUB_TOKEN`：Docker Hub access token。

触发规则：

- push 到 `main`：构建并推送 `latest`、`main` 和 `sha-*` tag。
- push `v*.*.*` tag：构建并推送对应版本 tag、`major.minor` tag 和 `sha-*` tag。
- pull request：只验证镜像能否构建，不推送到 Docker Hub。

## Nginx HTTPS

可选的 `nginx` profile 会把 HTTP 重定向到 HTTPS，并反代到内部 `app:3000`。准备证书：

```text
deploy/nginx/certs/fullchain.pem
deploy/nginx/certs/privkey.pem
```

在 `.env` 中设置：

```env
PANEL_COOKIE_SECURE=true
APP_HOST_BIND=127.0.0.1
NGINX_SERVER_NAME=research.example.com
```

启动：

```powershell
docker compose --profile nginx up -d
```

`APP_HOST_BIND=127.0.0.1` 用于避免宿主机公网网卡继续直接暴露 app 的 `3000` 端口。

## 脚本速查

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite dev server |
| `npm run build` | 构建前端到 `dist/` |
| `npm run preview` | 预览构建产物 |
| `npm start` | 构建前端并启动 Node 服务和常驻 Python worker |
| `npm run start:api` | 只启动 Node API/static 服务 |
| `npm run init-db` | 初始化或迁移当前数据库 schema |
| `npm run sync-obsidian` | 同步 Obsidian/项目上下文 |
| `npm run fetch-arxiv` | 抓取 arXiv 并缓存粗筛后的全文 |
| `npm run cache-arxiv-text` | 为已入库论文补缓存 PDF/TXT |
| `npm run generate-paper-reports` | 处理论文全文报告队列 |
| `npm run generate-reports` | 生成日报 artifact |
| `npm run run-daily` | 执行完整每日流水线 |
| `npm run test` | 运行 Python unittest 和 Node helper 测试 |
| `npm run test:python` | 只运行 Python unittest |
| `npm run test:node` | 只运行 Node helper 测试；`TEST_DATABASE_URL` 未设置时会跳过 PostgreSQL smoke test |
| `npm run check` | Node 语法检查、Node helper/event/settings/jobs/health 测试、前端构建、Python compileall |

## 验证

```powershell
npm run test
npm run check
```

`npm run test` 会执行 `python -m unittest discover -s tests` 和 `node --test tests/node/*.test.js`。`npm run check` 会检查 `server.js`、`server/env.js`、`server/db.js`、`server/events.js`、`server/settings.js`、`server/jobs.js`、`server/health.js`，运行 Node helper/event/settings/jobs/health 测试，构建前端，并执行 `python -m compileall worker tests`。如需让 Node PostgreSQL smoke test 连接测试库，设置 `TEST_DATABASE_URL`；不要把它指向开发或生产库。

## 常见问题

- `python` 不在 PATH：激活虚拟环境，或在 `.env` 设置 `PYTHON_BIN`。
- 登录状态重启后失效：设置固定的 `PANEL_SESSION_SECRET` 或 `PANEL_SESSION_SECRET_FILE`。
- Docker 中看不到本地 Obsidian：需要把 vault mount 到容器，并使用容器内路径。
- 报告或聊天失败：检查 LLM provider 是否有 API key、base URL、模型名，以及 `PAPER_REPORT_*` / `READER_*` 模型路由。
- 每日流程中断：查看“任务”页或 `/api/jobs/history`，再使用 `resume-daily` 或 `retry-daily`。

## License

AGPL-3.0-only。详见 [LICENSE](LICENSE)。
