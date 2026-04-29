  # 科研情报系统 MVP 计划

  ## Summary

  构建一个本地 Web dashboard + Obsidian 只读知识库 + SQLite 索引库的科研情报系
  统。系统每天从 arXiv 抓取新论文，用 Obsidian 中指定文件夹和标签生成个人研究画
  像，通过 Qwen-Agent HybridSearch 召回和排序相关 Obsidian 证据片段，再用 OpenAI
  兼容 LLM 解释“为什么这篇论文与你的研究方向相关”。

  技术形态：

  - Web：Node 全栈应用，负责 dashboard、配置、标注、任务触发。
  - Worker：Python，负责 arXiv 抓取、Markdown 解析、embedding 索引、HybridSearch
    相关性排序、LLM 解释。
  - 数据：SQLite 存论文、任务状态、向量、用户反馈；Obsidian 第一版只读，不自动改
    写 Markdown。

  ## Key Changes

  - 初始化本地应用结构：
      - Node Web 服务提供 Dashboard、API、每日 inbox。
      - Python worker 通过 CLI 或 job runner 被 Node 调用。
      - .env 配置 arXiv 类别、Obsidian vault 路径、目标文件夹、标签、OpenAI 兼容
        API key/model/embedding model、RAG searchers、向量索引 backend。
  - Obsidian 研究画像：
      - 只扫描配置指定的文件夹，例如 Research/、Papers/。
      - 只纳入带指定标签的 Markdown，例如 #research、#paper、#direction。
      - 从标题、frontmatter、正文摘要、用户笔记中抽取文本块。
      - 为这些文本块生成 embedding，存入 SQLite。
      - 第一版不写回 Obsidian，避免 Markdown 冲突和误改。
  - arXiv 每日抓取：
      - 使用 arXiv 官方 API Atom feed，按配置类别和日期窗口抓取论文。
      - 遵守官方 API 约束：请求串行、限速，至少 3 秒间隔；不抓取或缓存 PDF 正
        文。
      - 存储 arXiv ID、标题、作者、摘要、分类、发布时间、链接、抓取批次。
  - 相关性识别：
      - 将 arXiv 标题 + 摘要作为 query 输入 Qwen-Agent HybridSearch。
      - HybridSearch 是主召回和排序路径，不再单独做 embedding cosine similarity 初
        筛。
      - `embedding_search` 提供语义召回，`keyword_search` 提供术语、方法名、任务名
        等精确匹配，`front_page_search` 可选地提高笔记前部重点内容权重。
      - 取 HybridSearch 排名前若干 Obsidian chunk 作为证据。
      - 达到 RAG 相关性阈值的论文进入 Dashboard inbox。
      - LLM 输出：
          - 一句话推荐理由。
          - 与你研究方向相关的具体点。
          - 对应的 Obsidian 证据片段引用。
          - 置信度/相关性评分。
          - 建议动作：阅读、稍后、忽略。
  - Qwen-Agent RAG / HybridSearch：
      - 第一版把 Qwen-Agent HybridSearch 作为论文到 Obsidian 研究画像的主检索器，
        而不是解释层之外的第二套筛选逻辑。
      - `embedding_search` 继承 Qwen-Agent `BaseSearch`，在 `sort_by_scores()` 中对
        query 做 embedding，并从 SQLite/向量索引中召回 Obsidian chunk，返回
        `(source, chunk_id, score)`。
      - 推荐配置 `rag_searchers = ["embedding_search", "keyword_search",
        "front_page_search"]`，让语义召回、关键词精确匹配、文档前部优先策略一起进入
        Qwen-Agent `HybridSearch`。
      - HybridSearch 负责融合多个 searcher 的排序结果，采用类似 reciprocal rank
        fusion 的排名融合；不要把 BM25 分数、cosine similarity 和 front-page 分数当
        作同一量纲直接相加。
      - 对外解释时保留每个证据 chunk 的来源、Obsidian note、chunk_id、相似度和命中
        searcher，便于 Dashboard 展示“为什么相关”。
  - Dashboard 功能：
      - 今日推荐 inbox，按相关性排序。
      - 论文详情页显示摘要、arXiv 链接、相似 Obsidian 片段、LLM 解释。
      - 用户可标注：相关、不相关、待读、已读、收藏。
      - 用户反馈写入 SQLite，后续用于调整阈值和构建正/负例。

  ## Public Interfaces / Data

  - 配置文件或环境变量：
      - OBSIDIAN_VAULT_PATH
      - OBSIDIAN_INCLUDE_DIRS
      - OBSIDIAN_INCLUDE_TAGS
      - ARXIV_CATEGORIES
      - ARXIV_DAILY_LOOKBACK_DAYS
      - RAG_SCORE_THRESHOLD
      - RAG_TOP_K
      - OPENAI_BASE_URL
      - OPENAI_API_KEY
      - OPENAI_CHAT_MODEL
      - OPENAI_EMBEDDING_MODEL
      - RAG_SEARCHERS
      - VECTOR_INDEX_BACKEND
  - SQLite 核心表：
      - obsidian_notes
      - research_chunks
      - arxiv_papers
      - chunk_embeddings
      - matches
      - llm_explanations
      - user_feedback
      - job_runs
  - Node API：
      - GET /api/inbox
      - GET /api/papers/:id
      - POST /api/papers/:id/feedback
      - POST /api/jobs/sync-obsidian
      - POST /api/jobs/fetch-arxiv
      - POST /api/jobs/run-daily

  ## Test Plan

  - Obsidian parsing:
      - Markdown frontmatter、标签、正文抽取正确。
      - 非指定文件夹和非指定标签笔记被排除。
      - 重复运行不会重复插入同一笔记/chunk。
  - arXiv worker:
      - 能解析 Atom feed 并保存论文元数据。
      - 分页、限速、失败重试、重复 arXiv ID 去重正常。
      - 无 API key 时仍可完成抓取但跳过 embedding/LLM。
  - HybridSearch:
      - 给定固定 embedding/BM25/front-page mock，HybridSearch 排名融合结果稳定。
      - 阈值以下论文不进入 inbox。
      - 相似证据片段能追溯到 Obsidian note。
  - Dashboard:
      - inbox 能展示每日推荐。
      - 详情页能展示推荐理由和证据。
      - 标注反馈能持久化并反映在列表状态中。
  - End-to-end:

  - 第一版使用 Node 全栈 + Python worker，不做纯 Python Web。
  - Obsidian 是人类可读数据库，第一版只读导入，不写回。
  - 每日结果只进入 Dashboard inbox，不生成 Obsidian 日报。
  - 个人研究方向来自 Obsidian 指定文件夹 + 指定标签。
  - embedding 和解释使用 OpenAI 兼容 API。
  - arXiv 集成遵循官方 API 文档和使用条款：
      - https://info.arxiv.org/help/api/user-manual.html
      - https://info.arxiv.org/help/api/tou.html
