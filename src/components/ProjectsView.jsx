import { useCallback, useEffect, useMemo, useState } from "react";

import { PanelTitle } from "./PanelTitle.jsx";
import { api, fmtDate, jobTitle, metaNumber, statusLabel } from "../lib/dashboard.js";

function sumProject(projects, field) {
  return projects.reduce((total, project) => total + Number(project[field] || 0), 0);
}

function Reminder({ state, title, detail }) {
  return (
    <article className={`reminder ${state}`}>
      <strong>{title}</strong>
      <p>{detail}</p>
    </article>
  );
}

function DailyProgressReminder({ job, progress }) {
  const steps = progress.steps || [];
  const total = Number(progress.total || steps.length || 1);
  const completed = Number(progress.completed || steps.filter((step) => step.status === "completed").length);
  const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  const current = progress.current_label || steps.find((step) => step.status === "running")?.label || "准备中";
  const cacheProgress = progress.cache_text_progress || null;
  const cacheTotal = Number(cacheProgress?.total || 0);
  const cacheCurrent = Number(cacheProgress?.current || 0);
  const cachePercent = cacheTotal ? Math.max(0, Math.min(100, Math.round((cacheCurrent / cacheTotal) * 100))) : 0;

  return (
    <article className="reminder info daily-progress-card">
      <div className="daily-progress-head">
        <strong>每日流程运行中</strong>
        <span>{completed}/{total}</span>
      </div>
      <p>{current} · started {fmtDate(job.started_at)}</p>
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

function ProjectReminders({ activities, scheduler }) {
  const reminders = [];
  const running = scheduler?.current_job;
  const runningDaily = activities.find((item) => item.job_type === "run-daily" && item.status === "running");
  const dailyProgress = runningDaily?.meta?.daily_progress;
  if (dailyProgress) {
    reminders.push(<DailyProgressReminder job={runningDaily} progress={dailyProgress} key="daily" />);
  } else if (running) {
    reminders.push(<Reminder state="info" title="任务运行中" detail={`${jobTitle(running.command)} · started ${fmtDate(running.started_at)}`} key="running" />);
  }

  const failed = activities.find((item) => item.status === "failed");
  if (failed) reminders.push(<Reminder state="bad" title="任务失败" detail={`${jobTitle(failed.job_type)} · ${failed.message || fmtDate(failed.finished_at)}`} key="failed" />);

  const completed = (predicate) => activities.find((item) => item.status === "completed" && predicate(item.meta || {}, item));
  const completedDaily = completed((meta, item) => item.job_type === "run-daily");
  if (completedDaily) {
    const meta = completedDaily.meta || {};
    const parts = [];
    const newPapers = metaNumber(meta, ["arxiv_papers_inserted", "papers_inserted"]);
    const projectMatches = metaNumber(meta, ["project_paper_matches_created", "daily_report_project_matches"]);
    const archived = metaNumber(meta, ["zero_match_papers_archived"]);
    const filtered = metaNumber(meta, ["project_judgments_filtered"]);
    if (newPapers) parts.push(`${newPapers} 篇新论文`);
    if (projectMatches) parts.push(`${projectMatches} 条项目候选`);
    if (archived) parts.push(`${archived} 篇 0 命中归档`);
    if (filtered) parts.push(`${filtered} 条项目判定筛掉`);
    if (meta.daily_report_path) parts.push(`日报 ${meta.daily_report_path}`);
    reminders.push(
      <Reminder
        state="ok"
        title="每日流程已完成"
        detail={`${parts.length ? parts.join("，") : completedDaily.message || "流程已完成"} · ${fmtDate(completedDaily.finished_at)}`}
        key="daily-completed"
      />
    );
  }

  const paperJob = completed((meta) => metaNumber(meta, ["arxiv_papers_inserted", "papers_inserted"]) > 0);
  if (paperJob) {
    reminders.push(<Reminder state="info" title="新论文到了" detail={`${metaNumber(paperJob.meta, ["arxiv_papers_inserted", "papers_inserted"])} 篇新 arXiv 论文已入库 · ${fmtDate(paperJob.finished_at)}`} key="papers" />);
  }

  const syncJob = completed((meta, item) => metaNumber(meta, ["sync_indexed", "indexed"]) > 0 || item.job_type === "sync-obsidian");
  if (syncJob) {
    const indexed = metaNumber(syncJob.meta, ["sync_indexed", "indexed"]);
    const chunks = metaNumber(syncJob.meta, ["sync_chunks_created", "chunks_created"]);
    reminders.push(<Reminder state="ok" title="Obsidian 已同步" detail={indexed ? `${indexed} 篇笔记更新，${chunks} 个 chunk 入库 · ${fmtDate(syncJob.finished_at)}` : `Obsidian 同步完成 · ${fmtDate(syncJob.finished_at)}`} key="sync" />);
  }

  const textJob = completed((meta) => metaNumber(meta, ["text_pdfs_downloaded", "pdfs_downloaded", "text_texts_extracted", "texts_extracted"]) > 0);
  if (textJob) {
    const parts = [];
    const pdfCount = metaNumber(textJob.meta, ["text_pdfs_downloaded", "pdfs_downloaded"]);
    const textCount = metaNumber(textJob.meta, ["text_texts_extracted", "texts_extracted"]);
    const failedCount = metaNumber(textJob.meta, ["text_texts_failed", "texts_failed"]);
    if (pdfCount) parts.push(`${pdfCount} 个 PDF 已缓存`);
    if (textCount) parts.push(`${textCount} 篇已转 TXT`);
    if (failedCount) parts.push(`${failedCount} 篇失败`);
    reminders.push(<Reminder state="ok" title="论文正文已缓存" detail={`${parts.join("，")} · ${fmtDate(textJob.finished_at)}`} key="text" />);
  }

  const rankJob = completed((meta) => metaNumber(meta, ["matched_papers"]) > 0 || metaNumber(meta, ["project_paper_matches_created"]) > 0);
  if (rankJob) reminders.push(<Reminder state="info" title="论文匹配完成" detail={`${metaNumber(rankJob.meta, ["matched_papers", "project_paper_matches_created"])} 条匹配结果 · ${fmtDate(rankJob.finished_at)}`} key="rank" />);

  if (!reminders.length) reminders.push(<Reminder state="neutral" title="暂无新提醒" detail="没有新的任务完成、论文到达或实验同步事件。" key="empty" />);
  return <div className="project-reminders">{reminders.slice(0, 5)}</div>;
}

export function ProjectsView({ onOpenProject, onNewProject, setStatusMessage }) {
  const [projects, setProjects] = useState([]);
  const [activities, setActivities] = useState([]);
  const [scheduler, setScheduler] = useState({});

  const loadProjects = useCallback(async () => {
    const [data, history, status] = await Promise.all([
      api("/api/projects"),
      api("/api/jobs/history?limit=12"),
      api("/api/jobs/status")
    ]);
    setProjects(data.items || []);
    setActivities(history.items || []);
    setScheduler(status.scheduler || {});
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
      ["项目", projects.length, `${activeCount} active`],
      ["论文", sumProject(projects, "paper_count"), "linked"],
      ["笔记", sumProject(projects, "note_count"), "Obsidian"],
      ["生成产物", sumProject(projects, "artifact_count"), "synced"]
    ];
  }, [projects]);

  return (
    <section className="view project-view">
      <header className="project-dashboard-header">
        <div>
          <h1>项目中心</h1>
          <p>{projects.length} projects</p>
        </div>
        <button className="primary" onClick={onNewProject} type="button">
          新建项目
        </button>
      </header>

      <div className="project-center-grid">
        <section className="project-stats-panel" aria-label="项目统计">
          <PanelTitle title="运行概览" subtitle="只保留项目中心需要的全局规模。" />
          <div className="project-stats">
            {stats.map(([label, value, hint]) => (
              <div className="project-stat-card" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <p>{hint}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="project-reminders-panel" aria-label="项目提醒">
          <PanelTitle title="提醒" subtitle="全局任务、论文缓存和同步状态。" />
          <ProjectReminders activities={activities} scheduler={scheduler} />
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
