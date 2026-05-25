import { fmtDate } from "../lib/dashboard.js";

export function DailyRunProgressCard({ item }) {
  const progress = item?.progress || {};
  const steps = progress.steps || [];
  const total = Number(progress.total || steps.length || 1);
  const completed = Number(progress.completed || steps.filter((step) => step.status === "completed").length);
  const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  const current = progress.current_label || steps.find((step) => step.status === "running")?.label || "准备中";
  const cacheProgress = progress.cache_text_progress || null;
  const cacheTotal = Number(cacheProgress?.total || 0);
  const cacheCurrent = Number(cacheProgress?.current || 0);
  const cachePercent = cacheTotal ? Math.max(0, Math.min(100, Math.round((cacheCurrent / cacheTotal) * 100))) : 0;
  const startedAt = item?.source?.started_at || item?.created_at;

  return (
    <article className="notification info daily-progress-card">
      <div className="daily-progress-head">
        <strong>{item?.title || "每日流程运行中"}</strong>
        <span>{completed}/{total}</span>
      </div>
      <p>{current}{startedAt ? ` · started ${fmtDate(startedAt)}` : ""}</p>
      <div className="daily-progress-bar" aria-label="每日流程进度">
        <span style={{ width: `${percent}%` }} />
      </div>
      {cacheProgress && progress.current_key === "cache_text" ? (
        <div className="cache-progress-box">
          <div className="daily-progress-head">
            <strong>PDF/TXT 缓存进度</strong>
            <span>{cacheCurrent}/{cacheTotal}</span>
          </div>
          <div className="daily-progress-bar" aria-label="PDF/TXT 缓存进度">
            <span style={{ width: `${cachePercent}%` }} />
          </div>
          <p className="daily-progress-summary">
            PDF 已缓存 {cacheProgress.pdfs_downloaded || 0} 个 · TXT 已提取 {cacheProgress.texts_extracted || 0} 篇 · 失败 {cacheProgress.texts_failed || 0} 篇
            {cacheProgress.current_arxiv_id ? ` · 当前 ${cacheProgress.current_arxiv_id}` : ""}
          </p>
        </div>
      ) : null}
      <div className="daily-progress-steps">
        {steps.map((step) => <span className={`daily-step ${step.status || "pending"}`} key={step.key || step.label}>{step.label}</span>)}
      </div>
      {steps.some((step) => step.summary) ? (
        <p className="daily-progress-summary">
          {steps.filter((step) => step.summary).map((step) => `${step.label}: ${step.summary}`).join(" · ")}
        </p>
      ) : null}
    </article>
  );
}
