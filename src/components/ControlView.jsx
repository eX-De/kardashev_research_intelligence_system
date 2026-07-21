import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { DailyTasksSettingsView } from "./DailyTasksSettingsView.jsx";
import { DataStorageSettingsView } from "./DataStorageSettingsView.jsx";
import { ModelRoutingSettingsView } from "./ModelRoutingSettingsView.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, chooseLocalPath, postJson } from "../lib/dashboard.js";
import { friendlyObsidianMessage, obsidianCapabilityFrom } from "../lib/obsidianCapability.js";
import { normalizeProviders, providerPayload } from "../lib/settingsProviders.js";
import "../styles/ControlView.css";

const AUTO_SAVE_DELAY_MS = 850;
const QUICK_SAVE_DELAY_MS = 150;
const QUICK_SAVE_FIELDS = new Set([
  "arxiv_cache_full_text",
  "rag_prefilter_enabled"
]);
const SUCCESS_TOAST_THROTTLE_MS = 2500;
const SETTINGS_PAGES = {
  "/settings/daily-tasks": { key: "daily-tasks", eyebrow: "自动化工作区", title: "每日任务" },
  "/settings/data": { key: "data", eyebrow: "数据工作区", title: "数据与存储" },
  "/settings/models": { key: "models", eyebrow: "模型工作区", title: "模型与路由" }
};
const SETTINGS_ENTRIES = [
  { to: "/settings/daily-tasks", index: "01", type: "daily", eyebrow: "AUTOMATION", label: "每日任务", description: "配置调度、论文抓取、检索推荐与任务恢复。" },
  { to: "/settings/data", index: "02", type: "data", eyebrow: "KNOWLEDGE", label: "数据与存储", description: "管理 Obsidian、知识库范围与论文存储目录。" },
  { to: "/settings/models", index: "03", type: "models", eyebrow: "INTELLIGENCE", label: "模型与路由", description: "维护 Provider，并为不同研究任务分配模型。" }
];
const DAILY_JOB_TYPES = new Set(["run-daily", "resume-daily", "retry-daily"]);
const ABOUT_LINKS = [
  {
    title: "KRIS GitHub",
    description: "查看主项目源码、Issue 与版本发布记录",
    href: "https://github.com/eX-De/kardashev_research_intelligence_system",
    logo: "github"
  },
  {
    title: "KRIS Docker Hub",
    description: "获取最新容器镜像与历史版本标签",
    href: "https://hub.docker.com/r/exde1968/kardashev-research-intelligence-system",
    logo: "docker"
  },
  {
    title: "kris-agent GitHub",
    description: "查看配套 Agent 的安装与使用说明",
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
  return (
    <div
      className={`health-item ${loading ? "loading" : state}`}
      aria-busy={loading || undefined}
      aria-label={loading ? `${label} 正在检查` : undefined}
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
  const obsidianCapability = obsidianCapabilityFrom({ health, settings });
  const llmState = health?.llm?.configured ? "ok" : "warn";
  return (
    <div className="health-grid">
      <HealthItem label="Database" loading={loading} value={health?.database?.ok ? "OK" : "Error"} state={health?.database?.ok ? "ok" : "bad"} />
      <HealthItem label="Obsidian" loading={loading} value={obsidianCapability.label} state={obsidianCapability.state} />
      <HealthItem label="LLM" loading={loading} value={health?.llm?.configured ? `${health.llm.providers?.length || 0} providers` : "Not configured"} state={llmState} />
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
  return (
    <section className="panel about-panel">
      <header className="settings-about-heading">
        <div>
          <span>Resources</span>
          <h2>项目资源</h2>
          <p>KRIS 源码、容器镜像与配套 Agent。</p>
        </div>
        <em>OPEN SOURCE</em>
      </header>
      <div className="about-action-row">
        {ABOUT_LINKS.map((item) => (
          <a className="about-action-button" href={item.href} key={item.title} rel="noreferrer" target="_blank">
            <AboutLogo type={item.logo} />
            <span className="about-action-copy">
              <strong className="about-action-title">{item.title}</strong>
              <small>{item.description}</small>
            </span>
            <i className="about-action-arrow" aria-hidden="true">↗</i>
          </a>
        ))}
      </div>
    </section>
  );
}

function schedulerStatusMessage(scheduler) {
  const current = scheduler?.current_job;
  return current ? `Running ${current.command}...` : scheduler?.last_job?.message || scheduler?.last_error?.message || "Idle";
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
      failed_label: failedStep.label || progress.current_label || "未知阶段",
      completed: Number(progress.completed || steps.filter((step) => step?.status === "completed").length || 0),
      total: Number(progress.total || steps.length || 0),
    };
  }
  return null;
}

export function ControlView({ setStatusMessage = () => {}, notify = () => {} }) {
  const location = useLocation();
  const currentPage = SETTINGS_PAGES[location.pathname] || { key: "overview", eyebrow: "系统工作区", title: "设置中心" };
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
  const systemHealthy = Boolean(health?.database?.ok && health?.llm?.configured);

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
    setStatusMessage(schedulerStatusMessage(statusData.scheduler || {}));
  }, [hydrateSettings, refreshHealthCache, refreshHistoryCache, refreshJobStatusCache, refreshJobsSummaryCache, refreshSettingsCache, setStatusMessage]);

  useEffect(() => {
    if (settingsQuery.data?.settings) hydrateSettings(settingsQuery.data);
  }, [hydrateSettings, settingsQuery.data]);

  useEffect(() => {
    if (!jobStatusQuery.data?.scheduler) return;
    setStatusMessage(schedulerStatusMessage(jobStatusQuery.data.scheduler));
  }, [jobStatusQuery.data, setStatusMessage]);

  useEffect(() => {
    if (currentPage.key !== "daily-tasks" || taskDetailsLoadedRef.current) return undefined;
    taskDetailsLoadedRef.current = true;
    refreshHistoryCache({ force: true }).catch((error) => setStatusMessage(error.message));
    return undefined;
  }, [currentPage.key, refreshHistoryCache, setStatusMessage]);

  useEffect(() => {
    const error = settingsQuery.error || jobStatusQuery.error || jobsSummaryQuery.error || historyQuery.error || healthQuery.error;
    if (error) setStatusMessage(error.message);
  }, [healthQuery.error, historyQuery.error, jobStatusQuery.error, jobsSummaryQuery.error, setStatusMessage, settingsQuery.error]);

  const showSaveSuccess = useCallback(({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastSuccessToastAtRef.current < SUCCESS_TOAST_THROTTLE_MS) return;
    lastSuccessToastAtRef.current = now;
    notify("设置已保存", { type: "success" });
  }, [notify]);

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
      showSaveSuccess({ force: forceSuccessToast });
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
    setStatusMessage(schedulerStatusMessage(statusData.scheduler || {}));
    return statusData;
  }

  async function setSchedulerMode(mode) {
    setStatusMessage("Updating scheduler...");
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
        setStatusMessage(schedulerStatusMessage(data.scheduler));
      }
      cache.markStale(["health"]);
      await refreshTaskActivity({ includeHistory: false });
      refreshHealthCache({ force: true }).catch((error) => setStatusMessage(error.message));
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function runJob(name, endpoint = `/api/jobs/${name}`, body = {}) {
    let payload = body;
    if (name === "run-daily" && dailyRecovery && !payload.force) {
      const ok = window.confirm("今天已有失败但可恢复的每日流程。重新执行会新建一轮流程，可能重复抓取、匹配和消耗 LLM。确定重新执行？");
      if (!ok) return;
      payload = { ...payload, force: true };
    }
    setStatusMessage(`Running ${name}...`);
    try {
      const data = await postJson(endpoint, payload);
      setStatusMessage(data.message || `${name} finished`);
      await refreshTaskActivity({ includeHistory: true });
    } catch (error) {
      if (error.code === "daily_run_recoverable") {
        if (!dailyRecovery) {
          setStatusMessage(error.message);
          await refreshTaskActivity({ includeHistory: true });
          return;
        }
        const ok = window.confirm(`${error.message}\n\n确定重新执行今日流程？`);
        if (ok) {
          await runJob(name, endpoint, { ...payload, force: true });
        }
        return;
      }
      setStatusMessage(error.message);
    }
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
        delay: QUICK_SAVE_DELAY_MS
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

  function addProvider() {
    queueAutosave({
      delay: QUICK_SAVE_DELAY_MS
    });
    setProviders((current) => [...current, { id: nextProviderId(current), name: "", base_url: "", api_key: "", chat_models: "", embedding_models: "", clear_api_key: false }]);
  }

  function removeProvider(index) {
    queueAutosave({
      delay: QUICK_SAVE_DELAY_MS
    });
    setProviders((current) => {
      const next = current.filter((_, providerIndex) => providerIndex !== index);
      return next.length ? next : [{ id: "default", name: "Default", base_url: "", api_key: "", chat_models: "", embedding_models: "", clear_api_key: false }];
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
              <span>运行基础</span>
              <h2>连接与服务</h2>
              <p>数据库、知识库集成和模型服务的即时状态。</p>
            </div>
            <em>{healthQuery.hasData ? (systemHealthy ? "ALL SYSTEMS READY" : "ACTION NEEDED") : "SYNCING"}</em>
          </header>
          <HealthGrid health={health} loading={(!healthQuery.hasData && !healthQuery.error) || healthQuery.refreshing} settings={settings} />
        </section>
        <nav className="settings-entry-grid" aria-label="设置二级页面">
          {SETTINGS_ENTRIES.map((entry) => (
            <Link className={`settings-entry-card is-${entry.type}`} key={entry.to} to={entry.to}>
              <span className="settings-entry-index">{entry.index}</span>
              <span className="settings-entry-icon"><SettingsEntryIcon type={entry.type} /></span>
              <span className="settings-entry-copy">
                <small>{entry.eyebrow}</small>
                <strong>{entry.label}</strong>
                <p>{entry.description}</p>
              </span>
              <span className="settings-entry-action">进入设置 <i aria-hidden="true">→</i></span>
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
          <span>{currentPage.eyebrow}</span>
          <h1>{currentPage.title}</h1>
        </div>
        <div className="vision-top-actions">
          <span className={`vision-live-state ${systemHealthy ? "ready" : "attention"}`}><i aria-hidden="true" />{healthQuery.hasData ? (systemHealthy ? "服务就绪" : "需要配置") : "同步状态"}</span>
          <RefreshButton
            className="vision-refresh"
            busy={refreshBusy}
            label="刷新状态"
            onClick={() => refreshControl({ hydrate: false, includeTaskHistory: currentPage.key === "daily-tasks" }).catch((error) => setStatusMessage(error.message))}
          />
        </div>
      </header>

      {currentPage.key !== "overview" ? (
        <div className="settings-subpage-nav-row">
          <Link className="settings-overview-back" to="/settings">
            <span aria-hidden="true">←</span>
            返回设置概览
          </Link>
          <button className="settings-subpage-save-button" disabled={saveStatus === "saving"} onClick={saveSettings} type="button">
            {saveStatus === "saving" ? "保存中" : "立即保存"}
          </button>
        </div>
      ) : null}

      <main className={`settings-workspace settings-workspace-${currentPage.key}`}>
        {renderSettingsPage()}
      </main>
    </section>
  );
}
