import { PanelTitle } from "./PanelTitle.jsx";
import { SettingsForm } from "./SettingsForm.jsx";
import { TaskControlPanel } from "./TaskControlPanel.jsx";

export function ControlView() {
  return (
    <section id="controlView" className="view control-view is-hidden">
      <header className="control-header">
        <div>
          <h1>配置与任务</h1>
          <p>Dashboard 启动后，定时任务由本地 Node 进程调度。</p>
        </div>
        <button id="refreshControlButton" type="button">
          刷新状态
        </button>
      </header>

      <div className="control-grid">
        <TaskControlPanel />
        <section className="panel">
          <PanelTitle title="健康状态" subtitle="数据库、Obsidian、LLM provider 和索引规模。" />
          <div className="health-grid" id="healthGrid" />
        </section>
      </div>

      <section className="panel">
        <PanelTitle title="系统配置" subtitle="保存后立即影响下一次手动或定时任务。" />
        <SettingsForm />
      </section>

      <section className="panel">
        <PanelTitle title="任务历史" subtitle="最近 20 次 worker 执行记录。" />
        <div className="history-table" id="historyTable" />
      </section>
    </section>
  );
}
