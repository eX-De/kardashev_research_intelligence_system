import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { csv } from "../lib/dashboard.js";
import { OPENROUTER_BASE_URL, providerType } from "../lib/settingsProviders.js";
import openRouterGlyphDark from "../assets/openrouter-glyph-dark.svg";
import openRouterGlyphLight from "../assets/openrouter-glyph-light.svg";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import { LocalizedPromptEditor } from "./LocalizedPromptEditor.jsx";
import "../styles/SettingsForm.css";
import "../styles/OpenRouterModelSettings.css";

// Task routes share the provider catalog, while provider configuration stays split by integration type.
const TASK_ROUTES = [
  ["paper_report_provider_id", "paper_report_model", "paperReport"],
  ["project_chat_profile_provider_id", "project_chat_profile_model", "projectProfile"],
  ["reader_chat_provider_id", "reader_chat_model", "readerChat"],
  ["reader_smart_save_provider_id", "reader_smart_save_model", "smartSave"],
  ["reader_question_provider_id", "reader_question_model", "questions"]
];

const EFFORT_OPTIONS = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
const SORT_OPTIONS = ["", "price", "throughput", "latency"];
function OpenRouterLogo({ className = "" }) {
  return (
    <span aria-hidden="true" className={`openrouter-logo ${className}`.trim()}>
      <img className="openrouter-logo-dark" src={openRouterGlyphDark} />
      <img className="openrouter-logo-light" src={openRouterGlyphLight} />
    </span>
  );
}

function OpenRouterBadge({ t }) {
  return <span className="openrouter-official-badge"><OpenRouterLogo />{t("models.openrouter.officialBadge")}</span>;
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
      <input max={max} min={min} name={name} onChange={(event) => onChange(name, event.target.value)} step={step} type="number" value={value ?? ""} />
    </label>
  );
}

function CredentialFields({ provider, isOpenRouter, changeProvider, t }) {
  const keyText = provider.api_key_configured ? t("models.apiKey.savedHint") : t("models.apiKey.missingHint");
  return (
    <section className="provider-field-group provider-identity-fields">
      <header>
        {isOpenRouter ? <OpenRouterLogo className="provider-step-logo" /> : <span>01</span>}
        <div>
          <strong>{t("models.connection.title")}</strong>
          <p>{isOpenRouter ? OPENROUTER_BASE_URL : t("models.connection.description")}</p>
        </div>
      </header>
      <div className="provider-fields">
        <label><span>{t("models.connection.providerId")}</span><input onChange={(event) => changeProvider("id", event.target.value)} placeholder={isOpenRouter ? "openrouter" : "qwen"} value={provider.id || ""} /></label>
        <label><span>{t("models.connection.displayName")}</span><input onChange={(event) => changeProvider("name", event.target.value)} placeholder={isOpenRouter ? "OpenRouter" : "Qwen"} value={provider.name || ""} /></label>
        {!isOpenRouter ? <label className="provider-field-wide"><span>{t("models.connection.baseUrl")}</span><input onChange={(event) => changeProvider("base_url", event.target.value)} placeholder="https://example.com/v1" value={provider.base_url || ""} /></label> : null}
        <label className="provider-field-wide"><span>{t("models.connection.apiKey")}</span><input onChange={(event) => changeProvider("api_key", event.target.value)} placeholder={keyText} type="password" value={provider.api_key || ""} /></label>
        <label className="settings-checkbox-row provider-clear-key">
          <input checked={Boolean(provider.clear_api_key)} className="settings-checkbox-input" onChange={(event) => changeProvider("clear_api_key", event.target.checked)} type="checkbox" />
          <span className="settings-checkbox-mark" aria-hidden="true"><svg fill="none" viewBox="0 0 12 12"><path d="m2.5 6.2 2.2 2.2 4.8-5" /></svg></span>
          <span className="settings-checkbox-label">{t("models.connection.clearApiKey")}</span>
        </label>
      </div>
    </section>
  );
}

function OpenRouterPolicies({ provider, changeProvider, t }) {
  const models = String(provider.chat_models || "").split(",").map((item) => item.trim()).filter(Boolean);
  const policies = provider.openrouter_model_policies || {};

  function changePolicy(model, field, value) {
    changeProvider("openrouter_model_policies", {
      ...policies,
      [model]: {
        reasoning_effort: "",
        provider_only: "",
        provider_sort: "",
        ...(policies[model] || {}),
        [field]: value
      }
    });
  }

  return (
    <section className="provider-field-group openrouter-model-policy-fields">
      <header><span>03</span><div><strong>{t("models.openrouter.title")}</strong><p>{t("models.catalog.description")}</p></div></header>
      {models.length ? (
        <div className="openrouter-model-policy-list">
          {models.map((model) => {
            const policy = policies[model] || {};
            return (
              <article className="openrouter-model-policy" key={model}>
                <header><strong>{model}</strong></header>
                <div className="provider-fields">
                  <label>
                    <span>{t("models.openrouter.reasoningEffort")}</span>
                    <WorkspaceSelect ariaLabel={`${model} ${t("models.openrouter.reasoningEffort")}`} onChange={(value) => changePolicy(model, "reasoning_effort", value)} options={EFFORT_OPTIONS.map((effort) => [effort, effort || t("models.openrouter.efforts.default")])} value={policy.reasoning_effort || ""} />
                  </label>
                  <label>
                    <span>{t("models.openrouter.providerSort")}</span>
                    <WorkspaceSelect ariaLabel={`${model} ${t("models.openrouter.providerSort")}`} onChange={(value) => changePolicy(model, "provider_sort", value)} options={SORT_OPTIONS.map((sort) => [sort, t(`models.openrouter.sorts.${sort || "auto"}`)])} value={policy.provider_sort || ""} />
                  </label>
                  <label className="provider-field-wide">
                    <span>{t("models.openrouter.providerOnly")}</span>
                    <input onChange={(event) => changePolicy(model, "provider_only", event.target.value)} placeholder="openai, azure" value={csv(policy.provider_only)} />
                    <small>{t("models.openrouter.providerOnlyHint")}</small>
                  </label>
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="openrouter-policy-empty">{t("models.notConfigured")}</p>}
    </section>
  );
}

function ProviderCatalogFields({ provider, isOpenRouter, changeProvider, t }) {
  const chatCount = String(provider.chat_models || "").split(",").filter((item) => item.trim()).length;
  const embeddingCount = String(provider.embedding_models || "").split(",").filter((item) => item.trim()).length;
  return (
    <section className="provider-field-group provider-catalog-fields">
      <header><span>02</span><div><strong>{t("models.catalog.title")}</strong><p>{t("models.catalog.description")}</p></div></header>
      <div className="provider-fields">
        <label className="provider-field-wide"><span>{t("models.catalog.chatModels")}</span><input onChange={(event) => changeProvider("chat_models", event.target.value)} placeholder={isOpenRouter ? "openai/gpt-5, deepseek/deepseek-chat" : "qwen-plus, qwen-max"} value={csv(provider.chat_models)} /></label>
        <label className="provider-field-wide"><span>{t("models.catalog.embeddingModels")}</span><input onChange={(event) => changeProvider("embedding_models", event.target.value)} placeholder={isOpenRouter ? "openai/text-embedding-3-small" : "text-embedding-v4"} value={csv(provider.embedding_models)} /></label>
        <small>{t("models.providers.modelCounts", { chat: chatCount, embedding: embeddingCount })}</small>
      </div>
    </section>
  );
}

function OpenRouterStudio({ providers, onAddProvider, onProviderChange, onRemoveProvider }) {
  const { t } = useTranslation("settings");
  const activeEntry = providers.map((provider, index) => ({ provider, index })).find(({ provider }) => providerType(provider) === "openrouter");

  if (!activeEntry) {
    return (
      <section className="provider-connect-workspace is-openrouter settings-grid-wide">
        <div className="provider-connect-copy">
          <OpenRouterLogo className="provider-connect-brand" />
          <div><h3>OpenRouter</h3><p>{OPENROUTER_BASE_URL}</p></div>
        </div>
        <button className="provider-connect-button is-openrouter" onClick={() => onAddProvider?.("openrouter")} type="button">
          <OpenRouterLogo className="provider-connect-icon" />
          <span><strong>{t("models.providers.addOpenRouter")}</strong></span>
          <b aria-hidden="true">→</b>
        </button>
      </section>
    );
  }

  const provider = activeEntry.provider;
  const changeProvider = (field, value) => onProviderChange?.(activeEntry.index, field, value);
  return (
    <section className="openrouter-provider-workspace settings-grid-wide">
      <header className="openrouter-provider-head">
        <div className="openrouter-provider-identity">
          <OpenRouterBadge t={t} />
          <div><h3>{provider.name || "OpenRouter"}</h3><p>{OPENROUTER_BASE_URL}</p></div>
        </div>
        <div className="provider-editor-actions">
          <span className={`provider-connection-state ${provider.api_key_configured ? "is-ready" : "is-pending"}`}><b>{provider.api_key_configured ? t("models.providers.credentialsSaved") : t("models.providers.awaitingCredentials")}</b></span>
          <button onClick={() => onRemoveProvider?.(activeEntry.index)} type="button">{t("models.providers.remove")}</button>
        </div>
      </header>
      <div className="openrouter-provider-body">
        <CredentialFields changeProvider={changeProvider} isOpenRouter provider={provider} t={t} />
        <ProviderCatalogFields changeProvider={changeProvider} isOpenRouter provider={provider} t={t} />
        <OpenRouterPolicies changeProvider={changeProvider} provider={provider} t={t} />
      </div>
    </section>
  );
}

function CompatibleProviderStudio({ providers, onAddProvider, onProviderChange, onRemoveProvider }) {
  const { t } = useTranslation("settings");
  const [activePosition, setActivePosition] = useState(0);
  const entries = providers.map((provider, index) => ({ provider, index })).filter(({ provider }) => providerType(provider) === "openai_compatible");
  const activeIndex = Math.min(activePosition, Math.max(entries.length - 1, 0));
  const activeEntry = entries[activeIndex];

  useEffect(() => {
    if (activePosition > entries.length - 1) setActivePosition(Math.max(entries.length - 1, 0));
  }, [activePosition, entries.length]);

  function addProvider() {
    onAddProvider?.("generic");
    setActivePosition(entries.length);
  }

  if (!activeEntry) {
    return (
      <section className="provider-connect-workspace is-compatible settings-grid-wide">
        <div className="provider-connect-copy">
          <i className="provider-connect-brand compatible-brand" aria-hidden="true">API</i>
          <div><h3>{t("models.connection.types.compatible")}</h3><p>{t("models.connection.description")}</p></div>
        </div>
        <button className="provider-connect-button is-compatible" onClick={addProvider} type="button">
          <i className="provider-connect-icon" aria-hidden="true">＋</i>
          <span><strong>{t("models.providers.addCompatible")}</strong></span>
          <b aria-hidden="true">→</b>
        </button>
      </section>
    );
  }

  const provider = activeEntry.provider;
  const changeProvider = (field, value) => onProviderChange?.(activeEntry.index, field, value);

  return (
    <div className="provider-manager model-provider-studio provider-studio-openai_compatible settings-grid-wide">
      <aside className="provider-sidebar">
        <div className="provider-sidebar-head">
          <div><span>OPENAI-COMPATIBLE</span><h3>{t("models.connection.types.compatible")}</h3><p>{t("models.providers.count", { count: entries.length })}</p></div>
          <button onClick={addProvider} type="button"><i aria-hidden="true">＋</i><span>{t("models.providers.add")}</span></button>
        </div>
        <div className="provider-tab-list">
          {entries.map(({ provider: row }, position) => {
            const name = row.name || row.id || t("models.providers.unnamed");
            return (
              <button className={`provider-tab ${position === activeIndex ? "active" : ""}`} key={`${row.id}-${position}`} onClick={() => setActivePosition(position)} type="button">
                <i className="provider-tab-mark" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</i>
                <span><strong>{name}</strong><small>{row.id || t("models.providers.missingId")}</small></span>
                <em className={row.api_key_configured ? "ok" : "warn"}><i aria-hidden="true" />{row.api_key_configured ? t("models.providers.ready") : t("models.providers.pending")}</em>
              </button>
            );
          })}
        </div>
      </aside>
      <section className="provider-editor">
        <div className="provider-editor-head">
          <div><span>{t("models.providers.compatible")}</span><h3>{provider.name || provider.id}</h3><p>{provider.base_url || t("models.providers.baseUrlMissing")}</p></div>
          <div className="provider-editor-actions">
            <span className={`provider-connection-state ${provider.api_key_configured ? "is-ready" : "is-pending"}`}><b>{provider.api_key_configured ? t("models.providers.credentialsSaved") : t("models.providers.awaitingCredentials")}</b></span>
            <button onClick={() => onRemoveProvider?.(activeEntry.index)} type="button">{t("models.providers.remove")}</button>
          </div>
        </div>
        <div className="provider-editor-body">
          <CredentialFields changeProvider={changeProvider} isOpenRouter={false} provider={provider} t={t} />
          <ProviderCatalogFields changeProvider={changeProvider} isOpenRouter={false} provider={provider} t={t} />
        </div>
      </section>
    </div>
  );
}

function ProviderAndRouting({ providers, settings, onAddProvider, onProviderChange, onRemoveProvider, onSettingChange }) {
  const { t } = useTranslation("settings");
  const providerOptions = providers.filter((provider) => provider.id);
  const providerSelectOptions = providerOptions.length ? providerOptions.map((provider) => [provider.id, provider.name || provider.id]) : [["", t("models.notConfigured")]];
  const modelsForProvider = (providerId, kind = "chat_models") => String(providerOptions.find((item) => item.id === providerId)?.[kind] || "").split(",").map((item) => item.trim()).filter(Boolean);
  const chatModels = modelsForProvider(settings.llm_chat_provider_id);
  const embeddingModels = modelsForProvider(settings.llm_embedding_provider_id, "embedding_models");
  return (
    <>
      <OpenRouterStudio onAddProvider={onAddProvider} onProviderChange={onProviderChange} onRemoveProvider={onRemoveProvider} providers={providers} />
      <CompatibleProviderStudio onAddProvider={onAddProvider} onProviderChange={onProviderChange} onRemoveProvider={onRemoveProvider} providers={providers} />
      <div className="model-routing model-routing-workspace settings-grid-wide">
        <section className="model-routing-panel default-routing-panel">
          <header className="routing-panel-heading"><div><span>{t("models.defaultRoute.eyebrow")}</span><h3>{t("models.defaultRoute.title")}</h3><p>{t("models.defaultRoute.description")}</p></div><em>{t("models.defaultRoute.badge")}</em></header>
          <div className="model-routing-fields">
            <SelectField label={t("models.defaultRoute.chatProvider")} onChange={(value) => onSettingChange("llm_chat_provider_id", value)} options={providerSelectOptions} value={settings.llm_chat_provider_id} />
            <SelectField label={t("models.defaultRoute.chatModel")} onChange={(value) => onSettingChange("llm_chat_model", value)} options={chatModels.length ? chatModels.map((model) => [model, model]) : [["", t("models.notConfigured")]]} value={settings.llm_chat_model} />
            <SelectField label={t("models.defaultRoute.embeddingProvider")} onChange={(value) => onSettingChange("llm_embedding_provider_id", value)} options={providerSelectOptions} value={settings.llm_embedding_provider_id} />
            <SelectField label={t("models.defaultRoute.embeddingModel")} onChange={(value) => onSettingChange("llm_embedding_model", value)} options={embeddingModels.length ? embeddingModels.map((model) => [model, model]) : [["", t("models.notConfigured")]]} value={settings.llm_embedding_model} />
          </div>
        </section>
        <section className="model-routing-panel task-routing-panel">
          <header className="routing-panel-heading"><div><span>{t("models.taskRoutes.eyebrow")}</span><h3>{t("models.taskRoutes.title")}</h3><p>{t("models.taskRoutes.description")}</p></div><em>{t("models.taskRoutes.count", { count: TASK_ROUTES.length })}</em></header>
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
              <div className="reader-model-selectors"><NumberField label={t("models.concurrency.field")} max="8" min="1" name="project_chat_profile_concurrency" onChange={onSettingChange} step="1" value={settings.project_chat_profile_concurrency ?? 2} /></div>
            </div>
          </div>
        </section>
      </div>
      <section className="settings-grid-wide prompt-field model-prompt-panel">
        <header className="routing-panel-heading"><div><span>{t("models.prompt.eyebrow")}</span><h3>{t("models.prompt.title")}</h3><p>{t("models.prompt.description")}</p></div></header>
        <LocalizedPromptEditor customPromptField="paper_reader_default_prompt" defaultsField="paper_reader_prompt_defaults" editorId="paper-reader-prompt" localeField="paper_reader_prompt_locale" modeField="paper_reader_prompt_mode" onSettingChange={onSettingChange} settings={settings} translationPrefix="models.prompt" />
      </section>
    </>
  );
}

export function ModelRoutingSettingsView({ settings = {}, providers = [], onSettingChange = () => {}, onProviderChange = () => {}, onAddProvider = () => {}, onRemoveProvider = () => {}, onSubmit, saveStatus = "idle" }) {
  const { t } = useTranslation("settings");
  return (
    <div className="model-routing-settings-view">
      <header className="settings-subpage-heading"><div><span>{t("models.eyebrow")}</span><h2>{t("models.title")}</h2><p>{t("models.description")}</p></div><em className={`settings-subpage-save-state is-${saveStatus}`} aria-live="polite">{t(`saveStatus.${saveStatus}`, { defaultValue: t("saveStatus.idle") })}</em></header>
      <form className="settings-form" onSubmit={onSubmit || ((event) => event.preventDefault())}>
        <section className="settings-section model-routing-settings-section">
          <div className="settings-section-head"><div><span>{t("models.section.eyebrow")}</span><h3>{t("models.section.title")}</h3></div><p>{t("models.section.description")}</p></div>
          <div className="settings-section-stack"><ProviderAndRouting onAddProvider={onAddProvider} onProviderChange={onProviderChange} onRemoveProvider={onRemoveProvider} onSettingChange={onSettingChange} providers={providers} settings={settings} /></div>
        </section>
      </form>
    </div>
  );
}
