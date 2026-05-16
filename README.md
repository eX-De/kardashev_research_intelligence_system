# 科研情报系统

这是一个本地运行的科研信息自动化 dashboard MVP。主界面是“项目中心”，但 Obsidian 才是人类可读信息中心：dashboard 负责配置、调度、监控和少量确认，论文卡片、项目索引、实验记录整理等可读内容应写回 Obsidian。

- 前端使用 Vite + React；Node 提供 API 服务，并在普通使用模式下托管构建后的前端静态文件。
- Python worker 负责数据库、Obsidian 导入、arXiv 抓取、PDF 转 TXT、正文分段匹配、相关性排序和解释生成。
- SQLite 数据库默认位于 `./data/research_intelligence.sqlite`；设置 `DATABASE_URL` 后可切换到 PostgreSQL。
- Obsidian vault 是最终输出位置。系统会按项目配置写入自动生成的 Markdown，例如项目索引；导入流程仍只读取用户已有笔记。

## 快速开始

1. 复制 `.env.example` 为 `.env`。`PORT`、`APP_DB_PATH`、`PYTHON_BIN` 这类启动级配置保留在 `.env` 中。
2. 初始化数据库：

```bash
npm run init-db
```

3. 普通使用模式启动 dashboard：

```bash
npm start
```

4. 打开 `http://localhost:3000`，默认进入“项目中心”。第一次使用时先进入“配置与任务”：
   - 配置 Obsidian vault、扫描文件夹、标签、arXiv 分类、RAG 阈值和模型。
   - 点击“保存配置”。
   - 点击“立即执行每日流程”生成当天推荐；每日流程会先同步 Obsidian，再抓取和整理论文。
   - 可以选择“每日首次启动 dashboard 时执行”，或点击“启动定时任务”按配置时间周期执行 `run-daily`。两种模式互斥，执行内容相同。

每日流程由 dashboard 所在的 Node 进程触发。关闭 `npm start` 后，dashboard 和调度都会停止；下次启动时，如果启用了“每日首次启动 dashboard 时执行”，系统会检查当天是否已有成功的 `run-daily`，没有才自动补跑一次。如果启用了定时任务，则按配置时间恢复调度。

## 启动方式

### 普通使用模式

普通使用模式只需要一个命令：

```bash
npm start
```

它会先执行 Vite 构建，再启动 `server.js`。访问地址：

```text
http://localhost:3000
```

### 开发模式

开发模式需要两个终端。第一个终端启动 API server：

```bash
npm run start:api
```

第二个终端启动 Vite React dev server：

```bash
npm run dev
```

访问地址：

```text
http://localhost:5173
```

开发模式下，Vite 会把 `/api` 请求代理到 `http://localhost:3000`。

## Dashboard 功能

- 项目中心：默认主界面，只保留全局运行概览、提醒、项目列表和新建入口；项目特定配置与关联信息进入单独项目页。
- 论文推荐：展示进入推荐池的 arXiv 论文，按相关性排序。Inbox 只是候选入口，不是系统主界面。
- 论文详情：展示摘要、arXiv 链接、命中的 arXiv 正文段、Obsidian 证据片段、解释和标注按钮。
- Obsidian 同步：项目详情可以把项目索引同步到 Obsidian，减少手写项目维护文本。
- 配置与任务：保存系统配置，启动/停止定时任务，立即执行每日流程。`run-daily` 的第一步是同步 Obsidian。
- 健康状态：显示数据库、Obsidian vault、LLM provider、索引数量和最近任务状态。
- 任务历史：显示最近 worker 执行记录、状态、时间和结果摘要。

## CLI 调试命令

```bash
npm run run-daily
npm run fetch-arxiv
npm run cache-arxiv-text
npm run generate-reports
npm run sync-obsidian
```

这些命令不是常驻服务，而是一次性 worker 任务：

- `npm run run-daily`：完整每日流程，依次同步 Obsidian、抓取 arXiv、摘要粗筛、缓存通过粗筛的 PDF/TXT、匹配论文、生成解释和每日总报告。
- `npm run fetch-arxiv`：抓取 arXiv 元数据，并按摘要粗筛结果缓存 PDF/TXT，适合补抓或调试。
- `npm run cache-arxiv-text`：显式补缓存命令，会对已入库且未完成全文缓存的论文下载 PDF，并用 PyMuPDF 提取 TXT。
- `npm run generate-reports`：生成一篇 Obsidian Markdown 每日总报告，汇总当天流程指标、项目候选论文、全局推荐论文、风险和下一步动作。
- `npm run sync-obsidian`：只刷新 Obsidian 研究画像索引。

## 开发验证命令

```bash
npm run test
npm run check
```

## 配置说明

启动级配置在 `.env.example` 中：

- `PORT`：dashboard 监听端口。
- `APP_DB_PATH`：SQLite 数据库路径。
- `DATABASE_URL`：PostgreSQL 连接串；留空时使用 SQLite，例如 `postgresql://research_app:password@localhost:5432/research_intelligence`。
- `PYTHON_BIN`：Node 调用 Python worker 的命令。

## PostgreSQL 迁移

先停止 dashboard/API server，避免迁移时 SQLite 仍在写入。确认目标 PostgreSQL 数据库为空或可以重建后执行：

```powershell
$env:DATABASE_URL="postgresql://research_app:password@localhost:5432/research_intelligence"
python migrate_sqlite_to_postgres.py --reset
```

迁移脚本会在目标库创建 schema、导入 SQLite 数据、校验每张表行数并重置自增序列。迁移完成后，把同一个 `DATABASE_URL` 写入 `.env` 并重启 dashboard，即可让 worker 使用 PostgreSQL。

业务配置可以在 dashboard 的“配置与任务”里修改：

- `OBSIDIAN_VAULT_PATH`：Obsidian vault 路径。
- 路径输入框支持手动输入，也可以点击“选择”由本地 Node 服务打开 Finder / 系统文件选择器；选择 vault 本身不需要先保存配置，项目主页和输出目录会优先按当前表单里的 vault 转成相对路径。
- `OBSIDIAN_INCLUDE_DIRS`：需要扫描的文件夹，例如 `Research,Papers`。
- `OBSIDIAN_INCLUDE_TAGS`：需要纳入研究画像的标签，例如 `research,paper,direction`。
- `OBSIDIAN_PROJECT_CENTER_TAGS`：项目中心页必须同时具备的标签组合。匹配的 Markdown 会被识别为项目中心页，它所在的父文件夹会作为项目文件夹。
- `ARXIV_CATEGORIES`：每日抓取的 arXiv 分类，例如 `cs.AI,cs.CL,cs.IR`。
- `ARXIV_CACHE_FULL_TEXT`：是否下载 arXiv PDF 并提取 TXT。每日流程和 `fetch-arxiv` 只会缓存摘要粗筛通过或保底保留的论文；手动 `cache-arxiv-text` 会显式补缓存已入库论文。
- `ARXIV_PDF_DIR`、`ARXIV_TEXT_DIR`：PDF 缓存目录和 TXT 输出目录。
- `RAG_SCORE_THRESHOLD`：进入 inbox 的相关性阈值。
- `RAG_TOP_K`：每篇论文保留的证据 chunk 数量。
- `RAG_PREFILTER_ENABLED`：是否先用论文标题 + 摘要 embedding 做粗筛。
- `RAG_PREFILTER_THRESHOLD`：粗筛通过阈值，默认偏宽松。
- `RAG_PREFILTER_TOP_K`：粗筛时参与评分的 Obsidian chunk 数量。
- `RAG_PREFILTER_MIN_KEEP`：每天即使低于阈值也保底进入精排的论文数量。
- `RAG_PREFILTER_MAX_KEEP`：每天最多进入精排的论文数量，`0` 表示不限制。
- `RUN_DAILY_ON_STARTUP_ENABLED`：dashboard 每日首次启动时是否自动执行 `run-daily`。
- `SCHEDULER_ENABLED`、`SCHEDULER_RUN_TIME`、`SCHEDULER_INTERVAL_HOURS`：dashboard 定时任务默认值。`RUN_DAILY_ON_STARTUP_ENABLED` 与 `SCHEDULER_ENABLED` 互斥。
- `LLM_PROVIDERS_JSON`、`LLM_CHAT_PROVIDER_ID`、`LLM_CHAT_MODEL`、`LLM_EMBEDDING_PROVIDER_ID`、`LLM_EMBEDDING_MODEL`：LLM provider 默认值。日常建议直接在 dashboard 中配置多个 provider 和模型。

dashboard 保存的业务配置会写入 SQLite，并覆盖 `.env` 中的对应默认值。启动级配置不会暴露在 dashboard，需要改 `.env` 并重启。

项目配置保存在 SQLite，但可读内容以 Obsidian 为准。项目中心只显示列表，单独项目页负责这些项目特定信息：

- `obsidian_project_path`：项目主页 Markdown 路径，例如 `Projects/Agentic RAG.md`。
- `obsidian_output_dir`：自动生成论文卡片、综述、实验记录整理结果的输出目录。
- 项目页可修改项目名、状态、关键词、Obsidian 项目主页和输出目录。
- 项目页可查看候选论文、项目证据、生成产物，并手动关联或移除论文/笔记。

dashboard 不再把“项目摘要/目标/备注”作为主要手写输入。项目状态、论文集合、笔记集合和自动化结果由系统维护；需要人阅读和编辑的内容落在 Obsidian Markdown 中。

项目可以从 Obsidian 自动识别：在设置里配置“项目中心页标签组合”，例如 `project,center`。同步 Obsidian 时，所有同时包含这些标签的 Markdown 会成为项目中心页；它的父文件夹就是项目文件夹，文件夹内已索引的 Markdown 会自动关联为项目上下文。项目状态使用 Obsidian 标签 `Status/进行中`、`Status/已完成`、`Status/搁置`、`Status/计划中`。如果中心页已经有状态标签，dashboard 会按该标签显示；在 dashboard 修改状态时，会写回中心页 frontmatter 的 `tags`。

PDF 正文提取依赖 PyMuPDF，依赖写在 `requirements.txt`。提取出的 TXT 路径会写入 SQLite 的 `arxiv_papers.text_path`，PDF 路径会写入 `arxiv_papers.pdf_path`。在每日流程中，系统会先做 `title + abstract` 粗筛，再只对粗筛通过或 `RAG_PREFILTER_MIN_KEEP` 保底保留的论文做 PDF/TXT 缓存。

arXiv 正文会切成 `arxiv_text_chunks` 后逐段匹配 Obsidian 的 `research_chunks`。`matches` 表会记录最佳命中的 `arxiv_chunk_id` 和 Obsidian `chunk_id`，因此 dashboard 可以展示“论文哪一段/哪一页”匹配到了“哪条个人研究笔记”。

项目级论文匹配会把检索范围限制在该项目自动关联的 Obsidian 笔记 chunk 中，结果写入 `project_paper_matches`。RRF 分数只用于证据排序，`quality_score` 用于便宜过滤；随后系统对通过过滤的 `项目 × 论文` 生成项目级判定，写入 `project_paper_judgments`。项目详情页会显示项目候选论文、命中分数、论文/项目证据片段和判定结果。

每日流程最后会生成一篇每日总报告，写入 `Research Intelligence/Daily/YYYY-MM-DD.md`。报告只读取通过项目级判定的项目候选论文，汇总当天流程指标、风险/不确定点和下一步动作；不再为每个“项目 × 论文”生成单篇用途报告。

如果配置了 embedding provider 和 embedding model，系统会为 arXiv 正文段生成 embedding，并写入 `arxiv_chunk_embeddings`。后续重跑 ranking 时会优先复用缓存，避免对同一个 arXiv chunk 重复请求 embedding API。

ranking 采用两阶段流程：先用论文 `title + abstract` 的 embedding 做 paper-level 粗筛，并把分数、rank、通过原因写入 `paper_prefilter_runs`；通过粗筛或进入 `RAG_PREFILTER_MIN_KEEP` 保底集合、且未超过 `RAG_PREFILTER_MAX_KEEP` 上限的论文，才下载 PDF/TXT 并进入正文 chunk-level 精排。这样能减少全文下载、分段和匹配成本，同时避免固定阈值误杀当天的潜在相关论文。

没有配置 LLM provider API key 时，系统仍然可以完成 arXiv 抓取、PDF/TXT 缓存、Obsidian 解析、关键词排序和反馈持久化。embedding 和 LLM 解释会跳过，或使用仅基于证据片段的本地说明代替。
