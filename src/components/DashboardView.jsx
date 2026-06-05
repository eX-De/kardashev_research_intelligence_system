import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { DailyRunProgressCard } from "./DailyRunProgressCard.jsx";
import { LoadingPanel } from "./Loading.jsx";
import { PanelTitle } from "./PanelTitle.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { api, fmtDate, postJson } from "../lib/dashboard.js";
import { useCachedApi } from "../lib/apiCache.jsx";

const SOURCE_UPDATE_COMMAND = `git pull
npm install
npm run build
npm run start:api`;

const DEFAULT_DOCKER_SERVICE = "app";

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

function updateFromNotification(item) {
  const update = item?.source?.update;
  return update && typeof update === "object" ? update : {};
}

function updateDialogTitle(kind) {
  if (kind === "source") return "源码更新命令";
  if (kind === "docker") return "Docker 更新命令";
  return "更新说明";
}

function updateDialogDescription(kind) {
  if (kind === "source") return "适合从 GitHub 源码运行的部署。执行前请先停止或切换正在运行的服务进程。";
  if (kind === "docker") return "适合 Docker Compose 部署。服务名不是 app 时，请把命令里的 app 改成实际服务名。";
  return "本弹窗显示该版本的 GitHub Release 说明；如果没有发布说明，会显示版本和链接信息。";
}

function releaseNotesText(update) {
  const notes = String(update.release_notes || "").trim();
  if (notes) return notes;
  const tag = update.latest_tag || update.latest_version || "新版本";
  return `这个版本没有可用的 GitHub Release 更新说明。\n\n版本：${tag}`;
}

async function copyText(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error("复制不可用，请手动复制命令。");
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function UpdateNotificationCard({ item, onOpen }) {
  const update = updateFromNotification(item);
  return (
    <article className={`compact-item update-available ${item.severity || ""}`} key={item.id}>
      <strong>{item.title}</strong>
      <p>{item.detail}{item.created_at ? ` · ${fmtDate(item.created_at)}` : ""}</p>
      <div className="compact-actions">
        <button className="primary" onClick={() => onOpen("release", item)} type="button">查看更新说明</button>
        <button onClick={() => onOpen("source", item)} type="button">源码更新命令</button>
        <button onClick={() => onOpen("docker", item)} type="button">Docker 更新命令</button>
      </div>
      {update.release_url ? <p><a href={update.release_url} target="_blank" rel="noreferrer">GitHub 页面</a></p> : null}
    </article>
  );
}

function UpdateDialog({ dialog, onClose, onCopy }) {
  const [dockerService, setDockerService] = useState(DEFAULT_DOCKER_SERVICE);
  const update = updateFromNotification(dialog.item);
  const dockerServiceName = dockerService.trim() || DEFAULT_DOCKER_SERVICE;
  const dockerCommands = [
    `docker compose pull ${dockerServiceName}`,
    `docker compose up -d ${dockerServiceName}`
  ];
  const command = dialog.kind === "docker" ? dockerCommands.join("\n") : SOURCE_UPDATE_COMMAND;
  const isCommand = dialog.kind === "source" || dialog.kind === "docker";
  const title = updateDialogTitle(dialog.kind);
  const description = updateDialogDescription(dialog.kind);
  return (
    <div className="modal-backdrop" role="presentation">
      <article aria-modal="true" aria-labelledby="update-dialog-title" className="modal-dialog update-dialog" role="dialog">
        <header className="modal-header">
          <div>
            <span>应用更新</span>
            <h2 id="update-dialog-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button aria-label="关闭" className="modal-close" onClick={onClose} type="button">×</button>
        </header>
        {dialog.kind === "docker" ? (
          <div className="modal-body">
            <label className="service-name-field">
              <span>服务名</span>
              <input
                autoComplete="off"
                spellCheck="false"
                type="text"
                value={dockerService}
                onChange={(event) => setDockerService(event.target.value)}
              />
            </label>
            <div className="command-line-list">
              {dockerCommands.map((line) => (
                <div className="command-line-row" key={line}>
                  <code>{line}</code>
                  <button onClick={() => onCopy(line, "Docker 命令")} type="button">复制</button>
                </div>
              ))}
            </div>
          </div>
        ) : isCommand ? (
          <div className="modal-body">
            <pre className="command-block"><code>{command}</code></pre>
          </div>
        ) : (
          <div className="modal-body">
            <div className="release-meta">
              <strong>{update.release_name || update.latest_tag || update.latest_version || "新版本"}</strong>
              <p>
                当前 {update.current_version || "未知"} · 最新 {update.latest_version || update.latest_tag || "未知"}
                {update.published_at ? ` · 发布于 ${fmtDate(update.published_at)}` : ""}
              </p>
            </div>
            <pre className="release-notes">{releaseNotesText(update)}</pre>
          </div>
        )}
        <div className="modal-actions">
          {isCommand ? <button className="primary" onClick={() => onCopy(command, title)} type="button">复制全部</button> : null}
          {update.release_url ? <a className="modal-link-button" href={update.release_url} target="_blank" rel="noreferrer">打开 GitHub 页面</a> : null}
          <button onClick={onClose} type="button">关闭</button>
        </div>
      </article>
    </div>
  );
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

function DailyRunIssueCard({ item, onRunNow }) {
  return (
    <article className="current-run-card bad">
      <span>需要处理</span>
      <strong>{item?.title || "每日流程失败"}</strong>
      <p>{item?.detail || "每日流程失败，请查看通知详情。"}</p>
      <div className="current-run-actions">
        <button className="primary" onClick={onRunNow} type="button">重新执行每日流程</button>
      </div>
    </article>
  );
}

export function DashboardView({ setStatusMessage, notify = () => {} }) {
  const [updateDialog, setUpdateDialog] = useState(null);
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
  const arxivRateLimitNotification = notifications.find((item) => item.type === "arxiv_rate_limited");
  const listNotifications = notifications.filter((item) => (
    item.id !== dailyRunNotification?.id
    && item.id !== recoverableNotification?.id
    && item.id !== arxivRateLimitNotification?.id
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

  function rerunDaily() {
    runDailyCommand("/api/jobs/run-now", {}, "正在重新执行每日流程...");
  }

  function openUpdateDialog(kind, item) {
    setUpdateDialog({ kind, item });
  }

  async function copyUpdateCommand(command, label) {
    try {
      await copyText(command);
      const message = `${label}复制成功`;
      setStatusMessage(message);
      notify(message, { type: "success" });
    } catch (error) {
      const message = error.message || "复制失败，请手动复制命令。";
      setStatusMessage(message);
      notify(message, { type: "error" });
    }
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
              ) : arxivRateLimitNotification ? (
                <DailyRunIssueCard
                  item={arxivRateLimitNotification}
                  onRunNow={rerunDaily}
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
                item.type === "app_update_available" ? (
                  <UpdateNotificationCard item={item} key={item.id} onOpen={openUpdateDialog} />
                ) : (
                  <article className={`compact-item ${item.severity || ""}`} key={item.id}>
                    <strong>{item.title}</strong>
                    <p>{item.detail}{item.created_at ? ` · ${fmtDate(item.created_at)}` : ""}</p>
                  </article>
                )
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
      {updateDialog ? (
        <UpdateDialog
          dialog={updateDialog}
          onClose={() => setUpdateDialog(null)}
          onCopy={copyUpdateCommand}
        />
      ) : null}
    </section>
  );
}
