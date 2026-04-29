function FormSubhead({ title, children }) {
  return (
    <div className="form-subhead">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function TextField({ label, name, placeholder }) {
  return (
    <label>
      <span>{label}</span>
      <input name={name} placeholder={placeholder} />
    </label>
  );
}

function NumberField({ label, name, min, max, step }) {
  return (
    <label>
      <span>{label}</span>
      <input name={name} type="number" min={min} max={max} step={step} />
    </label>
  );
}

function CheckboxField({ label, name }) {
  return (
    <label className="checkbox-line">
      <input name={name} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

function ProviderSelectors() {
  return (
    <>
      <div className="provider-list" id="llmProviders" />
      <div className="form-actions">
        <button type="button" id="addProviderButton">
          添加 Provider
        </button>
      </div>
      <label>
        <span>Chat provider</span>
        <select name="llm_chat_provider_id" id="chatProviderSelect" />
      </label>
      <label>
        <span>Chat model</span>
        <select name="llm_chat_model" id="chatModelSelect" />
      </label>
      <label>
        <span>Embedding provider</span>
        <select name="llm_embedding_provider_id" id="embeddingProviderSelect" />
      </label>
      <label>
        <span>Embedding model</span>
        <select name="llm_embedding_model" id="embeddingModelSelect" />
      </label>
    </>
  );
}

export function SettingsForm() {
  return (
    <form id="settingsForm" className="settings-form">
      <FormSubhead title="Obsidian">读取项目上下文，项目状态会写回中心页标签。</FormSubhead>
      <TextField label="Obsidian vault 路径" name="obsidian_vault_path" placeholder="D:\Obsidian\Vault" />
      <TextField label="扫描文件夹" name="obsidian_include_dirs" placeholder="Research,Papers" />
      <TextField label="纳入标签" name="obsidian_include_tags" placeholder="research,paper,direction" />
      <TextField label="项目中心页标签组合" name="obsidian_project_center_tags" placeholder="project,center" />

      <FormSubhead title="arXiv">抓取 Atom feed，并可下载 PDF 后用 PyMuPDF 提取 TXT。</FormSubhead>
      <TextField label="arXiv 分类" name="arxiv_categories" placeholder="cs.AI,cs.CL,cs.IR" />
      <NumberField label="回看天数" name="arxiv_daily_lookback_days" min="1" step="1" />
      <NumberField label="最大抓取数" name="arxiv_max_results" min="1" step="1" />
      <NumberField label="请求间隔秒数" name="arxiv_request_interval_seconds" min="3" step="0.5" />
      <CheckboxField label="缓存 PDF 并提取 TXT" name="arxiv_cache_full_text" />
      <TextField label="PDF 缓存目录" name="arxiv_pdf_dir" placeholder="./data/arxiv_pdfs" />
      <TextField label="TXT 输出目录" name="arxiv_text_dir" placeholder="./data/arxiv_text" />

      <FormSubhead title="RAG">HybridSearch 召回和进入 inbox 的阈值。</FormSubhead>
      <NumberField label="RAG 阈值" name="rag_score_threshold" min="0" max="1" step="0.01" />
      <NumberField label="证据 Top K" name="rag_top_k" min="1" step="1" />
      <TextField label="RAG searchers" name="rag_searchers" placeholder="embedding_search,keyword_search,front_page_search" />
      <CheckboxField label="启用摘要 embedding 粗筛" name="rag_prefilter_enabled" />
      <NumberField label="粗筛阈值" name="rag_prefilter_threshold" min="0" max="1" step="0.01" />
      <NumberField label="粗筛 Top K" name="rag_prefilter_top_k" min="1" step="1" />
      <NumberField label="每日保底精排数" name="rag_prefilter_min_keep" min="0" step="1" />
      <TextField label="向量索引 backend" name="vector_index_backend" placeholder="sqlite" />

      <FormSubhead title="LLM Providers">支持多个 OpenAI-compatible provider 和多个模型。</FormSubhead>
      <ProviderSelectors />

      <FormSubhead title="定时任务">两种每日流程触发方式互斥，执行内容相同。</FormSubhead>
      <CheckboxField label="每日首次启动 dashboard 时执行" name="run_daily_on_startup_enabled" />
      <CheckboxField label="按时间定时执行" name="scheduler_enabled" />
      <label>
        <span>每日执行时间</span>
        <input name="scheduler_run_time" type="time" />
      </label>
      <NumberField label="执行间隔小时" name="scheduler_interval_hours" min="1" step="1" />
      <div className="form-actions">
        <button type="submit" className="primary">
          保存配置
        </button>
      </div>
    </form>
  );
}
