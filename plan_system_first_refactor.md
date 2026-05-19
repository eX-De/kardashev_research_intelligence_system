# 系统内论文仓库与产物层改造计划

日期：2026-05-17

## 背景

当前系统最早围绕“Obsidian 是人类可读信息中心”设计，Dashboard 主要负责配置、调度、监控和少量确认。经过后续演进，系统已经具备项目中心、项目级论文匹配、全文报告、论文阅读器、日报、报告队列等能力，但几个核心概念开始混在一起：

- Obsidian 同时承担知识来源、项目发现、项目上下文、导出目标。
- `paper_reading_reports` 既是全文报告存储，又被前端当成论文阅读队列。
- `arxiv_papers` 更像抓取候选池，不是完整论文仓库。
- `project_artifacts` 只保存产物元数据和 Obsidian 路径，不保存产物正文。
- 每日报告和项目索引仍偏向直接写 Obsidian，而不是先落到系统内部。

新的目标是把系统改成“系统内一等对象优先，Obsidian/Markdown 只是可选集成”：

- 项目上下文是核心能力，但来源可以是手动输入、Obsidian、Markdown 或上传文件。
- 论文仓库是长期保存和阅读论文的主入口，报告队列只是任务队列。
- 所有生成产物先保存到系统内，再按需导出到 Obsidian 或本地 Markdown。
- 前端按核心对象组织：项目、论文、产物、任务、设置。

## 产品原则

1. 系统内数据是主状态源。
2. Obsidian 是可选知识来源和可选导出目标，不是初始化强依赖。
3. 论文推荐、论文仓库、报告队列分离。
4. 产物是系统内一等对象，不只是文件路径。
5. 项目上下文必须保留用户原始表达，不强迫用户按固定模板组织项目。
6. 手动项目也必须能参与完整推荐流程。
7. 任务历史需要记录执行结果和失败原因。

## 目标信息架构

左侧导航建议调整为：

- 首页
- 项目
- 论文仓库
- 推荐
- 产物
- 任务
- 设置

各页面职责：

- 首页：今日状态、待处理事项、最近产物、失败任务、配置健康。
- 项目：项目上下文、候选论文、项目论文库、项目产物。
- 论文仓库：长期保存论文，管理阅读状态、标签、项目关联和报告。
- 推荐：处理系统推荐来的候选论文，不承担长期保存职责。
- 产物：全局搜索、筛选、归档系统生成内容。
- 任务：每日流程、报告队列和任务历史。
- 设置：系统、模型、论文源、调度、知识来源、导出目标。

## 后端数据模型计划

### 1. 知识文档与项目上下文

本次重构直接采用长期模型，不再用 `obsidian_notes` 承载通用知识库。

核心表：

```sql
knowledge_documents(
  id,
  source_type,
  source_uri,
  title,
  raw_content,
  content_hash,
  metadata_json,
  indexed_at,
  created_at,
  updated_at
)

research_chunks(
  id,
  document_id,
  chunk_index,
  heading,
  text,
  token_count,
  source,
  created_at
)

project_context_documents(
  project_id,
  document_id,
  relation,
  weight,
  created_at,
  updated_at
)
```

`source_type` 建议：

- `manual_project`
- `obsidian`
- `markdown_upload`
- `paper_note`
- `artifact`

项目上下文不要求固定结构。用户可以输入一段自由文本、粘贴 README、放一组 Markdown、导入 Obsidian 项目文件夹，系统只负责保存原文和切块。

推荐的项目上下文模型：

```text
原始层：用户输入或外部文档原文
索引层：research_chunks + embeddings
```

### 2. 论文仓库

本次重构直接建立论文仓库长期模型，不再把 `arxiv_papers` 扩展成所有论文的主表。

```sql
papers(
  id,
  canonical_key,
  title,
  authors_json,
  abstract,
  published_at,
  updated_at,
  year,
  venue,
  doi,
  arxiv_id,
  library_status,
  reading_state,
  user_tags_json,
  user_note,
  saved_at,
  last_read_at,
  created_at,
  updated_at
)

paper_sources(
  id,
  paper_id,
  source_type,
  source_identifier,
  source_url,
  metadata_json,
  fetched_batch_id,
  created_at,
  updated_at
)

paper_assets(
  id,
  paper_id,
  asset_type,
  path,
  url,
  status,
  error_message,
  metadata_json,
  created_at,
  updated_at
)

paper_chunks(
  id,
  paper_id,
  asset_id,
  chunk_index,
  source,
  page_start,
  page_end,
  text,
  token_count,
  char_count,
  created_at
)
```

`library_status` 值：

- `candidate`
- `saved`
- `reading`
- `read`
- `archived`
- `discarded`

`source_type` 值：

- `arxiv`
- `url`
- `upload`
- `manual`

迁移时把现有 `arxiv_papers` 作为 arXiv source 导入 `papers` 和 `paper_sources`，PDF/TXT 路径进入 `paper_assets`，正文分块进入 `paper_chunks`。

### 3. 系统内产物

本次重构直接新增统一 artifact 模型，不再继续扩展 `project_artifacts` 作为主表。

```sql
artifacts(
  id,
  scope_type,
  scope_id,
  artifact_type,
  title,
  content_markdown,
  content_json,
  status,
  source_json,
  model_provider_id,
  model,
  input_hash,
  created_at,
  updated_at
)
```

产物类型建议：

- `daily_report`
- `paper_report`
- `project_index`
- `project_digest`
- `literature_review`
- `reading_note`
- `next_actions`
- `chat_summary`

现有 `paper_reading_reports` 和 `project_artifacts` 迁移到 `artifacts`，不再作为新功能主状态源。

## 后端流程改造

### 1. 初始化流程

把初始化拆成两层：

- 系统初始化：建库、检查 `data/`、检查 Python/Node 依赖。
- 产品初始化：创建第一个项目上下文或从来源导入项目。

首次打开时提供两种入口：

- 从 Obsidian 自动识别项目。
- 手动创建第一个项目。

### 2. 每日流程

当前流程：

```text
sync_obsidian
fetch_arxiv
snapshot
cache_text
rank_global
rank_project
judge
recommend
paper_reports
archive_zero_match
daily_report_to_obsidian
```

目标流程：

```text
sync_context_sources
fetch_arxiv
snapshot
cache_text
rank_global
rank_project
judge
recommend
paper_reports
archive_zero_match_if_context_available
generate_daily_report_artifact
export_enabled_artifacts
```

`sync_context_sources` 包含：

- `sync_project_context_documents`
- `sync_obsidian`，仅在 Obsidian 启用并配置 vault 时执行
- Markdown 上传资料

### 3. 手动项目适配

保存项目后：

1. 写入 `research_projects`。
2. 保存用户原始上下文为 `knowledge_documents(source_type='manual_project')`。
3. 切分成 `research_chunks`。
4. 生成 embedding。
5. 关联到 `project_context_documents`。

这样手动项目可以直接参与：

- `rank_project_papers`
- `generate_missing_project_judgments`
- `sync_project_paper_recommendations`
- 日报和项目产物生成

### 4. Obsidian 可选化

需要调整的强依赖：

- `run-daily` 不再固定要求 `sync_obsidian` 成功。
- `generate_daily_report` 不再要求 `obsidian_vault_path`。
- `export_project_to_obsidian` 拆成“生成项目索引产物”和“导出到 Obsidian”。
- 接受论文后先更新系统内状态，再按需同步到 Obsidian。
- `save_reader_note_to_obsidian` 改成 `save_reader_note`，Obsidian 是可选导出目标。

### 5. 论文仓库流程

推荐论文进入系统：

```text
arXiv fetch -> library_status = candidate
```

用户接受推荐：

```text
candidate -> saved 或 reading
写 project_papers
保留 project_paper_recommendations 状态
```

用户导入 PDF/URL：

```text
source_type = upload/url
library_status = saved
缓存 PDF/TXT
生成全文报告任务
```

阅读完成：

```text
reading -> read
last_read_at = now
```

丢弃：

```text
candidate/saved -> discarded
```

`archive_zero_match_papers` 必须跳过：

- `library_status IN ('saved', 'reading', 'read')`
- 已有关联项目
- 用户反馈存在
- 已有系统内产物

### 6. 产物生成流程

所有生成函数都应先落库：

```text
generate_xxx()
  -> generate markdown/json
  -> insert/update artifacts
  -> return artifact_id
```

导出变成单独动作：

```text
export_artifact(artifact_id, target='obsidian')
```

优先改造：

- 每日报告：从写 Obsidian 改成写 `artifacts`。
- 项目索引：从 `export_project_to_obsidian` 改成生成 `project_index` artifact。
- 论文全文报告：迁移到 `artifacts(scope_type='paper', artifact_type='paper_report')`。

## 前端组织计划

### 1. 首页

保留轻量工作台，不承载深层管理。

显示：

- 今日流程状态。
- 待判断推荐数量。
- 报告队列状态。
- 最近产物。
- 最近保存论文。
- 配置健康状态。

### 2. 项目页

项目详情改成 tabs：

- 概览
- 上下文
- 候选论文
- 论文库
- 产物
- 集成/导出

`ObsidianPanel` 拆成：

- `ProjectArtifactsPanel`
- `ExportTargetsPanel`
- `ProjectContextSourcesPanel`

### 3. 论文仓库页

新增 `PaperLibraryView`。

支持：

- 状态筛选：候选、已保存、阅读中、已读、归档、已丢弃。
- 项目筛选。
- 来源筛选：arXiv、URL、上传、手动。
- 报告状态筛选。
- 标签和关键词搜索。

点击论文进入 `PaperDetailView`。

### 4. 论文详情页

从当前 `ReaderView` 拆出：

- `PaperOverviewPanel`
- `PaperTextPanel`
- `PaperReportPanel`
- `PaperProjectRelationsPanel`
- `PaperChatPanel`
- `PaperArtifactsPanel`
- `PaperMetadataPanel`

当前 `ReaderView` 不再同时承担仓库列表和队列管理。

### 5. 推荐页

`InboxView` 只负责待判断流。

操作：

- 保存到论文仓库。
- 关联项目。
- 稍后读。
- 丢弃。
- 生成报告。

### 6. 产物页

新增全局 `ArtifactsView`。

支持：

- 类型筛选。
- 项目筛选。
- 论文筛选。
- 日期筛选。
- 状态筛选。
- 全文搜索。

`ArtifactDetailView` 展示：

- Markdown 正文。
- 关联项目/论文。
- 来源输入。
- 模型信息。
- 更新时间。

### 7. 任务页

保留任务页，聚焦每日流程和报告队列状态。

包含：

- 每日流程状态。
- 报告生成队列。
- 历史任务。

### 8. 设置页

设置分组改成：

- 系统
- 模型
- 论文源
- 调度
- 知识来源
- 导出目标

Obsidian 放到：

- 知识来源：Obsidian 导入。
- 导出目标：Obsidian 导出。

## 路由建议

```text
/dashboard

/projects
/projects/:id
/projects/:id/context
/projects/:id/recommendations
/projects/:id/papers
/projects/:id/artifacts

/library
/library/:paperId

/inbox

/artifacts
/artifacts/:artifactId

/tasks

/settings
/settings/models
/settings/sources
/settings/exports
/settings/scheduler
```

## 实施阶段

### Phase 1：长期数据模型地基

目标：先建立长期模型，避免在旧表上继续叠加过渡补丁。

任务：

- 新增 `knowledge_documents`、`project_context_documents`、新版 `research_chunks`。
- 新增 `papers`、`paper_sources`、`paper_assets`、`paper_chunks`。
- 新增 `artifacts`。
- 设计迁移脚本，把现有 `obsidian_notes`、`arxiv_papers`、`arxiv_text_chunks`、`paper_reading_reports`、`project_artifacts` 迁移到新模型。

验收：

- 新模型能完整表达现有数据。
- 现有 SQLite 数据可迁移并通过行数、关键字段和关联完整性校验。
- 新增数据默认写入新模型，不再以旧表作为主状态源。

### Phase 2：项目上下文与知识来源

目标：项目上下文不依赖 Obsidian，也不要求固定结构。

任务：

- 新增手动项目原始上下文编辑和保存能力。
- 保存自由文本、粘贴 Markdown、上传 Markdown 时写入 `knowledge_documents`。
- Obsidian 同步改为写入 `knowledge_documents(source_type='obsidian')`。
- `sync_context_sources` 统一调度所有启用的知识来源。
- 搜索、项目详情、报告生成改用中性字段名，不再使用 `obsidian_text` 作为通用概念。

验收：

- 只创建手动项目、不配置 Obsidian，也能生成项目级推荐。
- Obsidian 项目中心标签识别能力仍可用。
- 项目推荐证据能显示来源类型和来源标题，而不是固定显示 Obsidian note。

### Phase 3：论文仓库

目标：把长期论文管理从报告队列中拆出来。

任务：

- 迁移 `arxiv_papers` 到 `papers` 和 `paper_sources`。
- 迁移 PDF/TXT 路径到 `paper_assets`。
- 迁移正文块到 `paper_chunks`。
- 新增论文仓库接口。
- 新增 `PaperLibraryView`。
- Inbox 接受/保存动作写入论文仓库状态。
- Reader 页面只负责单篇阅读和报告，不再作为论文仓库入口。

验收：

- 可以按状态查看论文。
- 导入 PDF/URL 后默认进入已保存。
- 报告队列不再承担论文仓库职责。
- `archive_zero_match_papers` 不会删除已保存、阅读中或已读论文。

### Phase 4：系统内产物落库

目标：日报、项目索引、项目摘要、论文全文报告等产物先落入系统。

任务：

- 每日报告写入 `artifacts`。
- 项目索引生成写入 `artifacts`。
- 论文全文报告写入 `artifacts(scope_type='paper')`。
- 产物详情接口返回 Markdown 正文和关联对象。
- Obsidian 导出改成 artifact export。

验收：

- 无 Obsidian 时也能生成并查看日报。
- 项目页能查看项目产物正文。
- 论文详情能查看论文报告 artifact。
- Artifact 可以导出到 Obsidian，但不依赖 Obsidian。

### Phase 5：前端信息架构重组

目标：页面职责清晰，核心对象一等化。

任务：

- 新增 Dashboard、PaperLibrary、Artifacts、Tasks 页面。
- 项目详情改为 tabs。
- ReaderView 拆分成 PaperDetail 相关组件。
- ReportQueue 独立展示报告任务状态。
- 设置页重组为 sources/exports/scheduler/models。

验收：

- 用户能从项目、论文、任务、产物四个自然入口找到相关内容。
- 不需要进入报告队列来管理论文。
- Obsidian 不再出现在核心页面标题中，只出现在集成/导出相关区域。

## 测试计划

### 后端

- 手动项目保存后保留原始上下文并生成可检索 chunk。
- 无 Obsidian 配置时 `run-daily` 成功跳过 Obsidian 步骤。
- 手动项目能产生 `project_paper_matches`。
- 保存论文后 `archive_zero_match_papers` 不删除该论文。
- 每日报告能写入 artifacts。
- Obsidian 导出失败不影响系统内 artifact。

### 前端

- 首页显示最近产物、推荐和队列状态。
- 论文仓库能按状态筛选。
- 论文详情能展示报告、聊天、项目关联和产物。
- 项目页能展示上下文、候选论文、项目论文库和项目产物。
- 产物详情能渲染 Markdown。
- 设置页中 Obsidian 是可选集成。

### 端到端

场景 1：纯 Docker/无 Obsidian

1. 初始化系统。
2. 手动创建项目。
3. 运行每日流程。
4. 查看项目推荐。
5. 保存论文到论文仓库。
6. 生成全文报告和日报 artifact。

场景 2：Obsidian 用户

1. 配置 vault 和项目中心标签。
2. 自动识别项目。
3. 运行每日流程。
4. 查看系统内产物。
5. 选择导出到 Obsidian。

场景 3：上传论文

1. 上传 PDF。
2. 论文进入仓库。
3. 提取全文。
4. 生成报告。
5. 关联到项目。

## 风险和注意事项

- 数据迁移必须保留可回滚备份，不能把旧表重命名和数据改写混在同一个不可恢复步骤里。
- `paper_reading_reports` 已经承担很多现有逻辑，迁移后不作为新状态源。
- `ReaderView` 拆分时要先抽组件，再移动路由，避免一次性大改前端状态管理。
- `archive_zero_match_papers` 是高风险删除路径，必须先加保护再继续改推荐流程。

## 优先级

最高优先级：

1. 长期数据模型落地：`knowledge_documents`、`papers`、`artifacts`。
2. 现有数据迁移脚本和校验。
3. 手动项目原始上下文可检索。
4. 无 Obsidian 的 `run-daily` 可运行。

第二优先级：

1. 论文仓库页面和 API。
2. 每日报告、论文报告、项目索引落库为 artifact。
3. ReportQueue 独立化。
4. 设置页重组。

第三优先级：

1. 前端信息架构完整重组。
2. Obsidian 可选导出。
3. Markdown 上传作为知识来源。

## Subagent 切分建议

本计划适合用 subagent 并行推进，但不能一开始把所有工作同时放出去。主线程需要先守住架构边界、数据模型、最终合并和测试。尤其是数据模型迁移，不能让多个 subagent 各自发明表结构。

### 主线程职责

主线程不外包这些事项：

- 最终数据模型和迁移边界。
- `worker/api.py` 和 `server.js` 的最终接口集成。
- `src/App.jsx` 和全局导航的最终集成。
- 跨模块测试和最终验收。
- 冲突解决和命名统一。

### 第一轮：后端地基并行

第一轮优先并行推进后端服务层，但要避免多个 subagent 同时大改 `worker/api.py` 和 `server.js`。

#### 1. Schema/Migration Agent

职责：长期数据模型和迁移脚本。

写入范围：

- `worker/db.py`
- `worker/pg.py`
- 新迁移脚本
- 相关 tests

目标：

- 新增 `knowledge_documents`。
- 新增 `project_context_documents`。
- 新增新版 `research_chunks`。
- 新增 `papers`、`paper_sources`、`paper_assets`、`paper_chunks`。
- 新增 `artifacts`。
- 提供现有 SQLite 数据迁移与校验。

交付物：

- schema patch。
- migration helper。
- 行数和关键关联校验测试。
- 明确列出旧表到新表的字段映射。

#### 2. Context Pipeline Agent

职责：项目上下文、知识来源和 Obsidian 可选化。

写入范围：

- 新 `worker/knowledge.py`
- `worker/obsidian.py`
- `worker/search.py`
- context 相关 API helper
- 相关 tests

目标：

- 手动项目原始上下文写入 `knowledge_documents`。
- Obsidian 同步写入 `knowledge_documents(source_type='obsidian')`。
- 项目上下文关联写入 `project_context_documents`。
- 项目匹配使用中性 knowledge evidence，不再绑定 `obsidian_notes`。
- 无 Obsidian 时上下文同步和每日流程不失败。

交付物：

- context ingestion 服务函数。
- Obsidian source adapter。
- 项目证据查询函数。
- 手动项目无 Obsidian 的测试。

#### 3. Paper Library Backend Agent

职责：论文仓库后端。

写入范围：

- 新 `worker/papers.py`
- `worker/arxiv_client.py`
- `worker/arxiv_text.py`
- `worker/paper_reader.py`
- library 相关 API helper
- 相关 tests

目标：

- arXiv、上传、URL 都进入 `papers`。
- arXiv/URL/上传来源写入 `paper_sources`。
- PDF/TXT 写入 `paper_assets`。
- 正文块写入 `paper_chunks`。
- 提供论文仓库列表和详情查询服务函数。
- `archive_zero_match_papers` 跳过已保存、阅读中、已读论文。

交付物：

- paper upsert 服务。
- source/asset/chunk 写入服务。
- library 列表和详情查询服务。
- archive 保护测试。

#### 4. Artifacts Backend Agent

职责：系统内产物层。

写入范围：

- 新 `worker/artifacts.py`
- `worker/reports.py`
- `worker/paper_reports.py`
- `worker/obsidian_library.py`
- artifact 相关 API helper
- 相关 tests

目标：

- 日报写入 `artifacts`。
- 项目索引写入 `artifacts`。
- 论文全文报告写入 `artifacts(scope_type='paper')`。
- Obsidian 导出改成 artifact export。

交付物：

- artifact create/update 服务。
- export 服务。
- 无 Obsidian 生成日报的测试。

### 第二轮：前端和验证

第二轮应在后端接口形状稳定后启动。前端任务依赖第一轮的接口形状，过早启动会造成反复返工。

#### 5. Frontend IA Agent

职责：前端信息架构和组件拆分。

写入范围：

- `src/App.jsx`
- `src/components/Sidebar.jsx`
- 新 `src/components/PaperLibraryView.jsx`
- 新 `src/components/ArtifactView.jsx`
- 新 `src/components/TasksView.jsx`
- 拆分 `src/components/ReaderView.jsx`
- `src/styles.css`

目标：

- 新导航：首页、项目、论文仓库、推荐、产物、任务、设置。
- `ReaderView` 拆成论文详情、报告、聊天、队列相关组件。
- 项目页增加 context、papers、artifacts tabs。
- Obsidian 只出现在知识来源和导出目标相关 UI。

交付物：

- 新路由/导航。
- 论文仓库页面。
- 产物列表和详情页面。
- 任务/报告队列页面。
- 项目详情 tabs。

#### 6. Tests Agent

职责：测试。

写入范围：

- `tests/`

目标：

- 覆盖无 Obsidian 手动项目流程。
- 覆盖论文仓库状态流转。
- 覆盖 artifact 落库和导出。

交付物：

- 后端单元测试。
- 关键端到端测试或流程测试。

### 并行边界

为减少冲突，按以下边界协作：

- Schema/Migration Agent 先确定表结构，其他 agent 不自行新增核心表。
- Context、Paper、Artifact agent 主要写服务层和测试。
- `worker/api.py` 和 `server.js` 由主线程最终集成接口。
- `src/App.jsx` 和全局导航由主线程或 Frontend IA Agent 单独拥有，避免多人同时改。
- 若必须改同一文件，先拆出新模块，再由主线程做薄集成。

### 建议执行顺序

1. 启动 Schema/Migration Agent。
2. Schema 初稿稳定后，并行启动 Context、Paper、Artifact backend agents。
3. 主线程集成接口。
4. 启动 Frontend IA Agent。
5. 启动 Tests Agent。
6. 主线程跑全量检查、修冲突、统一命名和验收。
