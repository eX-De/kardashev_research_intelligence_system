import { csv } from "../lib/dashboard.js";

function FormSubhead({ title, children }) {
  return (
    <div className="form-subhead">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function TextField({ label, name, placeholder, value, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <input name={name} placeholder={placeholder} value={csv(value)} onChange={(event) => onChange(name, event.target.value)} />
    </label>
  );
}

function PathField({ label, name, placeholder, mode = "directory", relativeTo, value, onChange, onPickPath }) {
  return (
    <label className="path-field">
      <span>{label}</span>
      <div className="path-input-row">
        <input name={name} placeholder={placeholder} value={csv(value)} onChange={(event) => onChange(name, event.target.value)} />
        <button
          type="button"
          onClick={() => onPickPath(name, { mode, relativeTo, title: `选择${label}` })}
        >
          选择
        </button>
      </div>
    </label>
  );
}

function NumberField({ label, name, min, max, step, value, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <input name={name} type="number" min={min} max={max} step={step} value={value ?? ""} onChange={(event) => onChange(name, event.target.value)} />
    </label>
  );
}

function CheckboxField({ label, name, checked, onChange }) {
  return (
    <label className="checkbox-line">
      <input name={name} type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(name, event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function normalizedProvider(provider = {}) {
  return {
    id: provider.id || "",
    name: provider.name || "",
    base_url: provider.base_url || "",
    api_key: "",
    api_key_configured: Boolean(provider.api_key_configured),
    chat_models: csv(provider.chat_models),
    embedding_models: csv(provider.embedding_models),
    clear_api_key: false
  };
}

function ProviderSelectors({ settings, providers, onProviderChange, onAddProvider, onRemoveProvider, onSettingChange }) {
  const rows = providers.length ? providers : [normalizedProvider({ id: "default", name: "Default" })];
  const providerOptions = rows.filter((provider) => provider.id);
  const chatProvider = providerOptions.find((provider) => provider.id === settings.llm_chat_provider_id);
  const embeddingProvider = providerOptions.find((provider) => provider.id === settings.llm_embedding_provider_id);
  const chatModels = String(chatProvider?.chat_models || "").split(",").map((item) => item.trim()).filter(Boolean);
  const embeddingModels = String(embeddingProvider?.embedding_models || "").split(",").map((item) => item.trim()).filter(Boolean);

  return (
    <>
      <div className="provider-list">
        {rows.map((provider, index) => {
          const keyText = provider.api_key_configured ? "API key 已保存；留空不修改。" : "尚未保存 API key。";
          return (
            <div className="provider-row" key={index}>
              <label>
                <span>ID</span>
                <input value={provider.id} placeholder="qwen" onChange={(event) => onProviderChange(index, "id", event.target.value)} />
              </label>
              <label>
                <span>名称</span>
                <input value={provider.name} placeholder="Qwen" onChange={(event) => onProviderChange(index, "name", event.target.value)} />
              </label>
              <label className="wide">
                <span>Base URL</span>
                <input value={provider.base_url} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" onChange={(event) => onProviderChange(index, "base_url", event.target.value)} />
              </label>
              <label>
                <span>API Key</span>
                <input value={provider.api_key || ""} type="password" placeholder={keyText} onChange={(event) => onProviderChange(index, "api_key", event.target.value)} />
              </label>
              <label className="wide">
                <span>Chat models</span>
                <input value={provider.chat_models} placeholder="qwen-plus,qwen-max" onChange={(event) => onProviderChange(index, "chat_models", event.target.value)} />
              </label>
              <label className="wide">
                <span>Embedding models</span>
                <input value={provider.embedding_models} placeholder="text-embedding-v4" onChange={(event) => onProviderChange(index, "embedding_models", event.target.value)} />
              </label>
              <label className="checkbox-line">
                <input type="checkbox" checked={Boolean(provider.clear_api_key)} onChange={(event) => onProviderChange(index, "clear_api_key", event.target.checked)} />
                <span>清除 key</span>
              </label>
              <div className="provider-actions">
                <button type="button" onClick={() => onRemoveProvider(index)}>移除</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="form-actions">
        <button type="button" onClick={onAddProvider}>
          添加 Provider
        </button>
      </div>
      <label>
        <span>Chat provider</span>
        <select value={settings.llm_chat_provider_id || ""} onChange={(event) => onSettingChange("llm_chat_provider_id", event.target.value)}>
          {providerOptions.length ? providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>) : <option value="">未配置</option>}
        </select>
      </label>
      <label>
        <span>Chat model</span>
        <select value={settings.llm_chat_model || ""} onChange={(event) => onSettingChange("llm_chat_model", event.target.value)}>
          {chatModels.length ? chatModels.map((model) => <option key={model} value={model}>{model}</option>) : <option value="">未配置</option>}
        </select>
      </label>
      <label>
        <span>Embedding provider</span>
        <select value={settings.llm_embedding_provider_id || ""} onChange={(event) => onSettingChange("llm_embedding_provider_id", event.target.value)}>
          {providerOptions.length ? providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>) : <option value="">未配置</option>}
        </select>
      </label>
      <label>
        <span>Embedding model</span>
        <select value={settings.llm_embedding_model || ""} onChange={(event) => onSettingChange("llm_embedding_model", event.target.value)}>
          {embeddingModels.length ? embeddingModels.map((model) => <option key={model} value={model}>{model}</option>) : <option value="">未配置</option>}
        </select>
      </label>
    </>
  );
}

export function normalizeProviders(providers = []) {
  return providers.length ? providers.map(normalizedProvider) : [normalizedProvider({ id: "default", name: "Default" })];
}

export function providerPayload(providers = []) {
  return providers
    .map((provider) => ({
      id: String(provider.id || "").trim(),
      name: String(provider.name || "").trim(),
      base_url: String(provider.base_url || "").trim(),
      api_key: provider.api_key || "",
      clear_api_key: Boolean(provider.clear_api_key),
      chat_models: String(provider.chat_models || "").split(",").map((item) => item.trim()).filter(Boolean),
      embedding_models: String(provider.embedding_models || "").split(",").map((item) => item.trim()).filter(Boolean)
    }))
    .filter((provider) => provider.id);
}

export function SettingsForm({ settings, providers, onSettingChange, onProviderChange, onAddProvider, onRemoveProvider, onPickPath, onSubmit }) {
  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <FormSubhead title="Obsidian">读取项目上下文，项目状态会写回中心页标签。</FormSubhead>
      <PathField label="Obsidian vault 路径" name="obsidian_vault_path" placeholder="D:\\Obsidian\\Vault" value={settings.obsidian_vault_path} onChange={onSettingChange} onPickPath={onPickPath} />
      <TextField label="扫描文件夹" name="obsidian_include_dirs" placeholder="Research,Papers" value={settings.obsidian_include_dirs} onChange={onSettingChange} />
      <TextField label="纳入标签" name="obsidian_include_tags" placeholder="research,paper,direction" value={settings.obsidian_include_tags} onChange={onSettingChange} />
      <TextField label="项目中心页标签组合" name="obsidian_project_center_tags" placeholder="project,center" value={settings.obsidian_project_center_tags} onChange={onSettingChange} />

      <FormSubhead title="arXiv">抓取 Atom feed，并可下载 PDF 后用 PyMuPDF 提取 TXT。</FormSubhead>
      <TextField label="arXiv 分类" name="arxiv_categories" placeholder="cs.AI,cs.CL,cs.IR" value={settings.arxiv_categories} onChange={onSettingChange} />
      <NumberField label="回看天数" name="arxiv_daily_lookback_days" min="1" step="1" value={settings.arxiv_daily_lookback_days} onChange={onSettingChange} />
      <NumberField label="最大抓取数" name="arxiv_max_results" min="1" step="1" value={settings.arxiv_max_results} onChange={onSettingChange} />
      <NumberField label="请求间隔秒数" name="arxiv_request_interval_seconds" min="3" step="0.5" value={settings.arxiv_request_interval_seconds} onChange={onSettingChange} />
      <CheckboxField label="缓存 PDF 并提取 TXT" name="arxiv_cache_full_text" checked={settings.arxiv_cache_full_text} onChange={onSettingChange} />
      <TextField label="PDF 缓存目录" name="arxiv_pdf_dir" placeholder="./data/arxiv_pdfs" value={settings.arxiv_pdf_dir} onChange={onSettingChange} />
      <TextField label="TXT 输出目录" name="arxiv_text_dir" placeholder="./data/arxiv_text" value={settings.arxiv_text_dir} onChange={onSettingChange} />

      <FormSubhead title="RAG">HybridSearch 召回和进入 inbox 的阈值。</FormSubhead>
      <NumberField label="RAG 阈值" name="rag_score_threshold" min="0" max="1" step="0.01" value={settings.rag_score_threshold} onChange={onSettingChange} />
      <NumberField label="证据 Top K" name="rag_top_k" min="1" step="1" value={settings.rag_top_k} onChange={onSettingChange} />
      <TextField label="RAG searchers" name="rag_searchers" placeholder="embedding_search,keyword_search,front_page_search" value={settings.rag_searchers} onChange={onSettingChange} />
      <CheckboxField label="启用摘要 embedding 粗筛" name="rag_prefilter_enabled" checked={settings.rag_prefilter_enabled} onChange={onSettingChange} />
      <NumberField label="粗筛阈值" name="rag_prefilter_threshold" min="0" max="1" step="0.01" value={settings.rag_prefilter_threshold} onChange={onSettingChange} />
      <NumberField label="粗筛 Top K" name="rag_prefilter_top_k" min="1" step="1" value={settings.rag_prefilter_top_k} onChange={onSettingChange} />
      <NumberField label="每日保底精排数" name="rag_prefilter_min_keep" min="0" step="1" value={settings.rag_prefilter_min_keep} onChange={onSettingChange} />
      <NumberField label="每日最大精排数" name="rag_prefilter_max_keep" min="0" step="1" value={settings.rag_prefilter_max_keep} onChange={onSettingChange} />
      <TextField label="向量索引 backend" name="vector_index_backend" placeholder="sqlite" value={settings.vector_index_backend} onChange={onSettingChange} />

      <FormSubhead title="LLM Providers">支持多个 OpenAI-compatible provider 和多个模型。</FormSubhead>
      <ProviderSelectors
        settings={settings}
        providers={providers}
        onProviderChange={onProviderChange}
        onAddProvider={onAddProvider}
        onRemoveProvider={onRemoveProvider}
        onSettingChange={onSettingChange}
      />

      <FormSubhead title="定时任务">两种每日流程触发方式互斥，执行内容相同。</FormSubhead>
      <CheckboxField label="每日首次启动 dashboard 时执行" name="run_daily_on_startup_enabled" checked={settings.run_daily_on_startup_enabled} onChange={onSettingChange} />
      <CheckboxField label="按时间定时执行" name="scheduler_enabled" checked={settings.scheduler_enabled} onChange={onSettingChange} />
      <label>
        <span>每日执行时间</span>
        <input name="scheduler_run_time" type="time" value={settings.scheduler_run_time || ""} onChange={(event) => onSettingChange("scheduler_run_time", event.target.value)} />
      </label>
      <NumberField label="执行间隔小时" name="scheduler_interval_hours" min="1" step="1" value={settings.scheduler_interval_hours} onChange={onSettingChange} />
      <div className="form-actions">
        <button type="submit" className="primary">
          保存配置
        </button>
      </div>
    </form>
  );
}
