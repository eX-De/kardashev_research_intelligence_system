import { useEffect, useMemo } from "react";

import { LoadingPanel } from "./Loading.jsx";
import { PanelTitle } from "./PanelTitle.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { api, fmtDate, statusLabel } from "../lib/dashboard.js";
import { useCachedApi } from "../lib/apiCache.jsx";

function sumProject(projects, field) {
  return projects.reduce((total, project) => total + Number(project[field] || 0), 0);
}

export function ProjectsView({ onOpenProject, onNewProject, setStatusMessage }) {
  const projectsQuery = useCachedApi(["projects"], () => api("/api/projects"), { staleTime: 60000 });

  useEffect(() => {
    if (projectsQuery.error) setStatusMessage(projectsQuery.error.message);
  }, [projectsQuery.error, setStatusMessage]);

  const projects = projectsQuery.data?.items || [];
  const loading = !projectsQuery.hasData;
  const refreshBusy = projectsQuery.loading || projectsQuery.refreshing;

  async function refresh() {
    try {
      await projectsQuery.refresh({ force: true });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  const stats = useMemo(() => {
    const activeCount = projects.filter((project) => ["active", "exploring", "writing"].includes(project.status)).length;
    return [
      ["项目", projects.length, `${activeCount} 个活跃`],
      ["论文", sumProject(projects, "paper_count"), "已关联"],
      ["上下文", sumProject(projects, "note_count"), "已关联"],
      ["生成产物", sumProject(projects, "artifact_count"), "系统内"]
    ];
  }, [projects]);

  return (
    <section className="view project-view">
      <header className="project-dashboard-header">
        <div>
          <h1>项目中心</h1>
          <p>{loading ? "正在读取项目..." : `${projects.length} 个项目正在跟踪`}</p>
        </div>
        <div className="header-actions">
          <RefreshButton busy={refreshBusy} onClick={refresh} />
          <button className="primary" onClick={onNewProject} type="button">
            新建项目
          </button>
        </div>
      </header>

      <div className="project-center-grid">
        <section className="project-stats-panel" aria-label="项目统计">
          <PanelTitle title="运行概览" subtitle="只保留项目中心需要的全局规模。" />
          {loading ? (
            <LoadingPanel compact rows={4} title="读取项目概览" />
          ) : (
            <div className="project-stats">
              {stats.map(([label, value, hint], index) => (
                <div className={`project-stat-card project-stat-${index}`} key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <p>{hint}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="project-list-panel" aria-label="项目列表">
          <PanelTitle title="项目列表" subtitle="打开项目页查看项目特定配置、候选论文和关联信息。" />
          {loading ? (
            <LoadingPanel compact rows={7} title="读取项目列表" />
          ) : (
            <div className="project-board">
              {!projects.length ? <div className="project-empty">暂无项目。可以手动新建系统内项目；Obsidian 导入是可选入口。</div> : (
                <>
                  <div className="project-table-head">
                    <span>Project</span>
                    <span>Status</span>
                    <span>Papers</span>
                    <span>Notes</span>
                    <span>Outputs</span>
                    <span>Updated</span>
                  </div>
                  {projects.map((project) => (
                    <button className="project-row" key={project.id} onClick={() => onOpenProject(project.id)} type="button">
                      <div className="project-row-main">
                        <strong>{project.name}</strong>
                        <p>{project.obsidian_folder || project.obsidian_project_path || project.obsidian_output_dir || "系统内项目"}</p>
                      </div>
                      <span className={`status-pill status-${project.status}`}><span className="status-dot" />{statusLabel(project.status)}</span>
                      <span className="project-row-metric"><strong>{project.paper_count || 0}</strong><small>papers</small></span>
                      <span className="project-row-metric"><strong>{project.note_count || 0}</strong><small>notes</small></span>
                      <span className="project-row-metric"><strong>{project.artifact_count || 0}</strong><small>outputs</small></span>
                      <span className="project-row-date">{fmtDate(project.updated_at)}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
