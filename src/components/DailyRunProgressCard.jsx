import { useTranslation } from "react-i18next";
import { fmtDate } from "../lib/dashboard.js";
import "../styles/DailyRunProgressCard.css";

export function DailyRunProgressCard({ item }) {
  const { t, i18n } = useTranslation("dashboard");
  const progress = item?.progress || {};
  const steps = progress.steps || [];
  const total = Number(progress.total || steps.length || 1);
  const completed = Number(progress.completed || steps.filter((step) => step.status === "completed").length);
  const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  const runningIndex = steps.findIndex((step) => step.key === progress.current_key || step.status === "running");
  const activeIndex = runningIndex >= 0
    ? runningIndex
    : Math.max(0, Math.min(steps.length - 1, completed));
  const activeStep = steps[activeIndex] || null;
  const stageLabel = (step) => {
    const key = step?.key;
    return key && t(`progress.stages.${key}`, { defaultValue: "" }) || step?.label || t("progress.preparing");
  };
  const current = progress.current_key
    ? t(`progress.stages.${progress.current_key}`, { defaultValue: progress.current_label || stageLabel(activeStep) })
    : progress.current_label || stageLabel(activeStep);
  const currentKey = progress.current_key || activeStep?.key || current;
  const stageTotal = Math.max(total, steps.length, 1);
  const stageNumber = steps.length ? activeIndex + 1 : Math.min(stageTotal, completed + 1);
  const cacheProgress = progress.cache_text_progress || null;
  const cacheTotal = Number(cacheProgress?.total || 0);
  const cacheCurrent = Number(cacheProgress?.current || 0);
  const cachePercent = cacheTotal ? Math.max(0, Math.min(100, Math.round((cacheCurrent / cacheTotal) * 100))) : 0;
  const judgmentProgress = progress.project_judgment_progress || null;
  const judgmentTotal = Number(judgmentProgress?.total || 0);
  const judgmentCompleted = Number(judgmentProgress?.completed || 0);
  const judgmentPercent = judgmentTotal ? Math.max(0, Math.min(100, Math.round((judgmentCompleted / judgmentTotal) * 100))) : 0;
  const startedAt = item?.source?.started_at || item?.created_at;
  const latestSummaryStep = [...steps].reverse().find((step) => step.summary);

  const statusLabel = (status) => {
    if (status === "completed") return t("progress.completed");
    if (status === "running") return t("progress.running");
    if (status === "failed") return t("progress.failed");
    return t("progress.pending");
  };

  return (
    <article className="vision-progress">
      <div className="vision-progress-stage" key={currentKey} aria-live="polite">
        <div className="vision-progress-stage-copy">
          <span className="vision-progress-kicker">{t("progress.stage")} {String(stageNumber).padStart(2, "0")} / {String(stageTotal).padStart(2, "0")}</span>
          <strong>{current}</strong>
          <p>{t("progress.completedSummary", { count: completed })}{startedAt ? ` · ${t("progress.startedAt", { date: fmtDate(startedAt, i18n.resolvedLanguage) })}` : ""}</p>
        </div>
        <div className="vision-progress-value" aria-hidden="true">
          <strong>{percent}</strong><span>%</span>
        </div>
      </div>

      <div
        className="vision-progress-bar"
        role="progressbar"
        aria-label={t("progress.aria")}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      {steps.length ? (
        <div
          className="vision-stage-track"
          style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
          role="list"
          aria-label={t("progress.stagesAria")}
        >
          {steps.map((step) => (
            <span
              className={`vision-stage-segment ${step.status || "pending"}`}
              key={step.key || step.label}
              role="listitem"
              aria-label={t("progress.stageAria", { stage: stageLabel(step), status: statusLabel(step.status) })}
              aria-current={step.status === "running" ? "step" : undefined}
              title={`${stageLabel(step)} · ${statusLabel(step.status)}`}
            />
          ))}
        </div>
      ) : null}

      {cacheProgress && progress.current_key === "cache_text" ? (
        <div className="vision-cache-progress">
          <div className="vision-cache-copy">
            <span>{t("progress.cache")}</span>
            <strong>{cacheCurrent}<small> / {cacheTotal}</small></strong>
          </div>
          <div className="vision-cache-meter">
            <div className="vision-progress-bar" role="progressbar" aria-label={t("progress.cacheAria")} aria-valuemin="0" aria-valuemax="100" aria-valuenow={cachePercent}>
              <span style={{ width: `${cachePercent}%` }} />
            </div>
            <p>{t("progress.cacheStats", { pdf: cacheProgress.pdfs_downloaded || 0, txt: cacheProgress.texts_extracted || 0, failed: cacheProgress.texts_failed || 0 })}</p>
          </div>
          {cacheProgress.current_arxiv_id ? <span className="vision-cache-current">{cacheProgress.current_arxiv_id}</span> : null}
        </div>
      ) : null}

      {judgmentProgress && progress.current_key === "judge_project_papers" ? (
        <div className="vision-cache-progress">
          <div className="vision-cache-copy">
            <span>{t("progress.judgment")}</span>
            <strong>{judgmentCompleted}<small> / {judgmentTotal}</small></strong>
          </div>
          <div className="vision-cache-meter">
            <div className="vision-progress-bar" role="progressbar" aria-label={t("progress.judgmentAria")} aria-valuemin="0" aria-valuemax="100" aria-valuenow={judgmentPercent}>
              <span style={{ width: `${judgmentPercent}%` }} />
            </div>
            <p>{t("progress.judgmentStats", { concurrency: judgmentProgress.concurrency || 0, created: judgmentProgress.created || 0, filtered: judgmentProgress.filtered || 0, skipped: judgmentProgress.skipped || 0 })}</p>
          </div>
        </div>
      ) : null}

      {latestSummaryStep ? (
        <p className="vision-progress-summary">
          <span>{stageLabel(latestSummaryStep)}</span>{latestSummaryStep.summary}
        </p>
      ) : null}
    </article>
  );
}
