import { useEffect, useState } from "react";

import { csv } from "../lib/dashboard.js";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/SettingsForm.css";
import "../styles/ModelRoutingSettingsView.css";

const SAVE_STATUS_LABELS = {
  idle: "未修改",
  dirty: "保存中",
  saving: "保存中",
  saved: "已保存",
  error: "保存失败"
};

const TASK_ROUTES = [
  ["paper_report_provider_id", "paper_report_model", "解读报告", "生成论文全文结构化分析"],
  ["project_chat_profile_provider_id", "project_chat_profile_model", "项目摘要", "归纳项目对话与每日研究进展"],
  ["reader_chat_provider_id", "reader_chat_model", "阅读器 Chat", "处理围绕论文正文的连续问答"],
  ["reader_smart_save_provider_id", "reader_smart_save_model", "Smart Save", "判断论文归档位置与项目关联"],
  ["reader_question_provider_id", "reader_question_model", "追问生成", "根据报告生成后续研究问题"]
];

function emptyProvider() {
  return {
    id: "default",
    name: "Default",
    base_url: "",
    api_key: "",
    api_key_configured: false,
    chat_models: "",
    embedding_models: "",
    clear_api_key: false
  };
}

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="settings-select-field">
      <span>{label}</span>
      <WorkspaceSelect ariaLabel={label} onChange={onChange} options={options} value={value || ""} />
    </label>
  );
}

function NumberField({ label, name, min, max, step, value, onChange }) {
  return (
    <label>
      <span>{label}</span>
      <input
        max={max}
        min={min}
        name={name}
        onChange={(event) => onChange(name, event.target.value)}
        step={step}
        type="number"
        value={value ?? ""}
      />
    </label>
  );
}

function ProviderManager({ providers, settings, onAddProvider, onProviderChange, onRemoveProvider, onSettingChange }) {
  const [activeProviderIndex, setActiveProviderIndex] = useState(0);
  const rows = providers.length ? providers : [emptyProvider()];
  const activeIndex = Math.min(activeProviderIndex, rows.length - 1);
  const activeProvider = rows[activeIndex] || rows[0];
  const providerOptions = rows.filter((provider) => provider.id);
  const providerSelectOptions = providerOptions.length
    ? providerOptions.map((provider) => [provider.id, provider.name || provider.id])
    : [["", "未配置"]];
  const modelsForProvider = (providerId, kind = "chat_models") => {
    const provider = providerOptions.find((item) => item.id === providerId);
    return String(provider?.[kind] || "").split(",").map((item) => item.trim()).filter(Boolean);
  };
  const chatModels = modelsForProvider(settings.llm_chat_provider_id);
  const embeddingModels = modelsForProvider(settings.llm_embedding_provider_id, "embedding_models");

  useEffect(() => {
    if (activeProviderIndex > rows.length - 1) {
      setActiveProviderIndex(Math.max(rows.length - 1, 0));
    }
  }, [activeProviderIndex, rows.length]);

  function addProvider() {
    onAddProvider?.();
    setActiveProviderIndex(rows.length);
  }

  function removeProvider() {
    onRemoveProvider?.(activeIndex);
    setActiveProviderIndex(Math.max(activeIndex - 1, 0));
  }

  const changeProvider = (field, value) => onProviderChange?.(activeIndex, field, value);
  const keyText = activeProvider.api_key_configured ? "API key 已保存；留空不修改。" : "尚未保存 API key。";

  return (
    <>
      <div className="provider-manager model-provider-studio settings-grid-wide">
        <aside className="provider-sidebar">
          <div className="provider-sidebar-head">
            <div>
              <span>Service registry</span>
              <h3>服务端点</h3>
              <p>{rows.length} 个 Provider</p>
            </div>
            <button aria-label="添加模型服务" onClick={addProvider} type="button"><i aria-hidden="true">＋</i><span>添加</span></button>
          </div>
          <div className="provider-tab-list">
            {rows.map((provider, index) => {
              const chatCount = String(provider.chat_models || "").split(",").filter((item) => item.trim()).length;
              const embeddingCount = String(provider.embedding_models || "").split(",").filter((item) => item.trim()).length;
              const providerName = provider.name || provider.id || "未命名 Provider";
              return (
                <button className={`provider-tab ${index === activeIndex ? "active" : ""}`} key={`${provider.id || "provider"}-${index}`} onClick={() => setActiveProviderIndex(index)} type="button">
                  <i className="provider-tab-mark" aria-hidden="true">{providerName.slice(0, 1).toUpperCase()}</i>
                  <span>
                    <strong>{providerName}</strong>
                    <small>{provider.id || "缺少 ID"} · {chatCount} Chat · {embeddingCount} Embedding</small>
                  </span>
                  <em className={provider.api_key_configured ? "ok" : "warn"} title={provider.api_key_configured ? "API Key 已保存" : "API Key 未配置"}>
                    <i aria-hidden="true" />
                    {provider.api_key_configured ? "就绪" : "待配置"}
                  </em>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="provider-editor">
          <div className="provider-editor-head">
            <div>
              <span>Active provider</span>
              <h3>{activeProvider.name || activeProvider.id || "Provider 配置"}</h3>
              <p>{activeProvider.base_url || "Base URL 未配置"}</p>
            </div>
            <div className="provider-editor-actions">
              <span className={`provider-connection-state ${activeProvider.api_key_configured ? "is-ready" : "is-pending"}`}><b>{activeProvider.api_key_configured ? "凭据已保存" : "等待凭据"}</b></span>
              <button className="danger" onClick={removeProvider} type="button">移除</button>
            </div>
          </div>
          <div className="provider-editor-body">
            <section className="provider-field-group provider-identity-fields">
              <header><span>01</span><div><strong>连接信息</strong><p>OpenAI 兼容接口地址与访问凭据</p></div></header>
              <div className="provider-fields">
                <label><span>Provider ID</span><input onChange={(event) => changeProvider("id", event.target.value)} placeholder="qwen" value={activeProvider.id || ""} /></label>
                <label><span>显示名称</span><input onChange={(event) => changeProvider("name", event.target.value)} placeholder="Qwen" value={activeProvider.name || ""} /></label>
                <label className="provider-field-wide"><span>Base URL</span><input onChange={(event) => changeProvider("base_url", event.target.value)} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" value={activeProvider.base_url || ""} /></label>
                <label className="provider-field-wide"><span>API Key</span><input onChange={(event) => changeProvider("api_key", event.target.value)} placeholder={keyText} type="password" value={activeProvider.api_key || ""} /></label>
                <label className="settings-checkbox-row provider-clear-key">
                  <input checked={Boolean(activeProvider.clear_api_key)} className="settings-checkbox-input" onChange={(event) => changeProvider("clear_api_key", event.target.checked)} type="checkbox" />
                  <span className="settings-checkbox-mark" aria-hidden="true"><svg fill="none" viewBox="0 0 12 12"><path d="m2.5 6.2 2.2 2.2 4.8-5" /></svg></span>
                  <span className="settings-checkbox-label">保存时清除这个 Provider 的 API Key</span>
                </label>
              </div>
            </section>
            <section className="provider-field-group provider-catalog-fields">
              <header><span>02</span><div><strong>模型目录</strong><p>使用英文逗号分隔多个模型标识</p></div></header>
              <div className="provider-fields">
                <label className="provider-field-wide"><span>Chat models</span><input onChange={(event) => changeProvider("chat_models", event.target.value)} placeholder="qwen-plus,qwen-max" value={csv(activeProvider.chat_models)} /></label>
                <label className="provider-field-wide"><span>Embedding models</span><input onChange={(event) => changeProvider("embedding_models", event.target.value)} placeholder="text-embedding-v4" value={csv(activeProvider.embedding_models)} /></label>
              </div>
            </section>
          </div>
        </section>
      </div>

      <div className="model-routing model-routing-workspace settings-grid-wide">
        <section className="model-routing-panel default-routing-panel">
          <header className="routing-panel-heading">
            <div><span>Default route</span><h3>全局默认模型</h3><p>未单独指定任务模型时使用这组配置。</p></div>
            <em>基础路由</em>
          </header>
          <div className="model-routing-fields">
            <SelectField label="Chat provider" onChange={(value) => onSettingChange("llm_chat_provider_id", value)} options={providerSelectOptions} value={settings.llm_chat_provider_id} />
            <SelectField label="Chat model" onChange={(value) => onSettingChange("llm_chat_model", value)} options={chatModels.length ? chatModels.map((model) => [model, model]) : [["", "未配置"]]} value={settings.llm_chat_model} />
            <SelectField label="Embedding provider" onChange={(value) => onSettingChange("llm_embedding_provider_id", value)} options={providerSelectOptions} value={settings.llm_embedding_provider_id} />
            <SelectField label="Embedding model" onChange={(value) => onSettingChange("llm_embedding_model", value)} options={embeddingModels.length ? embeddingModels.map((model) => [model, model]) : [["", "未配置"]]} value={settings.llm_embedding_model} />
          </div>
        </section>

        <section className="model-routing-panel task-routing-panel">
          <header className="routing-panel-heading">
            <div><span>Task routes</span><h3>任务模型分配</h3><p>为不同研究环节选择独立的 Provider 和模型。</p></div>
            <em>{TASK_ROUTES.length} 条路由</em>
          </header>
          <div className="reader-model-grid">
            {TASK_ROUTES.map(([providerField, modelField, label, description], index) => {
              const selectedProviderId = settings[providerField] || settings.llm_chat_provider_id || "";
              const models = modelsForProvider(selectedProviderId);
              return (
                <div className="reader-model-row" key={providerField}>
                  <header><i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i><span><strong>{label}</strong><small>{description}</small></span></header>
                  <div className="reader-model-selectors">
                    <SelectField label="Provider" onChange={(value) => onSettingChange(providerField, value)} options={providerSelectOptions} value={selectedProviderId} />
                    <SelectField label="Model" onChange={(value) => onSettingChange(modelField, value)} options={models.length ? models.map((model) => [model, model]) : [["", "未配置"]]} value={settings[modelField] || settings.llm_chat_model} />
                  </div>
                </div>
              );
            })}
            <div className="reader-model-row concurrency-route-row">
              <header><i aria-hidden="true">06</i><span><strong>项目摘要并发</strong><small>限制同时运行的项目摘要请求数量</small></span></header>
              <div className="reader-model-selectors">
                <NumberField label="并发请求数" max="8" min="1" name="project_chat_profile_concurrency" onChange={onSettingChange} step="1" value={settings.project_chat_profile_concurrency ?? 2} />
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className="settings-grid-wide prompt-field model-prompt-panel">
        <header className="routing-panel-heading">
          <div><span>Default instruction</span><h3>论文解读 Prompt</h3><p>用于新建全文解读任务的默认结构化指令。</p></div>
        </header>
        <label><span>Prompt 内容</span><textarea onChange={(event) => onSettingChange("paper_reader_default_prompt", event.target.value)} value={settings.paper_reader_default_prompt || ""} /></label>
      </section>
    </>
  );
}

export function ModelRoutingSettingsView({
  settings = {},
  providers = [],
  onSettingChange = () => {},
  onProviderChange = () => {},
  onAddProvider = () => {},
  onRemoveProvider = () => {},
  onSubmit,
  saveStatus = "idle"
}) {
  return (
    <div className="model-routing-settings-view">
      <header className="settings-subpage-heading">
        <div>
          <span>MODEL ROUTING</span>
          <h2>模型与路由</h2>
          <p>管理模型服务、默认路由，以及不同研究任务使用的模型配置。</p>
        </div>
        <em className={`settings-subpage-save-state is-${saveStatus}`} aria-live="polite">
          {SAVE_STATUS_LABELS[saveStatus] || SAVE_STATUS_LABELS.idle}
        </em>
      </header>
      <form className="settings-form" onSubmit={onSubmit || ((event) => event.preventDefault())}>
        <section className="settings-section model-routing-settings-section">
          <div className="settings-section-head">
            <div><span>Models</span><h3>Provider 与任务模型</h3></div>
            <p>维护 Provider，并把不同研究任务路由到对应模型。</p>
          </div>
          <div className="settings-section-stack">
            <ProviderManager
              onAddProvider={onAddProvider}
              onProviderChange={onProviderChange}
              onRemoveProvider={onRemoveProvider}
              onSettingChange={onSettingChange}
              providers={providers}
              settings={settings}
            />
          </div>
        </section>
      </form>
    </div>
  );
}
