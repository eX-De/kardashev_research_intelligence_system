import { useCallback, useEffect, useMemo, useState } from "react";

import { LoadingPanel } from "./Loading.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import { formatMetricCount, VisionMetric } from "./VisionMetric.jsx";
import { api, chooseLocalPath, fmtDate, postJson, PROJECT_STATUSES, statusLabel } from "../lib/dashboard.js";
import { useCachedApi } from "../lib/apiCache.jsx";
import { friendlyObsidianMessage, useObsidianCapability } from "../lib/obsidianCapability.js";
import "../styles/ProjectsView.css";

const ACTIVE_STATUSES = new Set(["active", "exploring", "writing"]);

function emptyProjectForm() {
  return {
    name: "",
    status: "active",
    keywords: "",
    raw_context: "",
    obsidian_project_path: "",
    obsidian_output_dir: ""
  };
}

function sumProject(projects, field) {
  return projects.reduce((total, project) => total + Number(project[field] || 0), 0);
}

function ProjectGlyph() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
      <rect x="3.5" y="4" width="7" height="6" rx="2" />
      <rect x="13.5" y="14" width="7" height="6" rx="2" />
      <path d="M10.5 7h4a3 3 0 0 1 3 3v4M13.5 17h-4a3 3 0 0 1-3-3v-4" />
    </svg>
  );
}

function ProjectCard({ index, project, onOpen }) {
  const projectPath = project.obsidian_folder || project.obsidian_project_path || project.obsidian_output_dir || "系统内项目";
  const metrics = [
    ["论文", project.paper_count],
    ["上下文", project.note_count],
    ["产物", project.artifact_count]
  ];

  return (
    <button className={`project-vision-card project-tone-${project.status || "default"}`} onClick={() => onOpen(project.id)} type="button">
      <header>
        <span className="project-card-index"><small>Research project</small><strong>{String(index + 1).padStart(2, "0")}</strong></span>
        <span className={`project-card-status status-${project.status}`}><i aria-hidden="true" />{statusLabel(project.status)}</span>
      </header>
      <div className="project-card-body">
        <div className="project-card-copy">
          <strong>{project.name}</strong>
          <p title={projectPath}>{projectPath}</p>
        </div>
      </div>
      <div className="project-card-metrics" aria-label="项目规模">
        {metrics.map(([label, value]) => (
          <span key={label}><small>{label}</small><strong>{formatMetricCount(value)}</strong></span>
        ))}
      </div>
      <footer>
        <span>更新于 {fmtDate(project.updated_at)}</span>
        <b>打开项目 <i aria-hidden="true">→</i></b>
      </footer>
    </button>
  );
}

export function ProjectsView({ onOpenProject, setStatusMessage }) {
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectForm, setProjectForm] = useState(emptyProjectForm);
  const [savingProject, setSavingProject] = useState(false);
  const projectsQuery = useCachedApi(["projects"], () => api("/api/projects"), { staleTime: 60000 });
  const handleObsidianError = useCallback((error) => setStatusMessage(friendlyObsidianMessage(error)), [setStatusMessage]);
  const obsidianCapability = useObsidianCapability({ onError: handleObsidianError });

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

  function openNewProjectDialog() {
    setProjectForm(emptyProjectForm());
    setProjectDialogOpen(true);
  }

  function updateProjectForm(field, value) {
    setProjectForm((current) => ({ ...current, [field]: value }));
  }

  async function pickProjectPath(field, mode, title) {
    if (!obsidianCapability.available) {
      setStatusMessage(obsidianCapability.disabledReason);
      return;
    }
    try {
      const data = await chooseLocalPath({ mode, title, relativeTo: "obsidian_vault" });
      if (!data.cancelled) updateProjectForm(field, data.relative_path ?? data.path ?? "");
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error));
    }
  }

  async function createProject(event) {
    event.preventDefault();
    if (!projectForm.name.trim() || savingProject) return;
    setSavingProject(true);
    try {
      const data = await postJson("/api/projects", {
        ...projectForm,
        name: projectForm.name.trim(),
        discovery_source: "manual"
      });
      try {
        await projectsQuery.refresh({ force: true });
      } catch {
        // The project has already been created; the detail route and SSE will refresh shared state.
      }
      setProjectDialogOpen(false);
      setStatusMessage(data.context_job?.queued ? "项目已创建，上下文正在处理" : "项目已创建");
      onOpenProject(data.project.id);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setSavingProject(false);
    }
  }

  const overview = useMemo(() => {
    const active = projects.filter((project) => ACTIVE_STATUSES.has(project.status)).length;
    const paused = projects.filter((project) => project.status === "paused").length;
    return {
      active,
      paused,
      total: projects.length,
      papers: sumProject(projects, "paper_count"),
      notes: sumProject(projects, "note_count"),
      artifacts: sumProject(projects, "artifact_count")
    };
  }, [projects]);

  return (
    <section className="view vision-projects">
      <header className="vision-topbar project-vision-topbar">
        <div className="vision-brand">
          <span>研究组织</span>
          <h1>项目工作台</h1>
        </div>
        <div className="vision-top-actions">
          <span className={`vision-live-state ${overview.active ? "running" : "ready"}`}><i aria-hidden="true" />{loading ? "正在同步" : `${overview.active} 个活跃项目`}</span>
          <RefreshButton busy={refreshBusy} className="vision-refresh" onClick={refresh} />
          <button className="project-new-button workspace-primary-action" onClick={openNewProjectDialog} type="button"><span aria-hidden="true">＋</span>新建项目</button>
        </div>
      </header>

      <main className="project-vision-layout">
        <section className="project-vision-hero" aria-labelledby="project-vision-title">
          <div className="project-hero-art" aria-hidden="true"><i /><i /><i /></div>
          <div className="project-hero-copy">
            <span>研究组合</span>
            <h2 id="project-vision-title">把论文、上下文与产物组织成持续推进的研究空间</h2>
            <p>{loading ? "正在读取你的研究项目。" : overview.total ? `当前共维护 ${overview.total} 个项目，其中 ${overview.active} 个正在推进。` : "建立第一个项目，从研究问题开始积累长期上下文。"}</p>
          </div>
          <div className="project-hero-action">
            <span>下一步</span>
            <strong>{overview.total ? "继续推进现有研究" : "创建第一个研究项目"}</strong>
            <button onClick={overview.total ? () => onOpenProject(projects[0].id) : openNewProjectDialog} type="button">
              {overview.total ? "打开最近项目" : "开始创建"}<b aria-hidden="true">→</b>
            </button>
          </div>
        </section>

        <section className="vision-stats project-vision-stats" aria-label="项目概览">
          <VisionMetric label="项目" value={overview.total} hint={`${overview.active} 个正在推进`} tone="violet" />
          <VisionMetric label="关联论文" value={overview.papers} hint="项目研究材料" tone="blue" />
          <VisionMetric label="知识上下文" value={overview.notes} hint="笔记与知识来源" tone="gold" />
          <VisionMetric label="研究产物" value={overview.artifacts} hint="已沉淀的结果" tone="coral" />
        </section>

        <section className="project-vision-workspace" aria-labelledby="project-list-title">
          <header className="project-workspace-heading">
            <div>
              <span>项目空间</span>
              <h2 id="project-list-title">全部项目</h2>
              <p>进入项目后继续管理目标、候选论文、上下文与研究产物。</p>
            </div>
            <div className="project-workspace-summary" aria-label="项目状态摘要">
              <span><i className="active" />活跃 {overview.active}</span>
              <span><i className="paused" />暂停 {overview.paused}</span>
              <strong>{overview.total} 项</strong>
            </div>
          </header>

          {loading ? (
            <LoadingPanel compact rows={6} title="读取项目空间" />
          ) : projects.length ? (
            <div className="project-vision-grid">
              {projects.map((project, index) => <ProjectCard index={index} key={project.id} onOpen={onOpenProject} project={project} />)}
            </div>
          ) : (
            <div className="project-vision-empty">
              <span className="project-empty-icon"><ProjectGlyph /></span>
              <div><strong>这里还没有研究项目</strong><p>创建项目后，论文、笔记与产物会在同一个研究上下文中持续积累。</p></div>
              <button onClick={openNewProjectDialog} type="button">新建项目</button>
            </div>
          )}
        </section>
      </main>
      <WorkspaceDialog
        className="new-project-dialog"
        description="建立一个长期研究空间；保存后即可关联论文、上下文和研究产物。"
        eyebrow="Research workspace"
        footer={(
          <>
            <span>带 * 的字段为必填项</span>
            <div>
              <button disabled={savingProject} onClick={() => setProjectDialogOpen(false)} type="button">取消</button>
              <button className="workspace-dialog-primary" disabled={savingProject || !projectForm.name.trim()} form="new-project-dialog-form" type="submit">
                {savingProject ? "创建中…" : "创建并进入项目"}<i aria-hidden="true">→</i>
              </button>
            </div>
          </>
        )}
        icon="PJ"
        onClose={() => {
          if (!savingProject) setProjectDialogOpen(false);
        }}
        open={projectDialogOpen}
        title="新建研究项目"
      >
        <form className="workspace-form" id="new-project-dialog-form" onSubmit={createProject}>
          <label className="workspace-field workspace-field-wide">
            <span>项目名称 *</span>
            <input autoFocus onChange={(event) => updateProjectForm("name", event.target.value)} placeholder="例如：Agentic Research Workflow" required value={projectForm.name} />
          </label>
          <div className="workspace-field">
            <span>当前阶段</span>
            <WorkspaceSelect ariaLabel="选择项目当前阶段" onChange={(nextValue) => updateProjectForm("status", nextValue)} options={PROJECT_STATUSES} value={projectForm.status} />
          </div>
          <label className="workspace-field">
            <span>研究关键词</span>
            <input onChange={(event) => updateProjectForm("keywords", event.target.value)} placeholder="RAG, agent, scientific discovery" value={projectForm.keywords} />
          </label>
          <label className="workspace-field workspace-field-wide">
            <span>项目上下文</span>
            <textarea onChange={(event) => updateProjectForm("raw_context", event.target.value)} placeholder="粘贴研究问题、README、实验计划或任何需要长期保留的背景。" rows={5} value={projectForm.raw_context} />
            <small>保存后会作为项目知识上下文参与论文匹配与对话。</small>
          </label>
          <section className="workspace-form-section workspace-field-wide">
            <header><div><span>可选连接</span><strong>Obsidian</strong></div><em>{obsidianCapability.available ? "可用" : "未启用"}</em></header>
            <div className="workspace-form-grid">
              <label className="workspace-field">
                <span>项目主页</span>
                <div className="workspace-path-field">
                  <input disabled={!obsidianCapability.available} onChange={(event) => updateProjectForm("obsidian_project_path", event.target.value)} placeholder="Projects/Research/Home.md" value={projectForm.obsidian_project_path} />
                  <button disabled={!obsidianCapability.available} onClick={() => pickProjectPath("obsidian_project_path", "file", "选择 Obsidian 项目主页")} type="button">选择</button>
                </div>
              </label>
              <label className="workspace-field">
                <span>输出目录</span>
                <div className="workspace-path-field">
                  <input disabled={!obsidianCapability.available} onChange={(event) => updateProjectForm("obsidian_output_dir", event.target.value)} placeholder="Projects/Research" value={projectForm.obsidian_output_dir} />
                  <button disabled={!obsidianCapability.available} onClick={() => pickProjectPath("obsidian_output_dir", "directory", "选择 Obsidian 输出目录")} type="button">选择</button>
                </div>
              </label>
            </div>
          </section>
        </form>
      </WorkspaceDialog>
    </section>
  );
}
