import { PanelTitle } from "./PanelTitle.jsx";

export function ProjectsView() {
  return (
    <section id="projectsView" className="view project-view">
      <header className="project-dashboard-header">
        <div>
          <h1>项目中心</h1>
          <p id="projectMeta">Loading projects...</p>
        </div>
        <button id="newProjectButton" className="primary" type="button">
          新建项目
        </button>
      </header>

      <div className="project-dashboard-grid">
        <section className="project-stats-panel" aria-label="项目统计">
          <PanelTitle title="运行概览" subtitle="项目、论文、笔记和产物规模" />
          <div className="project-stats" id="projectStats" />
        </section>

        <section className="project-reminders-panel" aria-label="项目提醒">
          <PanelTitle title="提醒" subtitle="最近任务、论文和实验事件" />
          <div className="project-reminders" id="projectReminders" />
        </section>

        <section className="project-list-panel" aria-label="项目列表">
          <PanelTitle title="项目列表" subtitle="按最近更新时间排序" />
          <div className="project-board" id="projectBoard" />
        </section>

        <section className="project-detail-panel" aria-label="项目详情">
          <div id="projectDetail" className="empty-detail">
            <h2>选择或新建一个项目</h2>
            <p>Obsidian 位置、自动化配置、关联论文和生成产物会显示在这里。</p>
          </div>
        </section>
      </div>
    </section>
  );
}
