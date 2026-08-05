const DAILY_JOB_TYPES = new Set(["run-daily", "resume-daily", "retry-daily"]);

export function fallbackHistoryFromSummary(summary = {}) {
  const latestJob = summary?.latest_job;
  if (!latestJob) return [];
  const meta = latestJob.meta && typeof latestJob.meta === "object" && !Array.isArray(latestJob.meta)
    ? latestJob.meta
    : {};
  return [{ ...latestJob, meta }];
}

export function dailyRecoveryFromHistory(history = []) {
  for (const item of history) {
    if (!DAILY_JOB_TYPES.has(item?.job_type)) continue;
    if (item.status === "completed") return null;
    if (item.status !== "failed") continue;
    const progress = item.meta?.daily_progress && typeof item.meta.daily_progress === "object"
      ? item.meta.daily_progress
      : null;
    if (!progress) continue;
    const steps = Array.isArray(progress.steps) ? progress.steps : [];
    const failedStep = steps.find((step) => step?.status === "failed") || {};
    return {
      job_id: item.job_run_id || item.id,
      failed_step: failedStep.key || progress.current_key || "",
      failed_label: failedStep.label || progress.current_label || "",
      completed: Number(progress.completed || steps.filter((step) => step?.status === "completed").length || 0),
      total: Number(progress.total || steps.length || 0)
    };
  }
  return null;
}
