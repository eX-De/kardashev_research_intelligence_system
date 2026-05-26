import { useEffect } from "react";
import { Link } from "react-router-dom";

import { DailyRunProgressCard } from "./DailyRunProgressCard.jsx";
import { LoadingPanel } from "./Loading.jsx";
import { PanelTitle } from "./PanelTitle.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { api, fmtDate, postJson } from "../lib/dashboard.js";
import { useCachedApi } from "../lib/apiCache.jsx";

function Metric({ label, value, hint }) {
  return (
    <div className="dashboard-metric">
      <span>{label}</span>
      <strong>{value ?? 0}</strong>
      <p>{hint}</p>
    </div>
  );
}

function artifactPath(artifactId) {
  return `/artifacts/${encodeURIComponent(String(artifactId))}`;
}

function paperPath(paperId) {
  return `/papers/library/${encodeURIComponent(String(paperId))}`;
}

function recoveryFromNotification(item) {
  const recovery = item?.source?.recovery;
  return recovery?.resumable ? recovery : null;
}

function DailyRunRecoveryCard({ item, onResume, onRunNow }) {
  const recovery = recoveryFromNotification(item) || {};
  const count = recovery.total ? `${recovery.completed || 0}/${recovery.total}` : `${recovery.completed || 0} 步`;
  return (
    <article className="current-run-card recoverable">
      <span>建议操作</span>
      <strong>{item?.title || "每日流程可继续"}</strong>
      <p>{item?.detail || `上次流程失败在：${recovery.failed_label || "未知阶段"}，已完成 ${count}。`}</p>
      <div className="current-run-actions">
        <button className="primary" onClick={onResume} type="button">继续上次每日流程</button>
        <button onClick={onRunNow} type="button">重新执行今日流程</button>
      </div>
    </article>
  );
}

export function DashboardView({ setStatusMessage }) {
  const healthQuery = useCachedApi(["health", "summary"], () => api("/api/health/summary"), { staleTime: 60000 });
  const jobStatusQuery = useCachedApi(["jobs", "status"], () => api("/api/jobs/status"), { staleTime: 5000 });
  const notificationsQuery = useCachedApi(["notifications", 5], () => api("/api/notifications?limit=5"), { staleTime: 30000 });
  const artifactsQuery = useCachedApi(["artifacts", "list", "limit=8"], () => api("/api/artifacts?limit=8"), { staleTime: 60000 });
  const papersQuery = useCachedApi(["library", "list", "status=saved&limit=8"], () => api("/api/library?status=saved&limit=8"), { staleTime: 60000 });
  const queries = [healthQuery, jobStatusQuery, notificationsQuery, artifactsQuery, papersQuery];

  useEffect(() => {
    const error = queries.find((query) => query.error)?.error;
    if (error) setStatusMessage(error.message);
  }, [healthQuery.error, jobStatusQuery.error, notificationsQuery.error, artifactsQuery.error, papersQuery.error, setStatusMessage]);

  const loading = queries.some((query) => !query.hasData);
  const health = healthQuery.data || null;
  const jobStatus = jobStatusQuery.data || null;
  const notifications = notificationsQuery.data?.items || [];
  const artifacts = artifactsQuery.data?.items || [];
  const papers = papersQuery.data?.items || [];

  async function refresh() {
    try {
      await Promise.all(queries.map((query) => query.refresh({ force: true })));
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  const counts = health?.counts || {};
  const currentJob = jobStatus?.scheduler?.current_job;
  const latestJob = health?.latest_job;
  const dailyRunNotification = notifications.find((item) => item.progress);
  const recoverableNotification = notifications.find((item) => item.type === "daily_run_recoverable");
  const listNotifications = notifications.filter((item) => (
    item.id !== dailyRunNotification?.id && item.id !== recoverableNotification?.id
  ));
  const recentUpdates = [
    ...artifacts.map((artifact) => ({
      id: `artifact-${artifact.id}`,
      type: "产物",
      title: artifact.title,
      meta: `${artifact.artifact_type} · ${artifact.status}`,
      at: artifact.updated_at,
      to: artifactPath(artifact.id)
    })),
    ...papers.map((paper) => ({
      id: `paper-${paper.id}`,
      type: "论文",
      title: paper.title,
      meta: `${paper.arxiv_id || paper.venue || paper.canonical_key || "paper"} · ${paper.library_status}`,
      at: paper.updated_at,
      to: paperPath(paper.id)
    }))
  ]
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
    .slice(0, 8);

  async function runDailyCommand(endpoint, body, message) {
    setStatusMessage(message);
    try {
      const data = await postJson(endpoint, body);
      setStatusMessage(data.message || "每日流程已完成");
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  function resumeDailyRun() {
    runDailyCommand("/api/jobs/resume-daily", {}, "正在继续上次每日流程...");
  }

  function runDailyNow() {
    const ok = window.confirm("今天已有失败但可恢复的每日流程。重新执行会新建一轮流程，可能重复抓取、匹配和消耗 LLM。确定重新执行？");
    if (!ok) return;
    runDailyCommand("/api/jobs/run-now", { force: true }, "正在重新执行今日流程...");
  }

  return (
    <section className="view dashboard-view">
      <header className="project-dashboard-header">
        <div>
          <h1>首页</h1>
          <p>今日状态、通知和最近更新。</p>
        </div>
        <RefreshButton onClick={refresh} />
      </header>

      <div className="dashboard-grid">
        <section className="panel dashboard-overview">
          <PanelTitle title="今日状态" subtitle="每日流程进度和核心规模。" />
          {loading ? (
            <LoadingPanel compact rows={5} title="读取今日状态" />
          ) : (
            <>
              {dailyRunNotification ? (
                <DailyRunProgressCard item={dailyRunNotification} />
              ) : recoverableNotification ? (
                <DailyRunRecoveryCard
                  item={recoverableNotification}
                  onResume={resumeDailyRun}
                  onRunNow={runDailyNow}
                />
              ) : (
                <div className={`current-run-card ${currentJob ? "running" : latestJob?.status === "failed" ? "bad" : "idle"}`}>
                  <span>{currentJob ? "运行中" : "当前状态"}</span>
                  <strong>{currentJob ? currentJob.command : latestJob?.status || "Idle"}</strong>
                  <p>{currentJob ? "任务正在后台执行" : latestJob?.message || "没有正在运行的任务"}</p>
                </div>
              )}
              <div className="dashboard-metrics">
                <Metric label="项目" value={counts.projects} hint="研究项目" />
                <Metric label="论文仓库" value={counts.papers} hint="长期论文对象" />
                <Metric label="报告队列" value={counts.paper_report_artifacts ?? counts.paper_reading_reports ?? 0} hint="全文报告任务" />
                <Metric label="上下文" value={counts.knowledge_documents || counts.notes} hint="知识来源" />
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <PanelTitle title="通知" subtitle="只显示需要关注的运行、异常和决策通知。" />
          {loading ? (
            <LoadingPanel compact rows={4} title="读取通知" />
          ) : (
            <div className="compact-list">
              {listNotifications.map((item) => (
                <article className={`compact-item ${item.severity || ""}`} key={item.id}>
                  <strong>{item.title}</strong>
                  <p>{item.detail}{item.created_at ? ` · ${fmtDate(item.created_at)}` : ""}</p>
                </article>
              ))}
              {!listNotifications.length ? <p className="muted">暂无通知。</p> : null}
            </div>
          )}
        </section>

        <section className="panel dashboard-updates-panel">
          <PanelTitle title="最近更新" subtitle="论文和产物按时间合并展示。" />
          {loading ? (
            <LoadingPanel compact rows={5} title="读取最近更新" />
          ) : (
            <div className="compact-list">
              {recentUpdates.length ? recentUpdates.map((item) => (
                <Link className="compact-item update-item update-link" key={item.id} to={item.to}>
                  <span className="pill">{item.type}</span>
                  <strong>{item.title}</strong>
                  <p>{item.meta} · {fmtDate(item.at)}</p>
                </Link>
              )) : <p className="muted">暂无最近更新。</p>}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
