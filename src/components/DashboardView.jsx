import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { DailyRunProgressCard } from "./DailyRunProgressCard.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { formatMetricCount, VisionMetric } from "./VisionMetric.jsx";
import { api, fmtDate, postJson } from "../lib/dashboard.js";
import { useCachedApi } from "../lib/apiCache.jsx";
import { formatNotification } from "../lib/systemMessages.js";
import "../styles/DashboardView.css";

const SOURCE_UPDATE_COMMAND = `git pull
npm install
npm run build
npm run start:api`;

const DEFAULT_DOCKER_SERVICE = "app";

function DashboardRunSkeleton() {
  const { t } = useTranslation("dashboard");
  return (
    <div className="dashboard-run-skeleton" role="status" aria-label={t("page.loadingToday")} aria-live="polite">
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

function dashboardRunState(currentJob, latestJob, t) {
  if (currentJob) {
    return {
      kind: "running",
      tone: "running",
      title: t("runState.running.title"), detail: t("runState.running.detail")
    };
  }

  const status = String(latestJob?.status || "").toLowerCase();
  if (status === "failed") {
    return {
      kind: "failed",
      tone: "attention",
      title: t("runState.failed.title"), detail: t("runState.failed.detail")
    };
  }

  if (status === "queued" || status === "pending") {
    return {
      kind: "queued",
      tone: "queued",
      title: t("runState.queued.title"), detail: t("runState.queued.detail")
    };
  }

  if (status === "completed" || status === "success") {
    return {
      kind: "completed",
      tone: "ready",
      title: t("runState.completed.title"), detail: t("runState.completed.detail")
    };
  }

  return {
    kind: "idle",
    tone: "ready",
    title: t("runState.idle.title"), detail: t("runState.idle.detail")
  };
}

function dashboardHeroCopy({ dailyRunNotification, dailyReportNotification, recoverableNotification, arxivRateLimitNotification, runState }, t) {
  if (dailyRunNotification) {
    return {
      title: t("hero.daily.title"), detail: t("hero.daily.detail")
    };
  }

  if (recoverableNotification) {
    return {
      title: t("hero.recoverable.title"), detail: t("hero.recoverable.detail")
    };
  }

  if (dailyReportNotification) {
    return {
      title: t("hero.report.title"), detail: t("hero.report.detail")
    };
  }

  if (arxivRateLimitNotification) {
    return {
      title: t("hero.rateLimited.title"), detail: t("hero.rateLimited.detail")
    };
  }

  const copy = {
    running: {
      title: t("hero.running.title"), detail: t("hero.running.detail")
    },
    failed: {
      title: t("hero.failed.title"), detail: t("hero.failed.detail")
    },
    queued: {
      title: t("hero.queued.title"), detail: t("hero.queued.detail")
    },
    completed: {
      title: t("hero.completed.title"), detail: t("hero.completed.detail")
    },
    idle: {
      title: t("hero.idle.title"), detail: t("hero.idle.detail")
    }
  };

  return copy[runState.kind] || copy.idle;
}

function dashboardTopStatus({ dailyRunNotification, dailyReportNotification, recoverableNotification, arxivRateLimitNotification, runState }, t) {
  if (dailyRunNotification) return { tone: "running", label: t("topStatus.daily") };
  if (recoverableNotification) return { tone: "queued", label: t("topStatus.recoverable") };
  if (dailyReportNotification) return { tone: "ready", label: t("topStatus.report") };
  if (arxivRateLimitNotification || runState.kind === "failed") return { tone: "attention", label: t("topStatus.attention") };
  if (runState.kind === "running") return { tone: "running", label: t("topStatus.running") };
  if (runState.kind === "queued") return { tone: "queued", label: t("topStatus.queued") };
  return { tone: "ready", label: t("topStatus.ready") };
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

function updateDialogTitle(kind, t) {
  if (kind === "source") return t("update.sourceTitle");
  if (kind === "docker") return t("update.dockerTitle");
  return t("update.releaseTitle");
}

function updateDialogDescription(kind, t) {
  if (kind === "source") return t("update.sourceDescription");
  if (kind === "docker") return t("update.dockerDescription");
  return t("update.releaseDescription");
}

function releaseNotesText(update, t) {
  const notes = String(update.release_notes || "").trim();
  if (notes) return notes;
  const tag = update.latest_tag || update.latest_version || t("update.newVersion");
  return t("update.noNotes", { tag });
}

async function copyText(text, t) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document === "undefined") throw new Error(t("update.copyUnavailable"));
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
  const { t, i18n } = useTranslation("dashboard");
  const { t: systemT } = useTranslation("system");
  const message = formatNotification(item, systemT);
  const update = updateFromNotification(item);
  return (
    <article className={`vision-feed-item vision-update-available ${item.severity || ""}`} key={item.id}>
      <strong>{message.title}</strong>
      <p>{message.detail}{item.created_at ? ` · ${fmtDate(item.created_at, i18n.resolvedLanguage)}` : ""}</p>
      <div className="vision-feed-actions">
        <button className="primary" onClick={() => onOpen("release", item)} type="button">{t("update.viewNotes")}</button>
        <button onClick={() => onOpen("source", item)} type="button">{t("update.sourceTitle")}</button>
        <button onClick={() => onOpen("docker", item)} type="button">{t("update.dockerTitle")}</button>
      </div>
      {update.release_url ? <p><a href={update.release_url} target="_blank" rel="noreferrer">{t("update.githubPage")}</a></p> : null}
    </article>
  );
}

function UpdateDialog({ dialog, onClose, onCopy }) {
  const { t, i18n } = useTranslation("dashboard");
  const [dockerService, setDockerService] = useState(DEFAULT_DOCKER_SERVICE);
  const update = updateFromNotification(dialog.item);
  const dockerServiceName = dockerService.trim() || DEFAULT_DOCKER_SERVICE;
  const dockerCommands = [
    `docker compose pull ${dockerServiceName}`,
    `docker compose up -d ${dockerServiceName}`
  ];
  const command = dialog.kind === "docker" ? dockerCommands.join("\n") : SOURCE_UPDATE_COMMAND;
  const isCommand = dialog.kind === "source" || dialog.kind === "docker";
  const title = updateDialogTitle(dialog.kind, t);
  const description = updateDialogDescription(dialog.kind, t);
  return (
    <div className="modal-backdrop" role="presentation">
      <article aria-modal="true" aria-labelledby="update-dialog-title" className="modal-dialog update-dialog" role="dialog">
        <header className="modal-header">
          <div>
            <span>{t("update.appUpdate")}</span>
            <h2 id="update-dialog-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button aria-label={t("update.close")} className="modal-close" onClick={onClose} type="button">×</button>
        </header>
        {dialog.kind === "docker" ? (
          <div className="modal-body">
            <label className="service-name-field">
              <span>{t("update.serviceName")}</span>
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
                  <button onClick={() => onCopy(line, t("update.dockerCommand"))} type="button">{t("update.copy")}</button>
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
              <strong>{update.release_name || update.latest_tag || update.latest_version || t("update.newVersion")}</strong>
              <p>
                {t("update.currentLatest", { current: update.current_version || t("update.unknown"), latest: update.latest_version || update.latest_tag || t("update.unknown") })}
                {update.published_at ? ` · ${t("update.publishedAt", { date: fmtDate(update.published_at, i18n.resolvedLanguage) })}` : ""}
              </p>
            </div>
            <pre className="release-notes">{releaseNotesText(update, t)}</pre>
          </div>
        )}
        <div className="modal-actions">
          {isCommand ? <button className="primary" onClick={() => onCopy(command, title)} type="button">{t("update.copyAll")}</button> : null}
          {update.release_url ? <a className="modal-link-button" href={update.release_url} target="_blank" rel="noreferrer">{t("update.openGithub")}</a> : null}
          <button onClick={onClose} type="button">{t("update.close")}</button>
        </div>
      </article>
    </div>
  );
}

function DailyRunRecoveryCard({ item, onResume, onRunNow }) {
  const { t } = useTranslation("dashboard");
  const { t: systemT } = useTranslation("system");
  const message = formatNotification(item, systemT);
  const recovery = recoveryFromNotification(item) || {};
  const count = recovery.total ? `${recovery.completed || 0}/${recovery.total}` : t("run.steps", { count: recovery.completed || 0 });
  return (
    <article className="vision-run-card recoverable">
      <strong>{message.title || t("run.recoveryTitle")}</strong>
      <p>{message.detail || t("run.recoveryDetail", { stage: recovery.failed_label || t("run.unknownStage"), count })}</p>
      <div className="vision-run-actions">
        <button className="primary" onClick={onResume} type="button">{t("run.resume")}</button>
        <button onClick={onRunNow} type="button">{t("run.rerunToday")}</button>
      </div>
    </article>
  );
}

function DailyRunIssueCard({ item, onRunNow }) {
  const { t } = useTranslation("dashboard");
  const { t: systemT } = useTranslation("system");
  const message = formatNotification(item, systemT);
  return (
    <article className="vision-run-card bad">
      <strong>{message.title || t("run.failedTitle")}</strong>
      <p>{message.detail || t("run.failedDetail")}</p>
      <div className="vision-run-actions">
        <button className="primary" onClick={onRunNow} type="button">{t("run.rerun")}</button>
      </div>
    </article>
  );
}

function DailyReportReadyCard({ item }) {
  const { t } = useTranslation("dashboard");
  const { t: systemT } = useTranslation("system");
  const message = formatNotification(item, systemT);
  const artifactId = Number(item?.source?.artifact_id || 0);
  return (
    <article className="vision-run-card ready">
      <strong>{message.title || t("run.reportTitle")}</strong>
      <p>{message.detail || t("run.reportDetail")}</p>
      {artifactId > 0 ? (
        <div className="vision-run-actions">
          <Link className="primary" to={artifactPath(artifactId)}>{t("run.viewReport")}</Link>
        </div>
      ) : null}
    </article>
  );
}

export function DashboardView({ setStatusMessage, notify = () => {} }) {
  const { t, i18n } = useTranslation("dashboard");
  const { t: systemT } = useTranslation("system");
  const { t: artifactsT } = useTranslation("artifacts");
  const { t: papersT } = useTranslation("papers");
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
  const runState = dashboardRunState(currentJob, latestJob, t);
  const dailyRunNotification = notifications.find((item) => item.progress);
  const dailyReportNotification = notifications.find((item) => (
    item.type === "daily_run_completed" && Number(item?.source?.artifact_id || 0) > 0
  ));
  const recoverableNotification = notifications.find((item) => item.type === "daily_run_recoverable");
  const arxivRateLimitNotification = notifications.find((item) => item.type === "arxiv_rate_limited");
  const heroCopy = dashboardHeroCopy({ dailyRunNotification, dailyReportNotification, recoverableNotification, arxivRateLimitNotification, runState }, t);
  const topStatus = dashboardTopStatus({ dailyRunNotification, dailyReportNotification, recoverableNotification, arxivRateLimitNotification, runState }, t);
  const listNotifications = notifications.filter((item) => (
    item.id !== dailyRunNotification?.id
    && item.id !== dailyReportNotification?.id
    && item.id !== recoverableNotification?.id
    && item.id !== arxivRateLimitNotification?.id
  ));
  const recentUpdates = [
    ...artifacts.map((artifact) => ({
      id: `artifact-${artifact.id}`,
      type: t("page.artifactType"),
      title: artifact.title,
      meta: `${artifactsT(`type.${artifact.artifact_type}`, { defaultValue: artifact.artifact_type })} · ${artifactsT(`status.${artifact.status}`, { defaultValue: artifact.status })}`,
      at: artifact.updated_at,
      to: artifactPath(artifact.id)
    })),
    ...papers.map((paper) => ({
      id: `paper-${paper.id}`,
      type: t("page.paperType"),
      title: paper.title,
      meta: `${paper.arxiv_id || paper.venue || paper.canonical_key || "paper"} · ${papersT(`library.status.${paper.library_status}`, { defaultValue: paper.library_status })}`,
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
      setStatusMessage(data.message || t("run.completed"));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  function resumeDailyRun() {
    runDailyCommand("/api/jobs/resume-daily", {}, t("run.resuming"));
  }

  function runDailyNow() {
    const ok = window.confirm(t("run.confirmRerun"));
    if (!ok) return;
    runDailyCommand("/api/jobs/run-now", { force: true }, t("run.rerunningToday"));
  }

  function rerunDaily() {
    runDailyCommand("/api/jobs/run-now", {}, t("run.rerunning"));
  }

  function openUpdateDialog(kind, item) {
    setUpdateDialog({ kind, item });
  }

  async function copyUpdateCommand(command, label) {
    try {
      await copyText(command, t);
      const message = t("update.copied", { label });
      setStatusMessage(message);
      notify(message, { type: "success" });
    } catch (error) {
      const message = error.message || t("update.copyFailed");
      setStatusMessage(message);
      notify(message, { type: "error" });
    }
  }

  return (
    <section className="view vision-dashboard">
      <header className="vision-topbar">
        <div className="vision-brand">
          <span>{t("page.eyebrow")}</span>
          <h1>{t("page.title")}</h1>
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
            <span>{t("page.today")}</span>
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
            ) : dailyReportNotification ? (
              <DailyReportReadyCard item={dailyReportNotification} />
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
              <span>{t("page.actions")}</span>
              <h2 id="vision-actions-title">{t("page.next")}</h2>
            </header>
            <nav className="vision-action-list" aria-label={t("page.shortcutsAria")}>
              <Link to="/papers/inbox">
                <span><strong>{t("page.inbox")}</strong><small>{t("page.inboxHint")}</small></span>
                <b aria-hidden="true">→</b>
              </Link>
              <Link to="/papers/reports">
                <span><strong>{t("page.reports")}</strong><small>{t("page.reportTasks", { count: formatMetricCount(reportCount, i18n.resolvedLanguage) })}</small></span>
                <b aria-hidden="true">→</b>
              </Link>
              <Link to="/artifacts">
                <span><strong>{t("page.artifacts")}</strong><small>{t("page.artifactsHint")}</small></span>
                <b aria-hidden="true">→</b>
              </Link>
              <Link to="/settings">
                <span><strong>{t("page.settings")}</strong><small>{t("page.settingsHint")}</small></span>
                <b aria-hidden="true">→</b>
              </Link>
            </nav>
          </div>
        </aside>

        <section className="vision-stats" aria-label={t("page.scaleAria")}>
          <VisionMetric label={t("page.projects")} value={counts.projects} hint={t("page.projectsHint")} tone="violet" to="/projects" />
          <VisionMetric label={t("page.library")} value={counts.papers} hint={t("page.libraryHint")} tone="blue" to="/papers/library" />
          <VisionMetric label={t("page.reports")} value={reportCount} hint={t("page.reportsHint")} tone="coral" to="/papers/reports" />
          <VisionMetric label={t("page.context")} value={counts.knowledge_documents || counts.notes} hint={t("page.contextHint")} tone="gold" to="/artifacts" />
        </section>

        <section className="vision-attention-card" aria-labelledby="vision-attention-title">
          <header className="vision-card-heading">
            <div>
              <span>{t("page.statusCenter")}</span>
              <h2 id="vision-attention-title">{t("page.attention")}</h2>
            </div>
            <em>{loading ? t("page.syncing") : listNotifications.length ? t("page.items", { count: listNotifications.length }) : t("page.allClear")}</em>
          </header>
          {loading ? (
            <DashboardFeedSkeleton rows={3} title={t("page.loadingNotifications")} />
          ) : (
            <div className="vision-feed-list">
              {listNotifications.map((item) => (
                item.type === "app_update_available" ? (
                  <UpdateNotificationCard item={item} key={item.id} onOpen={openUpdateDialog} />
                ) : (
                  (() => {
                    const message = formatNotification(item, systemT);
                    return <article className={`vision-feed-item ${item.severity || ""}`} key={item.id}>
                      <strong>{message.title}</strong>
                      <p>{message.detail}{item.created_at ? ` · ${fmtDate(item.created_at, i18n.resolvedLanguage)}` : ""}</p>
                    </article>;
                  })()
                )
              ))}
              {!listNotifications.length ? <p className="vision-empty">{t("page.noNotifications")}</p> : null}
            </div>
          )}
        </section>

        <section className="vision-recent-card" aria-labelledby="vision-recent-title">
          <div className="vision-recent-cover">
            <div className="vision-recent-art" aria-hidden="true" />
            <header className="vision-card-heading">
              <div>
                <span>{t("page.flow")}</span>
                <h2 id="vision-recent-title">{t("page.recent")}</h2>
              </div>
            </header>
          </div>
          {loading ? (
            <DashboardFeedSkeleton recent rows={4} title={t("page.loadingRecent")} />
          ) : (
            <div className="vision-feed-list vision-recent-list">
              {recentUpdates.length ? recentUpdates.map((item) => (
                <Link className="vision-feed-item vision-recent-item" key={item.id} to={item.to}>
                  <span className="vision-item-type">{item.type}</span>
                  <strong>{item.title}</strong>
                  <p>{item.meta} · {fmtDate(item.at, i18n.resolvedLanguage)}</p>
                </Link>
              )) : <p className="vision-empty">{t("page.noRecent")}</p>}
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
