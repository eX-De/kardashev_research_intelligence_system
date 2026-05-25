import { useCallback, useEffect, useRef, useState } from "react";

import { PanelTitle } from "./PanelTitle.jsx";
import { normalizeProviders, providerPayload, SettingsForm } from "./SettingsForm.jsx";
import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, chooseLocalPath, postJson } from "../lib/dashboard.js";
import { friendlyObsidianMessage, obsidianCapabilityFrom } from "../lib/obsidianCapability.js";

const AUTO_SAVE_DELAY_MS = 850;
const QUICK_SAVE_DELAY_MS = 150;
const QUICK_SAVE_FIELDS = new Set([
  "arxiv_cache_full_text",
  "rag_prefilter_enabled",
  "run_daily_on_startup_enabled",
  "scheduler_enabled"
]);
const SUCCESS_TOAST_THROTTLE_MS = 2500;

function settingsPayload(settings, providers) {
  const payload = {
    ...settings,
    llm_providers: providerPayload(providers)
  };
  if (payload.scheduler_enabled && payload.run_daily_on_startup_enabled) {
    payload.run_daily_on_startup_enabled = false;
  }
  return payload;
}

function settingsSignature(settings, providers) {
  return JSON.stringify(settingsPayload(settings, providers));
}

function HealthItem({ label, value, state = "neutral" }) {
  return (
    <div className={`health-item ${state}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HealthGrid({ health, settings }) {
  const obsidianCapability = obsidianCapabilityFrom({ health, settings });
  const llmState = health?.llm?.configured ? "ok" : "warn";
  return (
    <div className="health-grid">
      <HealthItem label="Database" value={health?.database?.ok ? "OK" : "Error"} state={health?.database?.ok ? "ok" : "bad"} />
      <HealthItem label="Obsidian" value={obsidianCapability.label} state={obsidianCapability.state} />
      <HealthItem label="LLM" value={health?.llm?.configured ? `${health.llm.providers?.length || 0} providers` : "Not configured"} state={llmState} />
    </div>
  );
}

export function ControlView({ setStatusMessage = () => {}, notify = () => {} }) {
  const [settings, setSettings] = useState({});
  const [providers, setProviders] = useState([]);
  const [saveStatus, setSaveStatus] = useState("idle");
  const settingsRef = useRef(settings);
  const providersRef = useRef(providers);
  const hydratedRef = useRef(false);
  const editVersionRef = useRef(0);
  const saveRequestRef = useRef(0);
  const saveTimerRef = useRef(null);
  const pendingAutosaveRef = useRef(null);
  const lastSavedSignatureRef = useRef("");
  const lastSuccessToastAtRef = useRef(0);
  const cache = useApiCacheClient();
  const settingsQuery = useCachedApi(["settings"], () => api("/api/settings"), { staleTime: Infinity });
  const jobStatusQuery = useCachedApi(["jobs", "status"], () => api("/api/jobs/status"), { staleTime: 5000 });
  const healthQuery = useCachedApi(["health"], () => api("/api/health"), { staleTime: 30000 });
  const refreshSettingsCache = settingsQuery.refresh;
  const refreshJobStatusCache = jobStatusQuery.refresh;
  const refreshHealthCache = healthQuery.refresh;
  const health = healthQuery.data || null;

  settingsRef.current = settings;
  providersRef.current = providers;

  const hydrateSettings = useCallback((settingsData, { force = false } = {}) => {
    const nextSettings = settingsData?.settings || {};
    const nextProviders = normalizeProviders(nextSettings.llm_providers || []);
    const nextSignature = settingsSignature(nextSettings, nextProviders);
    const currentSignature = settingsSignature(settingsRef.current, providersRef.current);
    const dirty = hydratedRef.current && currentSignature !== lastSavedSignatureRef.current;
    if (!force && dirty) return false;
    if (!force && hydratedRef.current && nextSignature === lastSavedSignatureRef.current) return true;
    lastSavedSignatureRef.current = nextSignature;
    hydratedRef.current = true;
    setSettings(nextSettings);
    setProviders(nextProviders);
    setSaveStatus("idle");
    return true;
  }, []);

  const refreshControl = useCallback(async ({ hydrate = false } = {}) => {
    const [settingsData, statusData] = await Promise.all([
      hydrate ? refreshSettingsCache({ force: true }) : Promise.resolve(null),
      refreshJobStatusCache({ force: true }),
      refreshHealthCache({ force: true })
    ]);
    if (hydrate) hydrateSettings(settingsData, { force: true });
    const current = statusData.scheduler?.current_job;
    setStatusMessage(current ? `Running ${current.command}...` : statusData.scheduler?.last_job?.message || statusData.scheduler?.last_error?.message || "Idle");
  }, [hydrateSettings, refreshHealthCache, refreshJobStatusCache, refreshSettingsCache, setStatusMessage]);

  useEffect(() => {
    if (settingsQuery.data?.settings) hydrateSettings(settingsQuery.data);
  }, [hydrateSettings, settingsQuery.data]);

  useEffect(() => {
    if (!jobStatusQuery.data?.scheduler) return;
    const scheduler = jobStatusQuery.data.scheduler;
    const current = scheduler.current_job;
    setStatusMessage(current ? `Running ${current.command}...` : scheduler.last_job?.message || scheduler.last_error?.message || "Idle");
  }, [jobStatusQuery.data, setStatusMessage]);

  useEffect(() => {
    const error = settingsQuery.error || jobStatusQuery.error || healthQuery.error;
    if (error) setStatusMessage(error.message);
  }, [healthQuery.error, jobStatusQuery.error, setStatusMessage, settingsQuery.error]);

  const showSaveSuccess = useCallback(({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastSuccessToastAtRef.current < SUCCESS_TOAST_THROTTLE_MS) return;
    lastSuccessToastAtRef.current = now;
    notify("设置已保存", { type: "success" });
  }, [notify]);

  const saveCurrentSettings = useCallback(async ({ notifyOnSuccess = false, forceSuccessToast = false, force = false } = {}) => {
    const payload = settingsPayload(settingsRef.current, providersRef.current);
    const requestedSignature = JSON.stringify(payload);
    if (!force && requestedSignature === lastSavedSignatureRef.current) {
      setSaveStatus("idle");
      return;
    }

    const requestId = saveRequestRef.current + 1;
    const editVersion = editVersionRef.current;
    saveRequestRef.current = requestId;
    setSaveStatus("saving");
    setStatusMessage("Saving settings...");

    try {
      const data = await postJson("/api/settings", payload);
      if (requestId !== saveRequestRef.current || editVersion !== editVersionRef.current) return;

      const savedSettings = data.settings || payload;
      const savedProviders = normalizeProviders(savedSettings.llm_providers || payload.llm_providers || []);
      cache.setCache(["settings"], data);
      if (data.scheduler) cache.setCache(["jobs", "status"], { scheduler: data.scheduler });
      cache.markStale(["health"]);
      lastSavedSignatureRef.current = settingsSignature(savedSettings, savedProviders);
      setSettings(savedSettings);
      setProviders(savedProviders);
      setSaveStatus("saved");
      setStatusMessage("Settings saved");
      if (notifyOnSuccess) showSaveSuccess({ force: forceSuccessToast });
      refreshControl({ hydrate: false }).catch((error) => setStatusMessage(error.message));
    } catch (error) {
      if (requestId !== saveRequestRef.current || editVersion !== editVersionRef.current) return;
      setSaveStatus("error");
      setStatusMessage(error.message);
      notify(error.message, { type: "error" });
    }
  }, [notify, refreshControl, setStatusMessage, showSaveSuccess]);

  useEffect(() => {
    if (!hydratedRef.current) return undefined;

    const currentSignature = settingsSignature(settings, providers);
    if (currentSignature === lastSavedSignatureRef.current) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setSaveStatus((current) => current === "saved" ? current : "idle");
      return undefined;
    }

    const autosave = pendingAutosaveRef.current || {};
    pendingAutosaveRef.current = null;
    setSaveStatus("dirty");
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveCurrentSettings({
        notifyOnSuccess: Boolean(autosave.notifyOnSuccess),
        forceSuccessToast: Boolean(autosave.forceSuccessToast)
      });
    }, autosave.delay ?? AUTO_SAVE_DELAY_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [providers, saveCurrentSettings, settings]);

  function queueAutosave(options = {}) {
    editVersionRef.current += 1;
    const current = pendingAutosaveRef.current || {};
    const nextDelay = options.delay ?? AUTO_SAVE_DELAY_MS;
    pendingAutosaveRef.current = {
      delay: Math.min(current.delay ?? nextDelay, nextDelay),
      notifyOnSuccess: Boolean(current.notifyOnSuccess || options.notifyOnSuccess),
      forceSuccessToast: Boolean(current.forceSuccessToast || options.forceSuccessToast)
    };
  }

  function nextProviderId(currentProviders) {
    const existing = new Set(currentProviders.map((provider) => provider.id).filter(Boolean));
    let index = currentProviders.length + 1;
    let id = `provider_${index}`;
    while (existing.has(id)) {
      index += 1;
      id = `provider_${index}`;
    }
    return id;
  }

  function updateSetting(name, value, options = {}) {
    queueAutosave({
      ...options,
      delay: options.delay ?? (QUICK_SAVE_FIELDS.has(name) ? QUICK_SAVE_DELAY_MS : AUTO_SAVE_DELAY_MS)
    });
    setSettings((current) => {
      const next = { ...current, [name]: value };
      if (name === "run_daily_on_startup_enabled" && value) next.scheduler_enabled = false;
      if (name === "scheduler_enabled" && value) next.run_daily_on_startup_enabled = false;
      return next;
    });
  }

  function updateProvider(index, field, value) {
    queueAutosave({
      delay: field === "clear_api_key" ? QUICK_SAVE_DELAY_MS : AUTO_SAVE_DELAY_MS
    });
    setProviders((current) => current.map((provider, providerIndex) => providerIndex === index ? { ...provider, [field]: value } : provider));
  }

  async function pickPath(name, { mode, relativeTo, title }) {
    setStatusMessage("正在打开本地路径选择器...");
    try {
      const data = await chooseLocalPath({
        mode,
        title,
        relativeTo,
        basePath: relativeTo === "obsidian_vault" ? settingsRef.current.obsidian_vault_path : undefined
      });
      if (data.cancelled) {
        setStatusMessage("已取消路径选择");
        notify("已取消路径选择", { type: "info" });
        return;
      }
      updateSetting(name, data.relative_path ?? data.path ?? "", {
        delay: QUICK_SAVE_DELAY_MS,
        notifyOnSuccess: true
      });
      setStatusMessage("路径已选择");
      notify("路径已选择，正在保存", { type: "info" });
    } catch (error) {
      const message = relativeTo === "obsidian_vault" ? friendlyObsidianMessage(error) : error.message;
      setStatusMessage(message);
      notify(message, { type: "error" });
    }
  }

  function saveSettings(event) {
    event.preventDefault();
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveCurrentSettings({
      notifyOnSuccess: true,
      forceSuccessToast: true,
      force: true
    });
  }

  function addProvider() {
    queueAutosave({
      delay: QUICK_SAVE_DELAY_MS,
      notifyOnSuccess: true
    });
    setProviders((current) => [...current, { id: nextProviderId(current), name: "", base_url: "", api_key: "", chat_models: "", embedding_models: "", clear_api_key: false }]);
  }

  function removeProvider(index) {
    queueAutosave({
      delay: QUICK_SAVE_DELAY_MS,
      notifyOnSuccess: true
    });
    setProviders((current) => {
      const next = current.filter((_, providerIndex) => providerIndex !== index);
      return next.length ? next : [{ id: "default", name: "Default", base_url: "", api_key: "", chat_models: "", embedding_models: "", clear_api_key: false }];
    });
  }

  return (
    <section className="view control-view">
      <header className="control-header">
        <div>
          <h1>设置</h1>
          <p>系统连接、模型路由、论文源、检索策略和自动化规则。</p>
        </div>
        <button onClick={() => refreshControl({ hydrate: false }).catch((error) => setStatusMessage(error.message))} type="button">
          刷新状态
        </button>
      </header>

      <div className="control-grid">
        <section className="panel">
          <PanelTitle title="连接状态" subtitle="这里只显示基础设施连通性；任务执行和历史统一放在任务页。" />
          <HealthGrid health={health} settings={settings} />
        </section>
      </div>

      <section className="panel">
        <PanelTitle title="系统配置" subtitle="保存后立即影响下一次手动或定时任务。" />
        <SettingsForm
          settings={settings}
          providers={providers}
          onSettingChange={updateSetting}
          onProviderChange={updateProvider}
          onAddProvider={addProvider}
          onRemoveProvider={removeProvider}
          onPickPath={pickPath}
          onSubmit={saveSettings}
          saveStatus={saveStatus}
        />
      </section>

    </section>
  );
}
