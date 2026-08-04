import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";

import { DailyTasksSettingsView } from "./DailyTasksSettingsView.jsx";
import { DataStorageSettingsView } from "./DataStorageSettingsView.jsx";
import { ModelRoutingSettingsView } from "./ModelRoutingSettingsView.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, chooseLocalPath, postJson } from "../lib/dashboard.js";
import { friendlyObsidianMessage, obsidianCapabilityFrom } from "../lib/obsidianCapability.js";
import { normalizeProviders, OPENROUTER_BASE_URL, providerPayload, providerType } from "../lib/settingsProviders.js";
import { dailyStepLabel, formatApiError } from "../lib/systemMessages.js";
import "../styles/ControlView.css";

const AUTO_SAVE_DELAY_MS = 850;
const QUICK_SAVE_DELAY_MS = 150;
const QUICK_SAVE_FIELDS = new Set([
  "arxiv_cache_full_text",
  "rag_prefilter_enabled"
]);
const SUCCESS_TOAST_THROTTLE_MS = 2500;
const SETTINGS_PAGES = {
  "/settings/daily-tasks": { key: "daily-tasks", translationKey: "pages.daily" },
  "/settings/data": { key: "data", translationKey: "pages.data" },
  "/settings/models": { key: "models", translationKey: "pages.models" }
};
const SETTINGS_ENTRIES = [
  { to: "/settings/daily-tasks", index: "01", type: "daily", eyebrow: "AUTOMATION", translationKey: "entries.daily" },
  { to: "/settings/data", index: "02", type: "data", eyebrow: "KNOWLEDGE", translationKey: "entries.data" },
  { to: "/settings/models", index: "03", type: "models", eyebrow: "INTELLIGENCE", translationKey: "entries.models" }
];
const DAILY_JOB_TYPES = new Set(["run-daily", "resume-daily", "retry-daily"]);
const ABOUT_LINKS = [
  {
    title: "KRIS GitHub",
    translationKey: "about.links.krisGithub",
    href: "https://github.com/eX-De/kardashev_research_intelligence_system",
    logo: "github"
  },
  {
    title: "KRIS Docker Hub",
    translationKey: "about.links.dockerHub",
    href: "https://hub.docker.com/r/exde1968/kardashev-research-intelligence-system",
    logo: "docker"
  },
  {
    title: "kris-agent GitHub",
    translationKey: "about.links.agentGithub",
    href: "https://github.com/eX-De/kris-agent",
    logo: "github"
  }
];

function settingsPayload(settings, providers) {
  const {
    run_daily_on_startup_enabled: _runDailyOnStartupEnabled,
    scheduler_enabled: _schedulerEnabled,
    ...formSettings
  } = settings || {};
  const payload = {
    ...formSettings,
    llm_providers: providerPayload(providers)
  };
  return payload;
}

function settingsSignature(settings, providers) {
  return JSON.stringify(settingsPayload(settings, providers));
}

function HealthItem({ label, loading = false, value, state = "neutral" }) {
  const { t } = useTranslation("settings");
  return (
    <div
      className={`health-item ${loading ? "loading" : state}`}
      aria-busy={loading || undefined}
      aria-label={loading ? t("health.checking", { label }) : undefined}
    >
      <span>{label}</span>
      <strong>{loading ? <i className="health-checking-skeleton" aria-hidden="true" /> : value}</strong>
    </div>
  );
}

function SettingsEntryIcon({ type }) {
  const paths = {
    daily: <><circle cx="12" cy="12" r="7.5" /><path d="M12 7.5v5l3.2 1.8M7 3.8 4.5 6.2M17 3.8l2.5 2.4" /></>,
    data: <><ellipse cx="12" cy="5.5" rx="7.5" ry="3" /><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" /></>,
    models: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.4 10.9 7.2-3.8M8.4 13.1l7.2 3.8" /></>
  };
  return <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6">{paths[type]}</svg>;
}

function HealthGrid({ health, loading = false, settings }) {
  const { t } = useTranslation("settings");
  const obsidianCapability = obsidianCapabilityFrom({ health, settings, t });
  const llmState = health?.llm?.configured ? "ok" : "warn";
  const worker = health?.worker || {};
  const workerState = worker.required === false ? "neutral" : worker.available ? "ok" : "bad";
  const workerValue = worker.required === false
    ? t("health.workerNotRequired")
    : worker.available
      ? t("health.workerOnline", { count: Number(worker.online_workers || 0) })
      : t("health.workerOffline");
  return (
    <div className="health-grid">
      <HealthItem label="Database" loading={loading} value={health?.database?.ok ? "OK" : "Error"} state={health?.database?.ok ? "ok" : "bad"} />
      <HealthItem label="Obsidian" loading={loading} value={obsidianCapability.label} state={obsidianCapability.state} />
      <HealthItem label="LLM" loading={loading} value={health?.llm?.configured ? t("health.providers", { count: health.llm.providers?.length || 0 }) : t("health.notConfigured")} state={llmState} />
      <HealthItem label={t("health.worker")} loading={loading} value={workerValue} state={workerState} />
    </div>
  );
}

function GitHubLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.69-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.16 1.18.92-.26 1.9-.38 2.88-.39.98 0 1.96.13 2.88.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.41.35.78 1.05.78 2.12v3.14c0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function DockerLogo() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M8.3 6.6h2.6v2.6H8.3V6.6Zm3.2 0h2.6v2.6h-2.6V6.6Zm-6.4 3.2h2.6v2.6H5.1V9.8Zm3.2 0h2.6v2.6H8.3V9.8Zm3.2 0h2.6v2.6h-2.6V9.8Zm3.2 0h2.6v2.6h-2.6V9.8Z" />
      <path d="M21.6 12.1c-.72-.48-1.64-.61-2.75-.39-.14-.83-.61-1.57-1.42-2.21l-.54-.43-.42.55c-.52.68-.69 1.58-.5 2.69H3.05l-.08.65c-.22 1.75.19 3.17 1.22 4.24 1.06 1.1 2.69 1.65 4.88 1.65h.54c4.46 0 7.63-1.83 9.5-5.49.99.03 1.8-.27 2.43-.91l.56-.57-.5-.34Z" />
    </svg>
  );
}

function AboutLogo({ type }) {
  return (
    <span className={`about-action-logo ${type}`}>
      {type === "docker" ? <DockerLogo /> : <GitHubLogo />}
    </span>
  );
}

function AboutPanel() {
  const { t } = useTranslation("settings");
  return (
    <section className="panel about-panel">
      <header className="settings-about-heading">
        <div>
          <span>{t("about.eyebrow")}</span>
          <h2>{t("about.title")}</h2>
          <p>{t("about.description")}</p>
        </div>
        <em>{t("about.badge")}</em>
      </header>
      <div className="about-action-row">
        {ABOUT_LINKS.map((item) => (
          <a className="about-action-button" href={item.href} key={item.title} rel="noreferrer" target="_blank">
            <AboutLogo type={item.logo} />
            <span className="about-action-copy">
              <strong className="about-action-title">{item.title}</strong>
              <small>{t(item.translationKey)}</small>
            </span>
            <i className="about-action-arrow" aria-hidden="true">↗</i>
          </a>
        ))}
      </div>
    </section>
  );
}

function schedulerStatusMessage(scheduler, t) {
  const current = scheduler?.current_job;
  return current
    ? t("status.running", {
      job: t(`common:jobType.${current.command}`, { defaultValue: current.command })
    })
    : scheduler?.last_job?.message || scheduler?.last_error?.message || t("status.idle");
}

function dailyRecoveryFromHistory(history = []) {
  for (const item of history) {
    if (!DAILY_JOB_TYPES.has(item?.job_type)) continue;
    if (item.status === "completed") return null;
    if (item.status !== "failed") continue;
    const progress = item.meta?.daily_progress && typeof item.meta.daily_progress === "object"
      ? item.meta.daily_progress
      : null;
    if (!progress) continue;
    const steps = Array.isArray(progress.steps) ? progress.steps : [];
    const failedStep = steps.find((step) => step?.status === "failed") || {};
    return {
      job_id: item.id,
      failed_step: failedStep.key || progress.current_key || "",
      failed_label: failedStep.label || progress.current_label || "",
      completed: Number(progress.completed || steps.filter((step) => step?.status === "completed").length || 0),
      total: Number(progress.total || steps.length || 0),
    };
  }
  return null;
}

export function ControlView({ setStatusMessage = () => {}, notify = () => {} }) {
  const { t } = useTranslation(["settings", "common", "system"]);
  const location = useLocation();
  const currentPage = SETTINGS_PAGES[location.pathname] || { key: "overview", translationKey: "pages.overview" };
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
  const taskDetailsLoadedRef = useRef(false);
  const cache = useApiCacheClient();
  const settingsQuery = useCachedApi(["settings"], () => api("/api/settings"), { staleTime: Infinity });
  const jobStatusQuery = useCachedApi(["jobs", "status"], () => api("/api/jobs/status"), { staleTime: 5000 });
  const jobsSummaryQuery = useCachedApi(["jobs", "summary"], () => api("/api/jobs/summary"), { staleTime: 15000 });
  const historyQuery = useCachedApi(["jobs", "history", 12], () => api("/api/jobs/history?limit=12"), { enabled: false, staleTime: 60000 });
  const healthQuery = useCachedApi(["health"], () => api("/api/health"), { staleTime: 30000 });
  const refreshSettingsCache = settingsQuery.refresh;
  const refreshJobStatusCache = jobStatusQuery.refresh;
  const refreshJobsSummaryCache = jobsSummaryQuery.refresh;
  const refreshHistoryCache = historyQuery.refresh;
  const refreshHealthCache = healthQuery.refresh;
  const health = healthQuery.data || null;
  const scheduler = jobStatusQuery.data?.scheduler || {};
  const jobsSummary = jobsSummaryQuery.data || {};
  const fallbackHistory = jobsSummary.latest_job ? [{ ...jobsSummary.latest_job, meta: {} }] : [];
  const history = historyQuery.hasData ? historyQuery.data?.items || [] : fallbackHistory;
  const dailyRecovery = dailyRecoveryFromHistory(history);
  const tasksLoading = !jobStatusQuery.hasData || !jobsSummaryQuery.hasData;
  const refreshBusy = settingsQuery.refreshing || jobStatusQuery.refreshing || jobsSummaryQuery.refreshing || historyQuery.refreshing || healthQuery.refreshing;
  const systemHealthy = Boolean(
    health?.database?.ok
    && health?.llm?.configured
    && (health?.worker?.required === false || health?.worker?.available)
  );

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

  const refreshControl = useCallback(async ({ hydrate = false, includeTaskHistory = false } = {}) => {
    const tasks = [
      hydrate ? refreshSettingsCache({ force: true }) : Promise.resolve(null),
      refreshJobStatusCache({ force: true }),
      refreshHealthCache({ force: true }),
      refreshJobsSummaryCache({ force: true })
    ];
    if (includeTaskHistory) tasks.push(refreshHistoryCache({ force: true }));
    const [settingsData, statusData] = await Promise.all(tasks);
    if (hydrate) hydrateSettings(settingsData, { force: true });
    setStatusMessage(schedulerStatusMessage(statusData.scheduler || {}, t));
  }, [hydrateSettings, refreshHealthCache, refreshHistoryCache, refreshJobStatusCache, refreshJobsSummaryCache, refreshSettingsCache, setStatusMessage, t]);

  useEffect(() => {
    if (settingsQuery.data?.settings) hydrateSettings(settingsQuery.data);
  }, [hydrateSettings, settingsQuery.data]);

  useEffect(() => {
    if (!jobStatusQuery.data?.scheduler) return;
    setStatusMessage(schedulerStatusMessage(jobStatusQuery.data.scheduler, t));
  }, [jobStatusQuery.data, setStatusMessage, t]);

  useEffect(() => {
    if (currentPage.key !== "daily-tasks" || taskDetailsLoadedRef.current) return undefined;
    taskDetailsLoadedRef.current = true;
    refreshHistoryCache({ force: true }).catch((error) => setStatusMessage(formatApiError(error, t)));
    return undefined;
  }, [currentPage.key, refreshHistoryCache, setStatusMessage, t]);

  useEffect(() => {
    const error = settingsQuery.error || jobStatusQuery.error || jobsSummaryQuery.error || historyQuery.error || healthQuery.error;
    if (error) setStatusMessage(formatApiError(error, t));
  }, [healthQuery.error, historyQuery.error, jobStatusQuery.error, jobsSummaryQuery.error, setStatusMessage, settingsQuery.error, t]);

  const showSaveSuccess = useCallback(({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastSuccessToastAtRef.current < SUCCESS_TOAST_THROTTLE_MS) return;
    lastSuccessToastAtRef.current = now;
    notify(t("save.savedToast"), { type: "success" });
  }, [notify, t]);

  const saveCurrentSettings = useCallback(async ({ forceSuccessToast = false, force = false } = {}) => {
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
    setStatusMessage(t("save.saving"));

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
      setStatusMessage(t("save.saved"));
      showSaveSuccess({ force: forceSuccessToast });
      refreshControl({ hydrate: false }).catch((error) => setStatusMessage(formatApiError(error, t)));
    } catch (error) {
      if (requestId !== saveRequestRef.current || editVersion !== editVersionRef.current) return;
      setSaveStatus("error");
      const message = formatApiError(error, t);
      setStatusMessage(message);
      notify(message, { type: "error" });
    }
  }, [notify, refreshControl, setStatusMessage, showSaveSuccess, t]);

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
      forceSuccessToast: Boolean(current.forceSuccessToast || options.forceSuccessToast)
    };
  }

  function nextProviderId(currentProviders, baseId = "provider") {
    const existing = new Set(currentProviders.map((provider) => provider.id).filter(Boolean));
    if (!existing.has(baseId)) return baseId;
    let index = 2;
    let id = `${baseId}_${index}`;
    while (existing.has(id)) {
      index += 1;
      id = `${baseId}_${index}`;
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
      return next;
    });
  }

  function updateProvider(index, field, value) {
    queueAutosave({
      delay: field === "clear_api_key" ? QUICK_SAVE_DELAY_MS : AUTO_SAVE_DELAY_MS
    });
    setProviders((current) => current.map((provider, providerIndex) => providerIndex === index ? { ...provider, [field]: value } : provider));
  }

  async function refreshTaskActivity({ includeHistory = true } = {}) {
    const refreshes = [
      refreshJobStatusCache({ force: true }),
      refreshJobsSummaryCache({ force: true })
    ];
    if (includeHistory) refreshes.push(refreshHistoryCache({ force: true }));
    const [statusData] = await Promise.all(refreshes);
    setStatusMessage(schedulerStatusMessage(statusData.scheduler || {}, t));
    return statusData;
  }

  async function setSchedulerMode(mode) {
    setStatusMessage(t("status.updatingScheduler"));
    try {
      const data = await postJson("/api/jobs/scheduler/mode", { mode });
      if (data.settings) {
        cache.setCache(["settings"], data);
        setSettings((current) => ({
          ...current,
          run_daily_on_startup_enabled: Boolean(data.settings.run_daily_on_startup_enabled),
          scheduler_enabled: Boolean(data.settings.scheduler_enabled)
        }));
      }
      if (data.scheduler) {
        cache.setCache(["jobs", "status"], { scheduler: data.scheduler });
        setStatusMessage(schedulerStatusMessage(data.scheduler, t));
      }
      cache.markStale(["health"]);
      await refreshTaskActivity({ includeHistory: false });
      refreshHealthCache({ force: true }).catch((error) => setStatusMessage(formatApiError(error, t)));
    } catch (error) {
      setStatusMessage(formatApiError(error, t));
    }
  }

  async function runJob(name, endpoint = `/api/jobs/${name}`, body = {}) {
    let payload = body;
    if (name === "run-daily" && dailyRecovery && !payload.force) {
      const ok = window.confirm(t("confirm.forceDailyRun"));
      if (!ok) return;
      payload = { ...payload, force: true };
    }
    const localizedJob = t(`common:jobType.${name}`, { defaultValue: name });
    setStatusMessage(t("status.running", { job: localizedJob }));
    try {
      const data = await postJson(endpoint, payload);
      setStatusMessage(t("status.finished", { job: localizedJob }));
      await refreshTaskActivity({ includeHistory: true });
    } catch (error) {
      if (error.code === "daily_run_recoverable") {
        if (!dailyRecovery) {
          setStatusMessage(formatApiError(error, t));
          await refreshTaskActivity({ includeHistory: true });
          return;
        }
        const ok = window.confirm(`${formatApiError(error, t)}\n\n${t("confirm.rerunDaily")}`);
        if (ok) {
          await runJob(name, endpoint, { ...payload, force: true });
        }
        return;
      }
      setStatusMessage(formatApiError(error, t));
    }
  }

  async function pickPath(name, { mode, relativeTo, title }) {
    setStatusMessage(t("path.opening"));
    try {
      const data = await chooseLocalPath({
        mode,
        title,
        relativeTo,
        basePath: relativeTo === "obsidian_vault" ? settingsRef.current.obsidian_vault_path : undefined
      });
      if (data.cancelled) {
        setStatusMessage(t("path.cancelled"));
        notify(t("path.cancelled"), { type: "info" });
        return;
      }
      updateSetting(name, data.relative_path ?? data.path ?? "", {
        delay: QUICK_SAVE_DELAY_MS
      });
      setStatusMessage(t("path.selected"));
      notify(t("path.saving"), { type: "info" });
    } catch (error) {
      const message = relativeTo === "obsidian_vault" ? friendlyObsidianMessage(error, t) : formatApiError(error, t);
      setStatusMessage(message);
      notify(message, { type: "error" });
    }
  }

  function saveSettings(event) {
    event?.preventDefault();
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    saveCurrentSettings({
      forceSuccessToast: true,
      force: true
    });
  }

  function addProvider(preset = "generic") {
    const isOpenRouter = preset === "openrouter";
    if (isOpenRouter && providers.some((provider) => providerType(provider) === "openrouter")) return;
    queueAutosave({
      delay: QUICK_SAVE_DELAY_MS
    });
    setProviders((current) => {
      if (isOpenRouter && current.some((provider) => providerType(provider) === "openrouter")) return current;
      return [...current, {
        id: nextProviderId(current, isOpenRouter ? "openrouter" : "provider"),
        name: isOpenRouter ? "OpenRouter" : "",
        base_url: isOpenRouter ? OPENROUTER_BASE_URL : "",
        api_key: "",
        api_key_configured: false,
        chat_models: "",
        embedding_models: "",
        provider_type: isOpenRouter ? "openrouter" : "openai_compatible",
        openrouter_model_policies: {},
        clear_api_key: false
      }];
    });
  }

  function removeProvider(index) {
    queueAutosave({
      delay: QUICK_SAVE_DELAY_MS
    });
    setProviders((current) => {
      return current.filter((_, providerIndex) => providerIndex !== index);
    });
  }

  const taskControlProps = {
    scheduler,
    recovery: dailyRecovery,
    onStartStartup: () => setSchedulerMode("startup"),
    onStartScheduler: () => setSchedulerMode("scheduler"),
    onStopScheduler: () => setSchedulerMode("off"),
    onRunNow: () => runJob("run-daily", "/api/jobs/run-now"),
    onResumeDaily: () => runJob("resume-daily", "/api/jobs/resume-daily"),
    onRetryDaily: () => runJob("retry-daily", "/api/jobs/retry-daily"),
    onRunJob: runJob
  };

  const taskHistoryProps = {
    history,
    loading: tasksLoading,
    refreshing: historyQuery.refreshing
  };

  function renderSettingsPage() {
    if (currentPage.key === "daily-tasks") {
      return (
        <DailyTasksSettingsView
          settings={settings}
          onSettingChange={updateSetting}
          onSubmit={saveSettings}
          saveStatus={saveStatus}
          taskControlProps={taskControlProps}
          taskHistoryProps={taskHistoryProps}
        />
      );
    }

    if (currentPage.key === "data") {
      return (
        <DataStorageSettingsView
          settings={settings}
          onSettingChange={updateSetting}
          onPickPath={pickPath}
          onSubmit={saveSettings}
          saveStatus={saveStatus}
        />
      );
    }

    if (currentPage.key === "models") {
      return (
        <ModelRoutingSettingsView
          settings={settings}
          providers={providers}
          onSettingChange={updateSetting}
          onProviderChange={updateProvider}
          onAddProvider={addProvider}
          onRemoveProvider={removeProvider}
          onSubmit={saveSettings}
          saveStatus={saveStatus}
        />
      );
    }

    return (
      <>
        <section className="settings-overview-card">
          <header className="settings-card-heading">
            <div>
              <span>{t("overview.foundation")}</span>
              <h2>{t("overview.title")}</h2>
              <p>{t("overview.description")}</p>
            </div>
            <em>{healthQuery.hasData ? (systemHealthy ? t("overview.allReady") : t("overview.actionNeeded")) : t("overview.syncing")}</em>
          </header>
          <HealthGrid health={health} loading={(!healthQuery.hasData && !healthQuery.error) || healthQuery.refreshing} settings={settings} />
        </section>
        <nav className="settings-entry-grid" aria-label={t("entries.ariaLabel")}>
          {SETTINGS_ENTRIES.map((entry) => (
            <Link className={`settings-entry-card is-${entry.type}`} key={entry.to} to={entry.to}>
              <span className="settings-entry-index">{entry.index}</span>
              <span className="settings-entry-icon"><SettingsEntryIcon type={entry.type} /></span>
              <span className="settings-entry-copy">
                <small>{entry.eyebrow}</small>
                <strong>{t(`${entry.translationKey}.label`)}</strong>
                <p>{t(`${entry.translationKey}.description`)}</p>
              </span>
              <span className="settings-entry-action">{t("entries.open")} <i aria-hidden="true">→</i></span>
            </Link>
          ))}
        </nav>
        <AboutPanel />
      </>
    );
  }

  return (
    <section className="view control-view vision-settings">
      <header className="vision-topbar settings-topbar">
        <div className="vision-brand">
          <span>{t(`${currentPage.translationKey}.eyebrow`)}</span>
          <h1>{t(`${currentPage.translationKey}.title`)}</h1>
        </div>
        <div className="vision-top-actions">
          <span className={`vision-live-state ${systemHealthy ? "ready" : "attention"}`}><i aria-hidden="true" />{healthQuery.hasData ? (systemHealthy ? t("health.ready") : t("health.needsConfiguration")) : t("health.syncing")}</span>
          <RefreshButton
            className="vision-refresh"
            busy={refreshBusy}
            label={t("actions.refreshStatus")}
            onClick={() => refreshControl({ hydrate: false, includeTaskHistory: currentPage.key === "daily-tasks" }).catch((error) => setStatusMessage(formatApiError(error, t)))}
          />
        </div>
      </header>

      {currentPage.key !== "overview" ? (
        <div className="settings-subpage-nav-row">
          <Link className="settings-overview-back" to="/settings">
            <span aria-hidden="true">←</span>
            {t("actions.backToOverview")}
          </Link>
          <button className="settings-subpage-save-button" disabled={saveStatus === "saving"} onClick={saveSettings} type="button">
            {saveStatus === "saving" ? t("actions.saving") : t("actions.saveNow")}
          </button>
        </div>
      ) : null}

      <main className={`settings-workspace settings-workspace-${currentPage.key}`}>
        {renderSettingsPage()}
      </main>
    </section>
  );
}
