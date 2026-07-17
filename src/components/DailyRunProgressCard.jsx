import { fmtDate } from "../lib/dashboard.js";
import "../styles/DailyRunProgressCard.css";

export function DailyRunProgressCard({ item }) {
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
  const current = progress.current_label || activeStep?.label || "准备中";
  const currentKey = progress.current_key || activeStep?.key || current;
  const stageTotal = Math.max(total, steps.length, 1);
  const stageNumber = steps.length ? activeIndex + 1 : Math.min(stageTotal, completed + 1);
  const cacheProgress = progress.cache_text_progress || null;
  const cacheTotal = Number(cacheProgress?.total || 0);
  const cacheCurrent = Number(cacheProgress?.current || 0);
  const cachePercent = cacheTotal ? Math.max(0, Math.min(100, Math.round((cacheCurrent / cacheTotal) * 100))) : 0;
  const startedAt = item?.source?.started_at || item?.created_at;
  const latestSummaryStep = [...steps].reverse().find((step) => step.summary);

  const statusLabel = (status) => {
    if (status === "completed") return "已完成";
    if (status === "running") return "进行中";
    if (status === "failed") return "失败";
    return "等待中";
  };

  return (
    <article className="vision-progress">
      <div className="vision-progress-stage" key={currentKey} aria-live="polite">
        <div className="vision-progress-stage-copy">
          <span className="vision-progress-kicker">STAGE {String(stageNumber).padStart(2, "0")} / {String(stageTotal).padStart(2, "0")}</span>
          <strong>{current}</strong>
          <p>{completed} 个阶段已完成{startedAt ? ` · 开始于 ${fmtDate(startedAt)}` : ""}</p>
        </div>
        <div className="vision-progress-value" aria-hidden="true">
          <strong>{percent}</strong><span>%</span>
        </div>
      </div>

      <div
        className="vision-progress-bar"
        role="progressbar"
        aria-label="每日流程进度"
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
          aria-label="每日流程阶段"
        >
          {steps.map((step) => (
            <span
              className={`vision-stage-segment ${step.status || "pending"}`}
              key={step.key || step.label}
              role="listitem"
              aria-label={`${step.label}：${statusLabel(step.status)}`}
              aria-current={step.status === "running" ? "step" : undefined}
              title={`${step.label} · ${statusLabel(step.status)}`}
            />
          ))}
        </div>
      ) : null}

      {cacheProgress && progress.current_key === "cache_text" ? (
        <div className="vision-cache-progress">
          <div className="vision-cache-copy">
            <span>全文缓存</span>
            <strong>{cacheCurrent}<small> / {cacheTotal}</small></strong>
          </div>
          <div className="vision-cache-meter">
            <div className="vision-progress-bar" role="progressbar" aria-label="PDF/TXT 缓存进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={cachePercent}>
              <span style={{ width: `${cachePercent}%` }} />
            </div>
            <p>PDF {cacheProgress.pdfs_downloaded || 0} · TXT {cacheProgress.texts_extracted || 0} · 失败 {cacheProgress.texts_failed || 0}</p>
          </div>
          {cacheProgress.current_arxiv_id ? <span className="vision-cache-current">{cacheProgress.current_arxiv_id}</span> : null}
        </div>
      ) : null}

      {latestSummaryStep ? (
        <p className="vision-progress-summary">
          <span>{latestSummaryStep.label}</span>{latestSummaryStep.summary}
        </p>
      ) : null}
    </article>
  );
}
