import { useCallback, useEffect, useState } from "react";

import { LoadingPanel } from "./Loading.jsx";
import { PanelTitle } from "./PanelTitle.jsx";
import { TaskControlPanel } from "./TaskControlPanel.jsx";
import { api, fmtDate, postJson, summarizeMeta } from "../lib/dashboard.js";

function HistoryTable({ history }) {
  if (!history.length) return <p className="muted">暂无任务记录。</p>;
  return (
    <div className="history-table">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>开始</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {history.map((item) => (
            <tr key={item.id}>
              <td>{item.job_type}</td>
              <td><span className={`pill ${item.status === "failed" ? "bad-pill" : ""}`}>{item.status}</span></td>
              <td>{fmtDate(item.started_at)}</td>
              <td>{item.message || summarizeMeta(item.meta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TasksView({ setStatusMessage }) {
  const [scheduler, setScheduler] = useState({});
  const [history, setHistory] = useState([]);
  const [reports, setReports] = useState({ stats: {}, items: [] });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [statusData, historyData, reportData] = await Promise.all([
      api("/api/jobs/status"),
      api("/api/jobs/history?limit=30"),
      api("/api/paper-reports?limit=80")
    ]);
    setScheduler(statusData.scheduler || {});
    setHistory(historyData.items || []);
    setReports(reportData);
    const current = statusData.scheduler?.current_job;
    setStatusMessage(current ? `Running ${current.command}...` : statusData.scheduler?.last_job?.message || "Idle");
  }, [setStatusMessage]);

  useEffect(() => {
    let cancelled = false;
    load()
      .catch((error) => setStatusMessage(error.message))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const timer = setInterval(() => load().catch((error) => setStatusMessage(error.message)), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load, setStatusMessage]);

  async function runJob(name, endpoint = `/api/jobs/${name}`) {
    setStatusMessage(`Running ${name}...`);
    try {
      const data = await postJson(endpoint);
      setStatusMessage(data.message || `${name} finished`);
      await load();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function startStartupDaily() {
    await postJson("/api/settings", { run_daily_on_startup_enabled: true, scheduler_enabled: false });
    await load();
  }

  async function startScheduler() {
    await postJson("/api/jobs/scheduler/start", {});
    await load();
  }

  async function stopScheduler() {
    await postJson("/api/settings", { run_daily_on_startup_enabled: false, scheduler_enabled: false });
    await load();
  }

  return (
    <section className="view tasks-view">
      <header className="project-dashboard-header">
        <div>
          <h1>任务</h1>
          <p>每日流程、报告队列和任务历史。</p>
        </div>
        <button onClick={() => load().catch((error) => setStatusMessage(error.message))} type="button">刷新</button>
      </header>

      <div className="tasks-grid">
        {loading ? (
          <LoadingPanel description="正在同步调度器、报告队列和历史记录。" rows={6} title="读取任务状态" />
        ) : (
          <TaskControlPanel
            scheduler={scheduler}
            onStartStartup={startStartupDaily}
            onStartScheduler={startScheduler}
            onStopScheduler={stopScheduler}
            onRunNow={() => runJob("run-daily", "/api/jobs/run-now")}
            onResumeDaily={() => runJob("resume-daily", "/api/jobs/resume-daily")}
            onRetryDaily={() => runJob("retry-daily", "/api/jobs/retry-daily")}
            onRunJob={runJob}
          />
        )}

        <section className="panel">
          <PanelTitle title="报告队列" subtitle="全文报告生成状态。" />
          {loading ? (
            <LoadingPanel compact rows={5} title="读取报告队列" />
          ) : (
            <>
              <div className="queue-stats">
                {["queued", "processing", "done", "failed"].map((key) => (
                  <span className="pill" key={key}>{key}: {reports.stats?.[key] || 0}</span>
                ))}
              </div>
              <div className="compact-list report-compact-list">
                {(reports.items || []).slice(0, 12).map((item) => (
                  <article className="compact-item" key={item.paper_id}>
                    <strong>{item.title}</strong>
                    <p>{item.status} · {item.arxiv_id} · {fmtDate(item.updated_at)}</p>
                  </article>
                ))}
                {!(reports.items || []).length ? <p className="muted">报告队列为空。</p> : null}
              </div>
            </>
          )}
        </section>

        <section className="panel tasks-history-panel">
          <PanelTitle title="任务历史" subtitle="最近 30 次 worker 执行记录。" />
          {loading ? <LoadingPanel compact rows={6} title="读取任务历史" /> : <HistoryTable history={history} />}
        </section>
      </div>
    </section>
  );
}
