import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { csv } from "../lib/dashboard.js";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/SettingsForm.css";
import "../styles/ModelRoutingSettingsView.css";

const TASK_ROUTES = [
  ["paper_report_provider_id", "paper_report_model", "paperReport"],
  ["project_chat_profile_provider_id", "project_chat_profile_model", "projectProfile"],
  ["reader_chat_provider_id", "reader_chat_model", "readerChat"],
  ["reader_smart_save_provider_id", "reader_smart_save_model", "smartSave"],
  ["reader_question_provider_id", "reader_question_model", "questions"]
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
  const { i18n, t } = useTranslation("settings");
  const [activeProviderIndex, setActiveProviderIndex] = useState(0);
  const rows = providers.length ? providers : [emptyProvider()];
  const activeIndex = Math.min(activeProviderIndex, rows.length - 1);
  const activeProvider = rows[activeIndex] || rows[0];
  const providerOptions = rows.filter((provider) => provider.id);
  const providerSelectOptions = providerOptions.length
    ? providerOptions.map((provider) => [provider.id, provider.name || provider.id])
    : [["", t("models.notConfigured")]];
  const modelsForProvider = (providerId, kind = "chat_models") => {
    const provider = providerOptions.find((item) => item.id === providerId);
    return String(provider?.[kind] || "").split(",").map((item) => item.trim()).filter(Boolean);
  };
  const chatModels = modelsForProvider(settings.llm_chat_provider_id);
  const embeddingModels = modelsForProvider(settings.llm_embedding_provider_id, "embedding_models");
  const promptLocale = String(i18n.resolvedLanguage || i18n.language || "zh-CN").toLowerCase().startsWith("en")
    ? "en"
    : "zh-CN";
  const promptDefaults = settings.paper_reader_prompt_defaults || {};
  const localizedDefaultPrompt = String(
    promptDefaults[promptLocale] || promptDefaults["zh-CN"] || settings.paper_reader_default_prompt || ""
  );
  const customPrompt = String(settings.paper_reader_default_prompt || "");
  const promptMode = settings.paper_reader_prompt_mode === "custom" ? "custom" : "default";
  const promptValue = promptMode === "custom" ? customPrompt : localizedDefaultPrompt;

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

  function changePromptMode(nextMode) {
    if (nextMode === promptMode) return;
    if (
      nextMode === "custom"
      && (!customPrompt.trim() || Object.values(promptDefaults).includes(customPrompt.trim()))
    ) {
      onSettingChange("paper_reader_default_prompt", localizedDefaultPrompt);
    }
    onSettingChange("paper_reader_prompt_mode", nextMode);
    onSettingChange("paper_reader_prompt_locale", promptLocale);
  }

  const changeProvider = (field, value) => onProviderChange?.(activeIndex, field, value);
  const keyText = activeProvider.api_key_configured ? t("models.apiKey.savedHint") : t("models.apiKey.missingHint");

  return (
    <>
      <div className="provider-manager model-provider-studio settings-grid-wide">
        <aside className="provider-sidebar">
          <div className="provider-sidebar-head">
            <div>
              <span>{t("models.providers.eyebrow")}</span>
              <h3>{t("models.providers.title")}</h3>
              <p>{t("models.providers.count", { count: rows.length })}</p>
            </div>
            <button aria-label={t("models.providers.addAria")} onClick={addProvider} type="button"><i aria-hidden="true">＋</i><span>{t("models.providers.add")}</span></button>
          </div>
          <div className="provider-tab-list">
            {rows.map((provider, index) => {
              const chatCount = String(provider.chat_models || "").split(",").filter((item) => item.trim()).length;
              const embeddingCount = String(provider.embedding_models || "").split(",").filter((item) => item.trim()).length;
              const providerName = provider.name || provider.id || t("models.providers.unnamed");
              return (
                <button className={`provider-tab ${index === activeIndex ? "active" : ""}`} key={`${provider.id || "provider"}-${index}`} onClick={() => setActiveProviderIndex(index)} type="button">
                  <i className="provider-tab-mark" aria-hidden="true">{providerName.slice(0, 1).toUpperCase()}</i>
                  <span>
                    <strong>{providerName}</strong>
                    <small>{provider.id || t("models.providers.missingId")} · {t("models.providers.modelCounts", { chat: chatCount, embedding: embeddingCount })}</small>
                  </span>
                  <em className={provider.api_key_configured ? "ok" : "warn"} title={provider.api_key_configured ? t("models.apiKey.saved") : t("models.apiKey.missing")}>
                    <i aria-hidden="true" />
                    {provider.api_key_configured ? t("models.providers.ready") : t("models.providers.pending")}
                  </em>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="provider-editor">
          <div className="provider-editor-head">
            <div>
              <span>{t("models.providers.active")}</span>
              <h3>{activeProvider.name || activeProvider.id || t("models.providers.configuration")}</h3>
              <p>{activeProvider.base_url || t("models.providers.baseUrlMissing")}</p>
            </div>
            <div className="provider-editor-actions">
              <span className={`provider-connection-state ${activeProvider.api_key_configured ? "is-ready" : "is-pending"}`}><b>{activeProvider.api_key_configured ? t("models.providers.credentialsSaved") : t("models.providers.awaitingCredentials")}</b></span>
              <button className="danger" onClick={removeProvider} type="button">{t("models.providers.remove")}</button>
            </div>
          </div>
          <div className="provider-editor-body">
            <section className="provider-field-group provider-identity-fields">
              <header><span>01</span><div><strong>{t("models.connection.title")}</strong><p>{t("models.connection.description")}</p></div></header>
              <div className="provider-fields">
                <label><span>{t("models.connection.providerId")}</span><input onChange={(event) => changeProvider("id", event.target.value)} placeholder="qwen" value={activeProvider.id || ""} /></label>
                <label><span>{t("models.connection.displayName")}</span><input onChange={(event) => changeProvider("name", event.target.value)} placeholder="Qwen" value={activeProvider.name || ""} /></label>
                <label className="provider-field-wide"><span>{t("models.connection.baseUrl")}</span><input onChange={(event) => changeProvider("base_url", event.target.value)} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" value={activeProvider.base_url || ""} /></label>
                <label className="provider-field-wide"><span>{t("models.connection.apiKey")}</span><input onChange={(event) => changeProvider("api_key", event.target.value)} placeholder={keyText} type="password" value={activeProvider.api_key || ""} /></label>
                <label className="settings-checkbox-row provider-clear-key">
                  <input checked={Boolean(activeProvider.clear_api_key)} className="settings-checkbox-input" onChange={(event) => changeProvider("clear_api_key", event.target.checked)} type="checkbox" />
                  <span className="settings-checkbox-mark" aria-hidden="true"><svg fill="none" viewBox="0 0 12 12"><path d="m2.5 6.2 2.2 2.2 4.8-5" /></svg></span>
                  <span className="settings-checkbox-label">{t("models.connection.clearApiKey")}</span>
                </label>
              </div>
            </section>
            <section className="provider-field-group provider-catalog-fields">
              <header><span>02</span><div><strong>{t("models.catalog.title")}</strong><p>{t("models.catalog.description")}</p></div></header>
              <div className="provider-fields">
                <label className="provider-field-wide"><span>{t("models.catalog.chatModels")}</span><input onChange={(event) => changeProvider("chat_models", event.target.value)} placeholder="qwen-plus,qwen-max" value={csv(activeProvider.chat_models)} /></label>
                <label className="provider-field-wide"><span>{t("models.catalog.embeddingModels")}</span><input onChange={(event) => changeProvider("embedding_models", event.target.value)} placeholder="text-embedding-v4" value={csv(activeProvider.embedding_models)} /></label>
              </div>
            </section>
          </div>
        </section>
      </div>

      <div className="model-routing model-routing-workspace settings-grid-wide">
        <section className="model-routing-panel default-routing-panel">
          <header className="routing-panel-heading">
            <div><span>{t("models.defaultRoute.eyebrow")}</span><h3>{t("models.defaultRoute.title")}</h3><p>{t("models.defaultRoute.description")}</p></div>
            <em>{t("models.defaultRoute.badge")}</em>
          </header>
          <div className="model-routing-fields">
            <SelectField label={t("models.defaultRoute.chatProvider")} onChange={(value) => onSettingChange("llm_chat_provider_id", value)} options={providerSelectOptions} value={settings.llm_chat_provider_id} />
            <SelectField label={t("models.defaultRoute.chatModel")} onChange={(value) => onSettingChange("llm_chat_model", value)} options={chatModels.length ? chatModels.map((model) => [model, model]) : [["", t("models.notConfigured")]]} value={settings.llm_chat_model} />
            <SelectField label={t("models.defaultRoute.embeddingProvider")} onChange={(value) => onSettingChange("llm_embedding_provider_id", value)} options={providerSelectOptions} value={settings.llm_embedding_provider_id} />
            <SelectField label={t("models.defaultRoute.embeddingModel")} onChange={(value) => onSettingChange("llm_embedding_model", value)} options={embeddingModels.length ? embeddingModels.map((model) => [model, model]) : [["", t("models.notConfigured")]]} value={settings.llm_embedding_model} />
          </div>
        </section>

        <section className="model-routing-panel task-routing-panel">
          <header className="routing-panel-heading">
            <div><span>{t("models.taskRoutes.eyebrow")}</span><h3>{t("models.taskRoutes.title")}</h3><p>{t("models.taskRoutes.description")}</p></div>
            <em>{t("models.taskRoutes.count", { count: TASK_ROUTES.length })}</em>
          </header>
          <div className="reader-model-grid">
            {TASK_ROUTES.map(([providerField, modelField, routeKey], index) => {
              const selectedProviderId = settings[providerField] || settings.llm_chat_provider_id || "";
              const models = modelsForProvider(selectedProviderId);
              return (
                <div className="reader-model-row" key={providerField}>
                  <header><i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i><span><strong>{t(`models.taskRoutes.routes.${routeKey}.title`)}</strong><small>{t(`models.taskRoutes.routes.${routeKey}.description`)}</small></span></header>
                  <div className="reader-model-selectors">
                    <SelectField label={t("models.taskRoutes.provider")} onChange={(value) => onSettingChange(providerField, value)} options={providerSelectOptions} value={selectedProviderId} />
                    <SelectField label={t("models.taskRoutes.model")} onChange={(value) => onSettingChange(modelField, value)} options={models.length ? models.map((model) => [model, model]) : [["", t("models.notConfigured")]]} value={settings[modelField] || settings.llm_chat_model} />
                  </div>
                </div>
              );
            })}
            <div className="reader-model-row concurrency-route-row">
              <header><i aria-hidden="true">06</i><span><strong>{t("models.concurrency.title")}</strong><small>{t("models.concurrency.description")}</small></span></header>
              <div className="reader-model-selectors">
                <NumberField label={t("models.concurrency.field")} max="8" min="1" name="project_chat_profile_concurrency" onChange={onSettingChange} step="1" value={settings.project_chat_profile_concurrency ?? 2} />
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className="settings-grid-wide prompt-field model-prompt-panel">
        <header className="routing-panel-heading">
          <div><span>{t("models.prompt.eyebrow")}</span><h3>{t("models.prompt.title")}</h3><p>{t("models.prompt.description")}</p></div>
        </header>
        <div className="paper-prompt-editor">
          <div className="paper-prompt-mode-row">
            <span>
              <strong>{t("models.prompt.mode.label")}</strong>
              <small>{t(`models.prompt.mode.${promptMode}Hint`)}</small>
            </span>
            <div className="paper-prompt-mode-control" role="radiogroup" aria-label={t("models.prompt.mode.label")}>
              {["default", "custom"].map((mode) => (
                <button
                  aria-checked={promptMode === mode}
                  className={promptMode === mode ? "active" : ""}
                  key={mode}
                  onClick={() => changePromptMode(mode)}
                  role="radio"
                  type="button"
                >
                  {t(`models.prompt.mode.${mode}`)}
                </button>
              ))}
            </div>
          </div>
          <label>
            <span>{t(promptMode === "custom" ? "models.prompt.customField" : "models.prompt.defaultField")}</span>
            <textarea
              aria-describedby="paper-prompt-language-hint"
              onChange={(event) => onSettingChange("paper_reader_default_prompt", event.target.value)}
              readOnly={promptMode === "default"}
              value={promptValue}
            />
          </label>
          <small className="paper-prompt-language-hint" id="paper-prompt-language-hint">
            {t("models.prompt.languageHint", { language: t(`models.prompt.languages.${promptLocale}`) })}
          </small>
        </div>
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
  const { t } = useTranslation("settings");
  return (
    <div className="model-routing-settings-view">
      <header className="settings-subpage-heading">
        <div>
          <span>{t("models.eyebrow")}</span>
          <h2>{t("models.title")}</h2>
          <p>{t("models.description")}</p>
        </div>
        <em className={`settings-subpage-save-state is-${saveStatus}`} aria-live="polite">
          {t(`saveStatus.${saveStatus}`, { defaultValue: t("saveStatus.idle") })}
        </em>
      </header>
      <form className="settings-form" onSubmit={onSubmit || ((event) => event.preventDefault())}>
        <section className="settings-section model-routing-settings-section">
          <div className="settings-section-head">
            <div><span>{t("models.section.eyebrow")}</span><h3>{t("models.section.title")}</h3></div>
            <p>{t("models.section.description")}</p>
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
