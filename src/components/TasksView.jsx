import { useCallback, useEffect, useRef } from "react";

import { LoadingPanel } from "./Loading.jsx";
import { PanelTitle } from "./PanelTitle.jsx";
import { TaskControlPanel } from "./TaskControlPanel.jsx";
import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
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

function schedulerStatusMessage(scheduler) {
  const current = scheduler?.current_job;
  return current ? `Running ${current.command}...` : scheduler?.last_job?.message || scheduler?.last_error?.message || "Idle";
}

export function TasksView({ setStatusMessage }) {
  const cache = useApiCacheClient();
  const detailsLoadedRef = useRef(false);
  const statusQuery = useCachedApi(["jobs", "status"], () => api("/api/jobs/status"), { staleTime: 5000 });
  const jobsSummaryQuery = useCachedApi(["jobs", "summary"], () => api("/api/jobs/summary"), { staleTime: 15000 });
  const paperReportsSummaryQuery = useCachedApi(["paper-reports", "summary"], () => api("/api/paper-reports/summary"), { staleTime: 15000 });
  const historyQuery = useCachedApi(["jobs", "history", 30], () => api("/api/jobs/history?limit=30"), { enabled: false, staleTime: 60000 });
  const reportsQuery = useCachedApi(["paper-reports", 80], () => api("/api/paper-reports?limit=80"), { enabled: false, staleTime: 30000 });
  const scheduler = statusQuery.data?.scheduler || {};
  const jobsSummary = jobsSummaryQuery.data || {};
  const paperReportsSummary = paperReportsSummaryQuery.data || {};
  const fallbackHistory = jobsSummary.latest_job ? [{ ...jobsSummary.latest_job, meta: {} }] : [];
  const history = historyQuery.hasData ? historyQuery.data?.items || [] : fallbackHistory;
  const reports = {
    stats: reportsQuery.data?.stats || paperReportsSummary.stats || {},
    items: reportsQuery.data?.items || []
  };
  const loading = !statusQuery.hasData || !jobsSummaryQuery.hasData || !paperReportsSummaryQuery.hasData;
  const detailsRefreshing = historyQuery.refreshing || reportsQuery.refreshing;
  const refreshStatusCache = statusQuery.refresh;
  const refreshJobsSummaryCache = jobsSummaryQuery.refresh;
  const refreshPaperReportsSummaryCache = paperReportsSummaryQuery.refresh;
  const refreshHistoryCache = historyQuery.refresh;
  const refreshReportsCache = reportsQuery.refresh;

  const applyScheduler = useCallback((nextScheduler = {}) => {
    cache.setCache(["jobs", "status"], { scheduler: nextScheduler || {} });
    setStatusMessage(schedulerStatusMessage(nextScheduler));
  }, [cache, setStatusMessage]);

  const refreshStatus = useCallback(async () => {
    const statusData = await refreshStatusCache();
    applyScheduler(statusData.scheduler || {});
    return statusData;
  }, [applyScheduler, refreshStatusCache]);

  const refreshAll = useCallback(async () => {
    const [statusData, jobsSummaryData, reportsSummaryData, historyData, reportData] = await Promise.all([
      refreshStatusCache(),
      refreshJobsSummaryCache(),
      refreshPaperReportsSummaryCache(),
      refreshHistoryCache(),
      refreshReportsCache()
    ]);
    applyScheduler(statusData.scheduler || {});
    return [statusData, jobsSummaryData, reportsSummaryData, historyData, reportData];
  }, [applyScheduler, refreshHistoryCache, refreshJobsSummaryCache, refreshPaperReportsSummaryCache, refreshReportsCache, refreshStatusCache]);

  useEffect(() => {
    if (statusQuery.data?.scheduler) {
      setStatusMessage(schedulerStatusMessage(statusQuery.data.scheduler));
    }
  }, [setStatusMessage, statusQuery.data]);

  useEffect(() => {
    if (detailsLoadedRef.current) return undefined;
    detailsLoadedRef.current = true;
    Promise.all([
      refreshHistoryCache(),
      refreshReportsCache()
    ]).catch((error) => setStatusMessage(error.message));
    return undefined;
  }, [refreshHistoryCache, refreshReportsCache, setStatusMessage]);

  useEffect(() => {
    const error = statusQuery.error || jobsSummaryQuery.error || paperReportsSummaryQuery.error || historyQuery.error || reportsQuery.error;
    if (error) setStatusMessage(error.message);
  }, [historyQuery.error, jobsSummaryQuery.error, paperReportsSummaryQuery.error, reportsQuery.error, setStatusMessage, statusQuery.error]);

  async function runJob(name, endpoint = `/api/jobs/${name}`) {
    setStatusMessage(`Running ${name}...`);
    try {
      const data = await postJson(endpoint);
      setStatusMessage(data.message || `${name} finished`);
      await refreshAll();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function startStartupDaily() {
    setStatusMessage("Updating scheduler...");
    try {
      const data = await postJson("/api/settings", { run_daily_on_startup_enabled: true, scheduler_enabled: false });
      if (data.scheduler) applyScheduler(data.scheduler);
      else await refreshStatus();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function startScheduler() {
    setStatusMessage("Updating scheduler...");
    try {
      const data = await postJson("/api/jobs/scheduler/start", {});
      if (data.scheduler) applyScheduler(data.scheduler);
      else await refreshStatus();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function stopScheduler() {
    setStatusMessage("Updating scheduler...");
    try {
      const data = await postJson("/api/settings", { run_daily_on_startup_enabled: false, scheduler_enabled: false });
      if (data.scheduler) applyScheduler(data.scheduler);
      else await refreshStatus();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  return (
    <section className="view tasks-view">
      <header className="project-dashboard-header">
        <div>
          <h1>任务</h1>
          <p>每日流程、报告队列和任务历史。</p>
        </div>
        <button onClick={() => refreshAll().catch((error) => setStatusMessage(error.message))} type="button">刷新</button>
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
                {!(reports.items || []).length && paperReportsSummary.latest ? (
                  <article className="compact-item">
                    <strong>最近报告 #{paperReportsSummary.latest.artifact_id}</strong>
                    <p>{paperReportsSummary.latest.status} · Paper {paperReportsSummary.latest.paper_id} · {fmtDate(paperReportsSummary.latest.updated_at)}</p>
                  </article>
                ) : null}
                {detailsRefreshing ? <p className="muted">正在更新队列明细...</p> : null}
                {!(reports.items || []).length && !paperReportsSummary.latest ? <p className="muted">报告队列为空。</p> : null}
              </div>
            </>
          )}
        </section>

        <section className="panel tasks-history-panel">
          <PanelTitle title="任务历史" subtitle="最近任务执行记录。" />
          {loading ? <LoadingPanel compact rows={6} title="读取任务历史" /> : <HistoryTable history={history} />}
        </section>
      </div>
    </section>
  );
}
