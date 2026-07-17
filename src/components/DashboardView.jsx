import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { DailyRunProgressCard } from "./DailyRunProgressCard.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { formatMetricCount, VisionMetric } from "./VisionMetric.jsx";
import { api, fmtDate, postJson } from "../lib/dashboard.js";
import { useCachedApi } from "../lib/apiCache.jsx";
import "../styles/DashboardView.css";

const SOURCE_UPDATE_COMMAND = `git pull
npm install
npm run build
npm run start:api`;

const DEFAULT_DOCKER_SERVICE = "app";

function DashboardRunSkeleton() {
  return (
    <div className="dashboard-run-skeleton" role="status" aria-label="读取今日状态" aria-live="polite">
      <span className="dashboard-skeleton-bar is-kicker" />
      <span className="dashboard-skeleton-bar is-run-title" />
      <span className="dashboard-skeleton-bar is-run-copy" />
      <div className="dashboard-skeleton-progress"><i /></div>
      <div className="dashboard-skeleton-actions"><span /><span /></div>
    </div>
  );
}

function DashboardFeedSkeleton({ recent = false, rows = 3, title }) {
  return (
    <div className={`dashboard-feed-skeleton ${recent ? "is-recent" : ""}`} role="status" aria-label={title} aria-live="polite">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="dashboard-feed-skeleton-row" key={index}>
          {recent ? <span className="dashboard-skeleton-bar is-type" /> : null}
          <span className="dashboard-skeleton-bar is-feed-title" />
          <span className="dashboard-skeleton-bar is-feed-copy" />
        </div>
      ))}
    </div>
  );
}

function dashboardRunState(currentJob, latestJob) {
  if (currentJob) {
    return {
      kind: "running",
      tone: "running",
      title: "后台任务正在执行",
      detail: "任务状态会在完成后自动更新。"
    };
  }

  const status = String(latestJob?.status || "").toLowerCase();
  if (status === "failed") {
    return {
      kind: "failed",
      tone: "attention",
      title: "最近一轮任务未完成",
      detail: "请查看需要关注中的详情，或从任务控制页重新执行。"
    };
  }

  if (status === "queued" || status === "pending") {
    return {
      kind: "queued",
      tone: "queued",
      title: "任务正在排队",
      detail: "后台工作进程会在可用时开始处理。"
    };
  }

  if (status === "completed" || status === "success") {
    return {
      kind: "completed",
      tone: "ready",
      title: "最近一轮任务已完成",
      detail: "结果已同步到对应的论文、报告或研究产物中。"
    };
  }

  return {
    kind: "idle",
    tone: "ready",
    title: "暂无正在运行的任务",
    detail: "你可以从右侧选择下一项工作。"
  };
}

function dashboardHeroCopy({ dailyRunNotification, recoverableNotification, arxivRateLimitNotification, runState }) {
  if (dailyRunNotification) {
    return {
      title: "每日流程正在推进",
      detail: "当前阶段、处理进度和缓存状态显示在下方。"
    };
  }

  if (recoverableNotification) {
    return {
      title: "每日流程可以从中断处继续",
      detail: "已完成的阶段会保留；你可以继续处理，或明确选择重新执行。"
    };
  }

  if (arxivRateLimitNotification) {
    return {
      title: "来源同步暂时受限",
      detail: "等待来源恢复后，可以从下方重新执行每日流程。"
    };
  }

  const copy = {
    running: {
      title: "研究数据正在更新",
      detail: "后台任务完成后，相关论文、报告和研究产物会自动同步。"
    },
    failed: {
      title: "需要检查上一轮处理",
      detail: "任务详情和后续操作会显示在下方及状态中心。"
    },
    queued: {
      title: "下一项任务正在等待执行",
      detail: "后台工作进程可用后会自动开始处理。"
    },
    completed: {
      title: "本轮研究工作已同步",
      detail: "你可以查看结果，或从右侧继续下一项工作。"
    },
    idle: {
      title: "工作区已准备就绪",
      detail: "从右侧选择下一项工作，或等待计划任务启动。"
    }
  };

  return copy[runState.kind] || copy.idle;
}

function dashboardTopStatus({ dailyRunNotification, recoverableNotification, arxivRateLimitNotification, runState }) {
  if (dailyRunNotification) return { tone: "running", label: "每日流程运行中" };
  if (recoverableNotification) return { tone: "queued", label: "可继续执行" };
  if (arxivRateLimitNotification || runState.kind === "failed") return { tone: "attention", label: "需要处理" };
  if (runState.kind === "running") return { tone: "running", label: "后台任务运行中" };
  if (runState.kind === "queued") return { tone: "queued", label: "任务排队中" };
  return { tone: "ready", label: "系统正常" };
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
    <article className={`vision-feed-item vision-update-available ${item.severity || ""}`} key={item.id}>
      <strong>{item.title}</strong>
      <p>{item.detail}{item.created_at ? ` · ${fmtDate(item.created_at)}` : ""}</p>
      <div className="vision-feed-actions">
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
    <article className="vision-run-card recoverable">
      <strong>{item?.title || "每日流程可继续"}</strong>
      <p>{item?.detail || `上次流程失败在：${recovery.failed_label || "未知阶段"}，已完成 ${count}。`}</p>
      <div className="vision-run-actions">
        <button className="primary" onClick={onResume} type="button">继续上次每日流程</button>
        <button onClick={onRunNow} type="button">重新执行今日流程</button>
      </div>
    </article>
  );
}

function DailyRunIssueCard({ item, onRunNow }) {
  return (
    <article className="vision-run-card bad">
      <strong>{item?.title || "每日流程失败"}</strong>
      <p>{item?.detail || "每日流程失败，请查看通知详情。"}</p>
      <div className="vision-run-actions">
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
  const reportCount = counts.paper_report_artifacts ?? counts.paper_reading_reports ?? 0;
  const runState = dashboardRunState(currentJob, latestJob);
  const dailyRunNotification = notifications.find((item) => item.progress);
  const recoverableNotification = notifications.find((item) => item.type === "daily_run_recoverable");
  const arxivRateLimitNotification = notifications.find((item) => item.type === "arxiv_rate_limited");
  const heroCopy = dashboardHeroCopy({ dailyRunNotification, recoverableNotification, arxivRateLimitNotification, runState });
  const topStatus = dashboardTopStatus({ dailyRunNotification, recoverableNotification, arxivRateLimitNotification, runState });
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
    <section className="view vision-dashboard">
      <header className="vision-topbar">
        <div className="vision-brand">
          <span>研究智能</span>
          <h1>研究工作台</h1>
        </div>
        <div className="vision-top-actions">
          <span className={`vision-live-state ${topStatus.tone}`}><i aria-hidden="true" />{topStatus.label}</span>
          <RefreshButton className="vision-refresh" onClick={refresh} />
        </div>
      </header>

      <main className="vision-layout">
        <section className={`vision-hero ${topStatus.tone}`} aria-labelledby="vision-run-title">
          <div className="vision-hero-art" aria-hidden="true" />
          <div className="vision-hero-copy">
            <span>今日运行</span>
            <h2 id="vision-run-title">{heroCopy.title}</h2>
            <p>{heroCopy.detail}</p>
          </div>
          <div className="vision-run-content">
            {loading ? (
              <DashboardRunSkeleton />
            ) : dailyRunNotification ? (
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
              <article className={`vision-run-card ${runState.tone}`}>
                <strong>{runState.title}</strong>
                <p>{runState.detail}</p>
              </article>
            )}
          </div>
        </section>

        <aside className="vision-actions-card" aria-labelledby="vision-actions-title">
          <div className="vision-actions-art" aria-hidden="true" />
          <div className="vision-actions-content">
            <header>
              <span>工作入口</span>
              <h2 id="vision-actions-title">下一步</h2>
            </header>
            <nav className="vision-action-list" aria-label="工作区快捷入口">
              <Link to="/papers/inbox">
                <span><strong>待判断</strong><small>候选论文与人工决策</small></span>
                <b aria-hidden="true">→</b>
              </Link>
              <Link to="/papers/reports">
                <span><strong>报告队列</strong><small>{formatMetricCount(reportCount)} 个全文分析任务</small></span>
                <b aria-hidden="true">→</b>
              </Link>
              <Link to="/artifacts">
                <span><strong>研究产物</strong><small>日报、摘要与可交付结果</small></span>
                <b aria-hidden="true">→</b>
              </Link>
              <Link to="/settings">
                <span><strong>自动化设置</strong><small>来源、规则与后台任务</small></span>
                <b aria-hidden="true">→</b>
              </Link>
            </nav>
          </div>
        </aside>

        <section className="vision-stats" aria-label="研究规模">
          <VisionMetric label="项目" value={counts.projects} hint="研究项目" tone="violet" to="/projects" />
          <VisionMetric label="论文仓库" value={counts.papers} hint="长期论文对象" tone="blue" to="/papers/library" />
          <VisionMetric label="报告队列" value={reportCount} hint="全文分析任务" tone="coral" to="/papers/reports" />
          <VisionMetric label="上下文" value={counts.knowledge_documents || counts.notes} hint="知识来源" tone="gold" to="/artifacts" />
        </section>

        <section className="vision-attention-card" aria-labelledby="vision-attention-title">
          <header className="vision-card-heading">
            <div>
              <span>状态中心</span>
              <h2 id="vision-attention-title">需要关注</h2>
            </div>
            <em>{loading ? "同步中" : listNotifications.length ? `${listNotifications.length} 项` : "全部清晰"}</em>
          </header>
          {loading ? (
            <DashboardFeedSkeleton rows={3} title="读取通知" />
          ) : (
            <div className="vision-feed-list">
              {listNotifications.map((item) => (
                item.type === "app_update_available" ? (
                  <UpdateNotificationCard item={item} key={item.id} onOpen={openUpdateDialog} />
                ) : (
                  <article className={`vision-feed-item ${item.severity || ""}`} key={item.id}>
                    <strong>{item.title}</strong>
                    <p>{item.detail}{item.created_at ? ` · ${fmtDate(item.created_at)}` : ""}</p>
                  </article>
                )
              ))}
              {!listNotifications.length ? <p className="vision-empty">当前没有需要处理的通知。</p> : null}
            </div>
          )}
        </section>

        <section className="vision-recent-card" aria-labelledby="vision-recent-title">
          <div className="vision-recent-cover">
            <div className="vision-recent-art" aria-hidden="true" />
            <header className="vision-card-heading">
              <div>
                <span>研究流</span>
                <h2 id="vision-recent-title">最近更新</h2>
              </div>
            </header>
          </div>
          {loading ? (
            <DashboardFeedSkeleton recent rows={4} title="读取最近更新" />
          ) : (
            <div className="vision-feed-list vision-recent-list">
              {recentUpdates.length ? recentUpdates.map((item) => (
                <Link className="vision-feed-item vision-recent-item" key={item.id} to={item.to}>
                  <span className="vision-item-type">{item.type}</span>
                  <strong>{item.title}</strong>
                  <p>{item.meta} · {fmtDate(item.at)}</p>
                </Link>
              )) : <p className="vision-empty">暂无最近更新。</p>}
            </div>
          )}
        </section>
      </main>
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
