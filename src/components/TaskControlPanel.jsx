import { fmtDate } from "../lib/dashboard.js";

function schedulerMode(scheduler) {
  if (scheduler?.enabled) return "scheduler";
  if (scheduler?.startup_daily?.enabled) return "startup";
  return "off";
}

function schedulerSummary(scheduler) {
  if (scheduler?.enabled) return `定时执行 · 下次执行 ${fmtDate(scheduler.next_run_at)}`;
  if (scheduler?.startup_daily?.enabled) {
    return scheduler.startup_daily.last_skip_reason === "already_completed_today"
      ? "访问触发 · 今日已完成"
      : "访问触发 · 每日首次打开页面时运行";
  }
  return "未启用";
}

export function TaskControlPanel({ scheduler, recovery = null, onStartStartup, onStartScheduler, onStopScheduler, onRunNow, onResumeDaily, onRetryDaily, onRunJob }) {
  const activeMode = schedulerMode(scheduler);
  const hasRecovery = Boolean(recovery);
  const recoveryCount = recovery?.total ? `${recovery.completed || 0}/${recovery.total}` : `${recovery?.completed || 0} 步`;

  return (
    <section className="panel task-control-panel">
      <div className="panel-title">
        <h2>任务控制</h2>
        <p>{schedulerSummary(scheduler)}</p>
      </div>
      <div className="task-mode-grid">
        <button className={`mode-card ${activeMode === "startup" ? "active" : ""}`} onClick={onStartStartup} type="button">
          <span>访问触发</span>
          <strong>每日首次访问执行</strong>
          <p>每天第一次打开 dashboard 页面自动执行一次完整流程。</p>
        </button>
        <button className={`mode-card ${activeMode === "scheduler" ? "active" : ""}`} onClick={onStartScheduler} type="button">
          <span>定时触发</span>
          <strong>按时间定时执行</strong>
          <p>保持 dashboard 进程运行，到点自动执行每日流程。</p>
        </button>
        <button className={`mode-card ${activeMode === "off" ? "active" : ""}`} onClick={onStopScheduler} type="button">
          <span>关闭</span>
          <strong>关闭自动执行</strong>
          <p>不自动运行，只保留手动执行入口。</p>
        </button>
      </div>
      {hasRecovery ? (
        <div className="task-recovery-banner">
          <strong>上次每日流程可继续</strong>
          <p>失败在：{recovery.failed_label || "未知阶段"}，已完成 {recoveryCount}。</p>
        </div>
      ) : null}
      <div className="task-action-panel">
        <button className="primary run-now-button" onClick={hasRecovery ? onResumeDaily : onRunNow} type="button">
          {hasRecovery ? "继续上次每日流程" : "立即执行每日流程"}
        </button>
        <button disabled={!hasRecovery} onClick={hasRecovery ? onRunNow : onResumeDaily} type="button">
          {hasRecovery ? "重新执行今日流程" : "恢复上次每日流程"}
        </button>
        <button onClick={onRetryDaily} type="button">
          补跑历史论文
        </button>
        <div className="task-shortcuts">
          <button onClick={() => onRunJob("sync-obsidian")} type="button">
            Sync Obsidian
          </button>
          <button onClick={() => onRunJob("fetch-arxiv")} type="button">
            Fetch arXiv
          </button>
          <button onClick={() => onRunJob("cache-arxiv-text")} type="button">
            Cache PDF/TXT
          </button>
          <button onClick={() => onRunJob("generate-paper-reports")} type="button">
            Full Paper Reports
          </button>
          <button onClick={() => onRunJob("generate-reports")} type="button">
            Generate Daily Report
          </button>
        </div>
      </div>
    </section>
  );
}
