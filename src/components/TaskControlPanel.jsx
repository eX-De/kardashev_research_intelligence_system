export function TaskControlPanel() {
  return (
    <section className="panel task-control-panel">
      <div className="panel-title">
        <h2>任务控制</h2>
        <p id="schedulerSummary">run-daily 会先同步 Obsidian，再抓取和整理论文。</p>
      </div>
      <div className="task-mode-grid">
        <button id="startStartupDailyButton" className="mode-card" data-run-mode="startup" type="button">
          <span>启动触发</span>
          <strong>每日首次启动执行</strong>
          <p>每天第一次打开 dashboard 自动执行一次完整流程。</p>
        </button>
        <button id="startSchedulerButton" className="mode-card" data-run-mode="scheduler" type="button">
          <span>定时触发</span>
          <strong>按时间定时执行</strong>
          <p>保持 dashboard 进程运行，到点自动执行每日流程。</p>
        </button>
        <button id="stopSchedulerButton" className="mode-card" data-run-mode="off" type="button">
          <span>关闭</span>
          <strong>关闭自动执行</strong>
          <p>不自动运行，只保留手动执行入口。</p>
        </button>
      </div>
      <div className="task-action-panel">
        <button id="runNowButton" className="primary run-now-button" type="button">
          立即执行每日流程
        </button>
        <div className="task-shortcuts">
          <button data-job="sync-obsidian" type="button">
            Sync Obsidian
          </button>
          <button data-job="fetch-arxiv" type="button">
            Fetch arXiv
          </button>
                  <button data-job="cache-arxiv-text" type="button">
                    Cache PDF/TXT
                  </button>
                  <button data-job="generate-reports" type="button">
                    Generate Reports
                  </button>
                </div>
              </div>
    </section>
  );
}
