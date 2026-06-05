import { useEffect, useState } from "react";

import { csv } from "../lib/dashboard.js";

function SettingsSection({ eyebrow, title, description, children, bodyClassName = "settings-field-grid" }) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          {eyebrow ? <span>{eyebrow}</span> : null}
          <h3>{title}</h3>
        </div>
        <p>{description}</p>
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
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
  const [activeProviderIndex, setActiveProviderIndex] = useState(0);
  const rows = providers.length ? providers : [normalizedProvider({ id: "default", name: "Default" })];
  const activeProvider = rows[Math.min(activeProviderIndex, rows.length - 1)] || rows[0];
  const activeIndex = Math.min(activeProviderIndex, rows.length - 1);
  const providerOptions = rows.filter((provider) => provider.id);
  const chatProvider = providerOptions.find((provider) => provider.id === settings.llm_chat_provider_id);
  const embeddingProvider = providerOptions.find((provider) => provider.id === settings.llm_embedding_provider_id);
  const chatModels = String(chatProvider?.chat_models || "").split(",").map((item) => item.trim()).filter(Boolean);
  const embeddingModels = String(embeddingProvider?.embedding_models || "").split(",").map((item) => item.trim()).filter(Boolean);
  const modelsForProvider = (providerId) => {
    const provider = providerOptions.find((item) => item.id === providerId);
    return String(provider?.chat_models || "").split(",").map((item) => item.trim()).filter(Boolean);
  };
  const readerPairs = [
    ["paper_report_provider_id", "paper_report_model", "解读报告模型"],
    ["reader_chat_provider_id", "reader_chat_model", "阅读器 Chat 模型"],
    ["reader_smart_save_provider_id", "reader_smart_save_model", "Smart Save 模型"],
    ["reader_question_provider_id", "reader_question_model", "追问生成模型"]
  ];

  useEffect(() => {
    if (activeProviderIndex > rows.length - 1) setActiveProviderIndex(Math.max(rows.length - 1, 0));
  }, [activeProviderIndex, rows.length]);

  function addProvider() {
    onAddProvider();
    setActiveProviderIndex(rows.length);
  }

  function removeActiveProvider() {
    onRemoveProvider(activeIndex);
    setActiveProviderIndex(Math.max(activeIndex - 1, 0));
  }

  const keyText = activeProvider.api_key_configured ? "API key 已保存；留空不修改。" : "尚未保存 API key。";

  return (
    <>
      <div className="provider-manager settings-grid-wide">
        <aside className="provider-sidebar">
          <div className="provider-sidebar-head">
            <div>
              <h3>模型服务</h3>
              <p>{rows.length} 个 provider</p>
            </div>
            <button type="button" onClick={addProvider}>添加</button>
          </div>
          <div className="provider-tab-list">
            {rows.map((provider, index) => (
              <button className={`provider-tab ${index === activeIndex ? "active" : ""}`} key={index} onClick={() => setActiveProviderIndex(index)} type="button">
                <span>
                  <strong>{provider.name || provider.id || "未命名 Provider"}</strong>
                  <small>{provider.id || "缺少 ID"}</small>
                </span>
                <em className={provider.api_key_configured ? "ok" : "warn"}>{provider.api_key_configured ? "已存 key" : "未存 key"}</em>
              </button>
            ))}
          </div>
        </aside>

        <section className="provider-editor">
          <div className="provider-editor-head">
            <div>
              <h3>{activeProvider.name || activeProvider.id || "Provider 配置"}</h3>
              <p>{activeProvider.base_url || "Base URL 未配置"}</p>
            </div>
            <button className="danger" type="button" onClick={removeActiveProvider}>移除</button>
          </div>
          <div className="provider-fields">
            <label>
              <span>ID</span>
              <input value={activeProvider.id} placeholder="qwen" onChange={(event) => onProviderChange(activeIndex, "id", event.target.value)} />
            </label>
            <label>
              <span>名称</span>
              <input value={activeProvider.name} placeholder="Qwen" onChange={(event) => onProviderChange(activeIndex, "name", event.target.value)} />
            </label>
            <label className="provider-field-wide">
              <span>Base URL</span>
              <input value={activeProvider.base_url} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" onChange={(event) => onProviderChange(activeIndex, "base_url", event.target.value)} />
            </label>
            <label>
              <span>API Key</span>
              <input value={activeProvider.api_key || ""} type="password" placeholder={keyText} onChange={(event) => onProviderChange(activeIndex, "api_key", event.target.value)} />
            </label>
            <label className="provider-field-wide">
              <span>Chat models</span>
              <input value={activeProvider.chat_models} placeholder="qwen-plus,qwen-max" onChange={(event) => onProviderChange(activeIndex, "chat_models", event.target.value)} />
            </label>
            <label className="provider-field-wide">
              <span>Embedding models</span>
              <input value={activeProvider.embedding_models} placeholder="text-embedding-v4" onChange={(event) => onProviderChange(activeIndex, "embedding_models", event.target.value)} />
            </label>
            <label className="checkbox-line provider-clear-key">
              <input type="checkbox" checked={Boolean(activeProvider.clear_api_key)} onChange={(event) => onProviderChange(activeIndex, "clear_api_key", event.target.checked)} />
              <span>保存时清除这个 provider 的 API key</span>
            </label>
          </div>
        </section>
      </div>

      <div className="model-routing settings-grid-wide">
        <section className="model-routing-panel">
          <h3>默认模型</h3>
          <div className="model-routing-fields">
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
          </div>
        </section>

        <section className="model-routing-panel">
          <h3>阅读器模型</h3>
          <div className="reader-model-grid">
            {readerPairs.map(([providerField, modelField, label]) => {
              const selectedProviderId = settings[providerField] || settings.llm_chat_provider_id || "";
              const models = modelsForProvider(selectedProviderId);
              return (
                <div className="reader-model-row" key={providerField}>
                  <strong>{label}</strong>
                  <div>
                    <label>
                      <span>Provider</span>
                      <select value={selectedProviderId} onChange={(event) => onSettingChange(providerField, event.target.value)}>
                        {providerOptions.length ? providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.name || provider.id}</option>) : <option value="">未配置</option>}
                      </select>
                    </label>
                    <label>
                      <span>Model</span>
                      <select value={settings[modelField] || settings.llm_chat_model || ""} onChange={(event) => onSettingChange(modelField, event.target.value)}>
                        {models.length ? models.map((model) => <option key={model} value={model}>{model}</option>) : <option value="">未配置</option>}
                      </select>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <label className="settings-grid-wide prompt-field">
        <span>论文解读默认 prompt</span>
        <textarea
          value={settings.paper_reader_default_prompt || ""}
          onChange={(event) => onSettingChange("paper_reader_default_prompt", event.target.value)}
        />
      </label>
    </>
  );
}

function PasswordField({ label, name, placeholder, value, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <input name={name} type="password" placeholder={placeholder} value={value || ""} onChange={(event) => onChange(name, event.target.value)} />
    </label>
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

const SAVE_STATUS_LABELS = {
  idle: "未修改",
  dirty: "保存中",
  saving: "保存中",
  saved: "已保存",
  error: "保存失败"
};

export function SettingsForm({ settings, providers, onSettingChange, onProviderChange, onAddProvider, onRemoveProvider, onPickPath, onSubmit, saveStatus = "idle" }) {
  const obsidianBackend = String(settings.obsidian_storage_backend || "local");
  const remoteObsidian = ["oss", "s3", "r2"].includes(obsidianBackend);
  const remoteSecretText = settings.obsidian_remote_secret_access_key_configured ? "Secret 已保存；留空不修改。" : "Access secret";

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <SettingsSection
        eyebrow="Sources"
        title="知识库与可选 Obsidian 集成"
        description="系统内知识库、论文抓取和报告生成可独立运行；填写 vault 后才启用 Obsidian 导入、导出和路径选择。"
      >
        <label>
          <span>Obsidian 存储模式</span>
          <select value={obsidianBackend} onChange={(event) => onSettingChange("obsidian_storage_backend", event.target.value)}>
            <option value="local">本地 vault</option>
            <option value="oss">阿里云 OSS</option>
            <option value="s3">S3 兼容</option>
            <option value="r2">Cloudflare R2</option>
          </select>
        </label>
        {remoteObsidian ? (
          <>
            <TextField label="Endpoint URL" name="obsidian_remote_endpoint_url" placeholder={obsidianBackend === "r2" ? "https://<account>.r2.cloudflarestorage.com" : "https://oss-cn-hangzhou.aliyuncs.com"} value={settings.obsidian_remote_endpoint_url} onChange={onSettingChange} />
            <TextField label="Region" name="obsidian_remote_region" placeholder={obsidianBackend === "r2" ? "auto" : "cn-hangzhou"} value={settings.obsidian_remote_region} onChange={onSettingChange} />
            <TextField label="Bucket" name="obsidian_remote_bucket" placeholder="obsidian-vault" value={settings.obsidian_remote_bucket} onChange={onSettingChange} />
            <TextField label="Vault prefix" name="obsidian_remote_prefix" placeholder="vault" value={settings.obsidian_remote_prefix} onChange={onSettingChange} />
            <TextField label="系统输出前缀" name="obsidian_remote_output_prefix" placeholder="Research Intelligence" value={settings.obsidian_remote_output_prefix} onChange={onSettingChange} />
            <TextField label="本地镜像目录" name="obsidian_remote_mirror_dir" placeholder="./data/obsidian_remote_vault" value={settings.obsidian_remote_mirror_dir} onChange={onSettingChange} />
            <TextField label="Access key ID" name="obsidian_remote_access_key_id" placeholder="AKIA..." value={settings.obsidian_remote_access_key_id} onChange={onSettingChange} />
            <PasswordField label="Access secret" name="obsidian_remote_secret_access_key" placeholder={remoteSecretText} value={settings.obsidian_remote_secret_access_key} onChange={onSettingChange} />
          </>
        ) : (
          <PathField label="可选 Obsidian vault 路径" name="obsidian_vault_path" placeholder="D:\\Obsidian\\Vault" value={settings.obsidian_vault_path} onChange={onSettingChange} onPickPath={onPickPath} />
        )}
        <TextField label="Obsidian 扫描文件夹" name="obsidian_include_dirs" placeholder="Research,Papers" value={settings.obsidian_include_dirs} onChange={onSettingChange} />
        <TextField label="Obsidian 纳入标签" name="obsidian_include_tags" placeholder="research,paper,direction" value={settings.obsidian_include_tags} onChange={onSettingChange} />
        <TextField label="Obsidian 项目中心页标签" name="obsidian_project_center_tags" placeholder="project,center" value={settings.obsidian_project_center_tags} onChange={onSettingChange} />
        {!remoteObsidian ? (
          <>
            <TextField label="Obsidian CLI 命令（可选）" name="obsidian_cli_command" placeholder="obsidian" value={settings.obsidian_cli_command} onChange={onSettingChange} />
            <PathField label="Obsidian 论文仓库目录" name="obsidian_paper_repository_dir" placeholder="人工智能/论文仓库" relativeTo="obsidian_vault" value={settings.obsidian_paper_repository_dir} onChange={onSettingChange} onPickPath={onPickPath} />
            <PathField label="Obsidian 论文附件目录" name="obsidian_paper_attachment_dir" placeholder="人工智能/论文仓库/附件" relativeTo="obsidian_vault" value={settings.obsidian_paper_attachment_dir} onChange={onSettingChange} onPickPath={onPickPath} />
            <TextField label="Obsidian 项目论文列表文件名" name="obsidian_project_paper_list_name" placeholder="论文列表.md" value={settings.obsidian_project_paper_list_name} onChange={onSettingChange} />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        eyebrow="Ingestion"
        title="论文抓取与全文缓存"
        description="控制 arXiv 抓取范围、频率和本地 PDF/TXT 缓存。"
      >
        <TextField label="arXiv 分类" name="arxiv_categories" placeholder="cs.AI,cs.CL,cs.IR" value={settings.arxiv_categories} onChange={onSettingChange} />
        <NumberField label="回看天数" name="arxiv_daily_lookback_days" min="1" step="1" value={settings.arxiv_daily_lookback_days} onChange={onSettingChange} />
        <NumberField label="最大抓取数" name="arxiv_max_results" min="1" step="1" value={settings.arxiv_max_results} onChange={onSettingChange} />
        <NumberField label="请求间隔秒数" name="arxiv_request_interval_seconds" min="3" step="0.5" value={settings.arxiv_request_interval_seconds} onChange={onSettingChange} />
        <CheckboxField label="缓存 PDF 并提取 TXT" name="arxiv_cache_full_text" checked={settings.arxiv_cache_full_text} onChange={onSettingChange} />
        <TextField label="PDF 缓存目录" name="arxiv_pdf_dir" placeholder="./data/arxiv_pdfs" value={settings.arxiv_pdf_dir} onChange={onSettingChange} />
        <TextField label="TXT 输出目录" name="arxiv_text_dir" placeholder="./data/arxiv_text" value={settings.arxiv_text_dir} onChange={onSettingChange} />
        <NumberField label="Embedding 请求并发数" name="embedding_concurrency" min="1" step="1" value={settings.embedding_concurrency} onChange={onSettingChange} />
        <NumberField label="历史补洞上限" name="retry_daily_max_results" min="1" step="1" value={settings.retry_daily_max_results} onChange={onSettingChange} />
      </SettingsSection>

      <SettingsSection
        eyebrow="Ranking"
        title="推荐与检索策略"
        description="决定论文进入 inbox 前的召回、粗筛和证据数量。"
      >
        <NumberField label="RAG 阈值" name="rag_score_threshold" min="0" max="1" step="0.01" value={settings.rag_score_threshold} onChange={onSettingChange} />
        <NumberField label="证据 Top K" name="rag_top_k" min="1" step="1" value={settings.rag_top_k} onChange={onSettingChange} />
        <TextField label="RAG searchers" name="rag_searchers" placeholder="embedding_search,keyword_search,front_page_search" value={settings.rag_searchers} onChange={onSettingChange} />
        <CheckboxField label="启用摘要 embedding 粗筛" name="rag_prefilter_enabled" checked={settings.rag_prefilter_enabled} onChange={onSettingChange} />
        <NumberField label="粗筛阈值" name="rag_prefilter_threshold" min="0" max="1" step="0.01" value={settings.rag_prefilter_threshold} onChange={onSettingChange} />
        <NumberField label="粗筛 Top K" name="rag_prefilter_top_k" min="1" step="1" value={settings.rag_prefilter_top_k} onChange={onSettingChange} />
        <NumberField label="每日保底精排数" name="rag_prefilter_min_keep" min="0" step="1" value={settings.rag_prefilter_min_keep} onChange={onSettingChange} />
        <NumberField label="每日最大精排数" name="rag_prefilter_max_keep" min="0" step="1" value={settings.rag_prefilter_max_keep} onChange={onSettingChange} />
      </SettingsSection>

      <SettingsSection
        eyebrow="Models"
        title="模型服务与路由"
        description="维护 provider，并把不同阅读任务路由到对应模型。"
        bodyClassName="settings-section-stack"
      >
        <ProviderSelectors
          settings={settings}
          providers={providers}
          onProviderChange={onProviderChange}
          onAddProvider={onAddProvider}
          onRemoveProvider={onRemoveProvider}
          onSettingChange={onSettingChange}
        />
      </SettingsSection>

      <SettingsSection
        eyebrow="Automation"
        title="自动化参数"
        description="任务模式由上方任务控制切换；这里保留执行时间和队列参数。"
      >
        <label>
          <span>每日执行时间</span>
          <input name="scheduler_run_time" type="time" value={settings.scheduler_run_time || ""} onChange={(event) => onSettingChange("scheduler_run_time", event.target.value)} />
        </label>
        <NumberField label="执行间隔小时" name="scheduler_interval_hours" min="1" step="1" value={settings.scheduler_interval_hours} onChange={onSettingChange} />
        <NumberField label="报告队列并发数" name="paper_report_queue_concurrency" min="1" max="8" step="1" value={settings.paper_report_queue_concurrency} onChange={onSettingChange} />
      </SettingsSection>

      <div className="settings-save-bar">
        <span className="muted" aria-live="polite">
          {SAVE_STATUS_LABELS[saveStatus] || SAVE_STATUS_LABELS.idle}
        </span>
        <button type="submit" className="primary">
          立即保存
        </button>
      </div>
    </form>
  );
}
