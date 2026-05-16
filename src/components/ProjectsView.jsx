import { useCallback, useEffect, useMemo, useState } from "react";

import { PanelTitle } from "./PanelTitle.jsx";
import { api, fmtDate, statusLabel } from "../lib/dashboard.js";

function sumProject(projects, field) {
  return projects.reduce((total, project) => total + Number(project[field] || 0), 0);
}

function Reminder({ item }) {
  return (
    <article className={`reminder ${item.severity || "neutral"}`}>
      <strong>{item.title}</strong>
      <p>
        {item.detail}
        {item.created_at ? ` · ${fmtDate(item.created_at)}` : ""}
      </p>
    </article>
  );
}

function DailyProgressReminder({ item }) {
  const progress = item.progress || {};
  const steps = progress.steps || [];
  const total = Number(progress.total || steps.length || 1);
  const completed = Number(progress.completed || steps.filter((step) => step.status === "completed").length);
  const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  const current = progress.current_label || steps.find((step) => step.status === "running")?.label || "准备中";
  const cacheProgress = progress.cache_text_progress || null;
  const cacheTotal = Number(cacheProgress?.total || 0);
  const cacheCurrent = Number(cacheProgress?.current || 0);
  const cachePercent = cacheTotal ? Math.max(0, Math.min(100, Math.round((cacheCurrent / cacheTotal) * 100))) : 0;
  const startedAt = item.source?.started_at || item.created_at;

  return (
    <article className="reminder info daily-progress-card">
      <div className="daily-progress-head">
        <strong>{item.title || "每日流程运行中"}</strong>
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

function ProjectReminders({ reminders }) {
  const items = reminders.length ? reminders : [
    {
      id: "empty",
      severity: "neutral",
      title: "暂无新提醒",
      detail: "没有新的任务完成、论文到达或实验同步事件。"
    }
  ];
  return (
    <div className="project-reminders">
      {items.slice(0, 5).map((item) => (
        item.progress
          ? <DailyProgressReminder item={item} key={item.id} />
          : <Reminder item={item} key={item.id} />
      ))}
    </div>
  );
}

export function ProjectsView({ onOpenProject, onNewProject, setStatusMessage }) {
  const [projects, setProjects] = useState([]);
  const [reminders, setReminders] = useState([]);

  const loadProjects = useCallback(async () => {
    const [data, reminderData] = await Promise.all([
      api("/api/projects"),
      api("/api/reminders?limit=5")
    ]);
    setProjects(data.items || []);
    setReminders(reminderData.items || []);
  }, []);

  useEffect(() => {
    loadProjects().catch((error) => setStatusMessage(error.message));
    const timer = setInterval(() => {
      loadProjects().catch((error) => setStatusMessage(error.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [loadProjects, setStatusMessage]);

  const stats = useMemo(() => {
    const activeCount = projects.filter((project) => ["active", "exploring", "writing"].includes(project.status)).length;
    return [
      ["项目", projects.length, `${activeCount} 个活跃`],
      ["论文", sumProject(projects, "paper_count"), "已关联"],
      ["笔记", sumProject(projects, "note_count"), "Obsidian"],
      ["生成产物", sumProject(projects, "artifact_count"), "已同步"]
    ];
  }, [projects]);

  return (
    <section className="view project-view">
      <header className="project-dashboard-header">
        <div>
          <h1>项目中心</h1>
          <p>{projects.length} 个项目正在跟踪</p>
        </div>
        <button className="primary" onClick={onNewProject} type="button">
          新建项目
        </button>
      </header>

      <div className="project-center-grid">
        <section className="project-stats-panel" aria-label="项目统计">
          <PanelTitle title="运行概览" subtitle="只保留项目中心需要的全局规模。" />
          <div className="project-stats">
            {stats.map(([label, value, hint], index) => (
              <div className={`project-stat-card project-stat-${index}`} key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <p>{hint}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="project-reminders-panel" aria-label="项目提醒">
          <PanelTitle title="提醒" subtitle="全局任务、论文缓存和同步状态。" />
          <ProjectReminders reminders={reminders} />
        </section>

        <section className="project-list-panel" aria-label="项目列表">
          <PanelTitle title="项目列表" subtitle="打开项目页查看项目特定配置、候选论文和关联信息。" />
          <div className="project-board">
            {!projects.length ? <div className="project-empty">暂无项目。同步 Obsidian 或手动新建一个项目。</div> : (
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
                      <p>{project.obsidian_folder || project.obsidian_project_path || project.obsidian_output_dir || "未配置 Obsidian 输出"}</p>
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
        </section>
      </div>
    </section>
  );
}
