import { useTranslation } from "react-i18next";

import { fmtDate } from "../lib/dashboard.js";
import { dailyStepLabel } from "../lib/systemMessages.js";
import "../styles/TaskControlPanel.css";

function schedulerMode(scheduler) {
  if (scheduler?.enabled) return "scheduler";
  if (scheduler?.startup_daily?.enabled) return "startup";
  return "off";
}

function schedulerSummary(scheduler, locale, t) {
  if (scheduler?.enabled) return t("taskControl.scheduler.nextRun", { value: fmtDate(scheduler.next_run_at, locale) });
  if (scheduler?.startup_daily?.enabled) {
    return scheduler.startup_daily.last_skip_reason === "already_completed_today"
      ? t("taskControl.scheduler.completedToday")
      : t("taskControl.scheduler.firstVisit");
  }
  return t("taskControl.scheduler.disabled");
}

export function TaskControlPanel({ scheduler, recovery = null, onStartStartup, onStartScheduler, onStopScheduler, onRunNow, onResumeDaily, onRetryDaily, onRunJob }) {
  const { i18n, t } = useTranslation(["settings", "system"]);
  const activeMode = schedulerMode(scheduler);
  const hasRecovery = Boolean(recovery);
  const recoveryCount = recovery?.total
    ? `${recovery.completed || 0}/${recovery.total}`
    : t("taskControl.recovery.steps", { count: recovery?.completed || 0 });
  const failedStep = dailyStepLabel(recovery?.failed_step, recovery?.failed_label, t);

  return (
    <section className="panel task-control-panel">
      <div className="panel-title">
        <span className="task-control-eyebrow">{t("daily.eyebrow")}</span>
        <h2>{t("taskControl.title")}</h2>
        <p>{schedulerSummary(scheduler, i18n.resolvedLanguage || i18n.language, t)}</p>
      </div>
      <div className="task-mode-grid">
        <button aria-pressed={activeMode === "startup"} className={`mode-card ${activeMode === "startup" ? "active" : ""}`} onClick={onStartStartup} type="button">
          <span>{t("taskControl.modes.startup.label")}</span>
          <strong>{t("taskControl.modes.startup.title")}</strong>
          <p>{t("taskControl.modes.startup.description")}</p>
        </button>
        <button aria-pressed={activeMode === "scheduler"} className={`mode-card ${activeMode === "scheduler" ? "active" : ""}`} onClick={onStartScheduler} type="button">
          <span>{t("taskControl.modes.scheduler.label")}</span>
          <strong>{t("taskControl.modes.scheduler.title")}</strong>
          <p>{t("taskControl.modes.scheduler.description")}</p>
        </button>
        <button aria-pressed={activeMode === "off"} className={`mode-card ${activeMode === "off" ? "active" : ""}`} onClick={onStopScheduler} type="button">
          <span>{t("taskControl.modes.off.label")}</span>
          <strong>{t("taskControl.modes.off.title")}</strong>
          <p>{t("taskControl.modes.off.description")}</p>
        </button>
      </div>
      {hasRecovery ? (
        <div className="task-recovery-banner">
          <strong>{t("taskControl.recovery.title")}</strong>
          <p>{t("taskControl.recovery.detail", { count: recoveryCount, failedStep })}</p>
        </div>
      ) : null}
      <div className="task-action-panel">
        <div className="task-primary-actions">
          <button className="primary run-now-button" onClick={hasRecovery ? onResumeDaily : onRunNow} type="button">
            {hasRecovery ? t("taskControl.actions.resume") : t("taskControl.actions.runNow")}
          </button>
          <button disabled={!hasRecovery} onClick={hasRecovery ? onRunNow : onResumeDaily} type="button">
            {hasRecovery ? t("taskControl.actions.rerun") : t("taskControl.actions.resumePrevious")}
          </button>
          <button onClick={onRetryDaily} type="button">
            {t("taskControl.actions.retryHistory")}
          </button>
        </div>
        <div className="task-shortcuts">
          <button onClick={() => onRunJob("sync-obsidian")} type="button">
            {t("taskControl.shortcuts.syncObsidian")}
          </button>
          <button onClick={() => onRunJob("fetch-arxiv")} type="button">
            {t("taskControl.shortcuts.fetchArxiv")}
          </button>
          <button onClick={() => onRunJob("cache-arxiv-text")} type="button">
            {t("taskControl.shortcuts.cacheText")}
          </button>
          <button onClick={() => onRunJob("generate-paper-reports")} type="button">
            {t("taskControl.shortcuts.paperReports")}
          </button>
          <button onClick={() => onRunJob("generate-reports")} type="button">
            {t("taskControl.shortcuts.dailyReport")}
          </button>
        </div>
      </div>
    </section>
  );
}
