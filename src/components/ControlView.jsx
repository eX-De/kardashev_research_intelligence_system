import { useCallback, useEffect, useState } from "react";

import { PanelTitle } from "./PanelTitle.jsx";
import { normalizeProviders, providerPayload, SettingsForm } from "./SettingsForm.jsx";
import { TaskControlPanel } from "./TaskControlPanel.jsx";
import { api, chooseLocalPath, fmtDate, postJson, summarizeMeta } from "../lib/dashboard.js";

function HealthItem({ label, value, state = "neutral" }) {
  return (
    <div className={`health-item ${state}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HealthGrid({ health }) {
  const counts = health?.counts || {};
  const obsidianState = health?.obsidian?.status === "ok" ? "ok" : "warn";
  const llmState = health?.llm?.configured ? "ok" : "warn";
  return (
    <div className="health-grid">
      <HealthItem label="Database" value={health?.database?.ok ? "OK" : "Error"} state={health?.database?.ok ? "ok" : "bad"} />
      <HealthItem label="Obsidian" value={health?.obsidian?.status || "unknown"} state={obsidianState} />
      <HealthItem label="LLM" value={health?.llm?.configured ? `${health.llm.providers?.length || 0} providers` : "Not configured"} state={llmState} />
      <HealthItem label="Notes" value={counts.notes ?? 0} />
      <HealthItem label="Projects" value={counts.projects ?? 0} />
      <HealthItem label="Project Artifacts" value={counts.project_artifacts ?? 0} />
      <HealthItem label="Chunks" value={counts.chunks ?? 0} />
      <HealthItem label="Papers" value={counts.papers ?? 0} />
      <HealthItem label="Paper TXT" value={counts.paper_texts ?? 0} />
      <HealthItem label="Full Reports" value={counts.paper_reading_reports ?? 0} />
      <HealthItem label="Paper Chunks" value={counts.paper_chunks ?? 0} />
      <HealthItem label="Matches" value={counts.matches ?? 0} />
      <HealthItem label="Latest job" value={health?.latest_job?.status || "none"} state={health?.latest_job?.status === "failed" ? "bad" : "neutral"} />
    </div>
  );
}

function HistoryTable({ history }) {
  const items = history?.items || [];
  if (!items.length) return <p className="muted">暂无任务记录。</p>;
  return (
    <div className="history-table">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>开始</th>
            <th>结束</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id || `${item.job_type}-${item.started_at}`}>
              <td>{item.job_type}</td>
              <td><span className={`pill ${item.status === "failed" ? "bad-pill" : ""}`}>{item.status}</span></td>
              <td>{fmtDate(item.started_at)}</td>
              <td>{fmtDate(item.finished_at)}</td>
              <td>{item.message || summarizeMeta(item.meta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ControlView({ setStatusMessage }) {
  const [settings, setSettings] = useState({});
  const [providers, setProviders] = useState([]);
  const [scheduler, setScheduler] = useState({});
  const [health, setHealth] = useState(null);
  const [history, setHistory] = useState({ items: [] });

  const loadControl = useCallback(async ({ hydrate = false } = {}) => {
    const [settingsData, statusData, healthData, historyData] = await Promise.all([
      api("/api/settings"),
      api("/api/jobs/status"),
      api("/api/health"),
      api("/api/jobs/history")
    ]);
    if (hydrate) {
      setSettings(settingsData.settings || {});
      setProviders(normalizeProviders(settingsData.settings?.llm_providers || []));
    }
    setScheduler(statusData.scheduler || {});
    setHealth(healthData);
    setHistory(historyData);
    const current = statusData.scheduler?.current_job;
    setStatusMessage(current ? `Running ${current.command}...` : statusData.scheduler?.last_job?.message || statusData.scheduler?.last_error?.message || "Idle");
  }, [setStatusMessage]);

  useEffect(() => {
    loadControl({ hydrate: true }).catch((error) => setStatusMessage(error.message));
    const timer = setInterval(() => {
      loadControl({ hydrate: false }).catch((error) => setStatusMessage(error.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [loadControl, setStatusMessage]);

  function updateSetting(name, value) {
    setSettings((current) => {
      const next = { ...current, [name]: value };
      if (name === "run_daily_on_startup_enabled" && value) next.scheduler_enabled = false;
      if (name === "scheduler_enabled" && value) next.run_daily_on_startup_enabled = false;
      return next;
    });
  }

  function updateProvider(index, field, value) {
    setProviders((current) => current.map((provider, providerIndex) => providerIndex === index ? { ...provider, [field]: value } : provider));
  }

  async function pickPath(name, { mode, relativeTo, title }) {
    setStatusMessage("正在打开本地路径选择器...");
    const data = await chooseLocalPath({
      mode,
      title,
      relativeTo,
      basePath: relativeTo === "obsidian_vault" ? settings.obsidian_vault_path : undefined
    });
    if (data.cancelled) {
      setStatusMessage("已取消路径选择");
      return;
    }
    updateSetting(name, data.relative_path ?? data.path ?? "");
    setStatusMessage("路径已选择");
  }

  async function saveSettings(event) {
    event.preventDefault();
    setStatusMessage("Saving settings...");
    try {
      const payload = {
        ...settings,
        llm_providers: providerPayload(providers)
      };
      if (payload.scheduler_enabled && payload.run_daily_on_startup_enabled) {
        payload.run_daily_on_startup_enabled = false;
      }
      const data = await postJson("/api/settings", payload);
      setSettings(data.settings || payload);
      setProviders(normalizeProviders(data.settings?.llm_providers || payload.llm_providers || []));
      setScheduler(data.scheduler || {});
      setStatusMessage("Settings saved");
      await loadControl({ hydrate: false });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function runJob(name, endpoint = `/api/jobs/${name}`) {
    setStatusMessage(`Running ${name}...`);
    try {
      const data = await postJson(endpoint);
      setStatusMessage(data.message || `${name} finished`);
      await loadControl({ hydrate: false });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function startStartupDaily() {
    try {
      await postJson("/api/settings", { run_daily_on_startup_enabled: true, scheduler_enabled: false });
      updateSetting("run_daily_on_startup_enabled", true);
      await loadControl({ hydrate: false });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function startScheduler() {
    try {
      const data = await postJson("/api/jobs/scheduler/start");
      setSettings((current) => ({ ...current, scheduler_enabled: true, run_daily_on_startup_enabled: false }));
      setScheduler(data.scheduler || {});
      await loadControl({ hydrate: false });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function stopScheduler() {
    try {
      await postJson("/api/settings", { run_daily_on_startup_enabled: false, scheduler_enabled: false });
      setSettings((current) => ({ ...current, scheduler_enabled: false, run_daily_on_startup_enabled: false }));
      await loadControl({ hydrate: false });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  return (
    <section className="view control-view">
      <header className="control-header">
        <div>
          <h1>配置与任务</h1>
          <p>Dashboard 启动后，定时任务由本地 Node 进程调度。</p>
        </div>
        <button onClick={() => loadControl({ hydrate: false }).catch((error) => setStatusMessage(error.message))} type="button">
          刷新状态
        </button>
      </header>

      <div className="control-grid">
        <TaskControlPanel
          scheduler={scheduler}
          onStartStartup={startStartupDaily}
          onStartScheduler={startScheduler}
          onStopScheduler={stopScheduler}
          onRunNow={() => runJob("run-daily", "/api/jobs/run-now")}
          onRunJob={runJob}
        />
        <section className="panel">
          <PanelTitle title="健康状态" subtitle="数据库、Obsidian、LLM provider 和索引规模。" />
          <HealthGrid health={health} />
        </section>
      </div>

      <section className="panel">
        <PanelTitle title="系统配置" subtitle="保存后立即影响下一次手动或定时任务。" />
        <SettingsForm
          settings={settings}
          providers={providers}
          onSettingChange={updateSetting}
          onProviderChange={updateProvider}
          onAddProvider={() => setProviders((current) => [...current, { id: "", name: "", base_url: "", api_key: "", chat_models: "", embedding_models: "", clear_api_key: false }])}
          onRemoveProvider={(index) => setProviders((current) => {
            const next = current.filter((_, providerIndex) => providerIndex !== index);
            return next.length ? next : [{ id: "default", name: "Default", base_url: "", api_key: "", chat_models: "", embedding_models: "", clear_api_key: false }];
          })}
          onPickPath={pickPath}
          onSubmit={saveSettings}
        />
      </section>

      <section className="panel">
        <PanelTitle title="任务历史" subtitle="最近 20 次 worker 执行记录。" />
        <HistoryTable history={history} />
      </section>
    </section>
  );
}
