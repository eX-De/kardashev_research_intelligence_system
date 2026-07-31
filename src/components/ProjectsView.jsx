import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { LoadingPanel } from "./Loading.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import { formatMetricCount, VisionMetric } from "./VisionMetric.jsx";
import { api, chooseLocalPath, fmtDate, postJson, projectStatusOptions, statusLabel } from "../lib/dashboard.js";
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
  const { t, i18n } = useTranslation("projects");
  const projectPath = project.obsidian_folder || project.obsidian_project_path || project.obsidian_output_dir || t("list.internalProject");
  const metrics = [
    [t("list.papers"), project.paper_count],
    [t("list.context"), project.note_count],
    [t("list.artifact"), project.artifact_count]
  ];

  return (
    <button className={`project-vision-card project-tone-${project.status || "default"}`} onClick={() => onOpen(project.id)} type="button">
      <header>
        <span className="project-card-index"><small>{t("common.researchProject")}</small><strong>{String(index + 1).padStart(2, "0")}</strong></span>
        <span className={`project-card-status status-${project.status}`}><i aria-hidden="true" />{statusLabel(project.status, t)}</span>
      </header>
      <div className="project-card-body">
        <div className="project-card-copy">
          <strong>{project.name}</strong>
          <p title={projectPath}>{projectPath}</p>
        </div>
      </div>
      <div className="project-card-metrics" aria-label={t("list.scaleAria")}>
        {metrics.map(([label, value]) => (
          <span key={label}><small>{label}</small><strong>{formatMetricCount(value, i18n.resolvedLanguage)}</strong></span>
        ))}
      </div>
      <footer>
        <span>{t("list.updatedAt", { date: fmtDate(project.updated_at, i18n.resolvedLanguage) })}</span>
        <b>{t("list.openProject")} <i aria-hidden="true">→</i></b>
      </footer>
    </button>
  );
}

export function ProjectsView({ onOpenProject, setStatusMessage }) {
  const { t } = useTranslation("projects");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectForm, setProjectForm] = useState(emptyProjectForm);
  const [savingProject, setSavingProject] = useState(false);
  const projectsQuery = useCachedApi(["projects"], () => api("/api/projects"), { staleTime: 60000 });
  const handleObsidianError = useCallback((error) => setStatusMessage(friendlyObsidianMessage(error, t)), [setStatusMessage, t]);
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
      setStatusMessage(friendlyObsidianMessage(error, t));
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
      setStatusMessage(t(data.context_job?.queued ? "create.createdQueued" : "create.created"));
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
          <span>{t("list.eyebrow")}</span>
          <h1>{t("list.title")}</h1>
        </div>
        <div className="vision-top-actions">
          <span className={`vision-live-state ${overview.active ? "running" : "ready"}`}><i aria-hidden="true" />{loading ? t("list.syncing") : t("list.activeCount", { count: overview.active })}</span>
          <RefreshButton busy={refreshBusy} className="vision-refresh" onClick={refresh} />
          <button className="project-new-button workspace-primary-action" onClick={openNewProjectDialog} type="button"><span aria-hidden="true">＋</span>{t("list.newProject")}</button>
        </div>
      </header>

      <main className="project-vision-layout">
        <section className="project-vision-hero" aria-labelledby="project-vision-title">
          <div className="project-hero-art" aria-hidden="true"><i /><i /><i /></div>
          <div className="project-hero-copy">
            <span>{t("list.portfolio")}</span>
            <h2 id="project-vision-title">{t("list.heroTitle")}</h2>
            <p>{loading ? t("list.loadingProjects") : overview.total ? t("list.overviewSentence", { total: overview.total, active: overview.active }) : t("list.firstProjectHint")}</p>
          </div>
          <div className="project-hero-action">
            <span>{t("list.next")}</span>
            <strong>{t(overview.total ? "list.continueExisting" : "list.createFirst")}</strong>
            <button onClick={overview.total ? () => onOpenProject(projects[0].id) : openNewProjectDialog} type="button">
              {t(overview.total ? "list.openRecent" : "list.startCreating")}<b aria-hidden="true">→</b>
            </button>
          </div>
        </section>

        <section className="vision-stats project-vision-stats" aria-label={t("list.overviewAria")}>
          <VisionMetric label={t("list.project")} value={overview.total} hint={t("list.activeHint", { count: overview.active })} tone="violet" />
          <VisionMetric label={t("list.linkedPapers")} value={overview.papers} hint={t("list.researchMaterials")} tone="blue" />
          <VisionMetric label={t("list.knowledgeContext")} value={overview.notes} hint={t("list.notesSources")} tone="gold" />
          <VisionMetric label={t("list.artifacts")} value={overview.artifacts} hint={t("list.settledResults")} tone="coral" />
        </section>

        <section className="project-vision-workspace" aria-labelledby="project-list-title">
          <header className="project-workspace-heading">
            <div>
              <span>{t("list.space")}</span>
              <h2 id="project-list-title">{t("list.allProjects")}</h2>
              <p>{t("list.spaceDescription")}</p>
            </div>
            <div className="project-workspace-summary" aria-label={t("list.statusSummary")}>
              <span><i className="active" />{t("list.active", { count: overview.active })}</span>
              <span><i className="paused" />{t("list.paused", { count: overview.paused })}</span>
              <strong>{t("list.itemCount", { count: overview.total })}</strong>
            </div>
          </header>

          {loading ? (
            <LoadingPanel compact rows={6} title={t("list.loadingSpace")} />
          ) : projects.length ? (
            <div className="project-vision-grid">
              {projects.map((project, index) => <ProjectCard index={index} key={project.id} onOpen={onOpenProject} project={project} />)}
            </div>
          ) : (
            <div className="project-vision-empty">
              <span className="project-empty-icon"><ProjectGlyph /></span>
              <div><strong>{t("list.emptyTitle")}</strong><p>{t("list.emptyDescription")}</p></div>
              <button onClick={openNewProjectDialog} type="button">{t("list.newProject")}</button>
            </div>
          )}
        </section>
      </main>
      <WorkspaceDialog
        className="new-project-dialog"
        description={t("create.description")}
        eyebrow={t("create.eyebrow")}
        footer={(
          <>
            <span>{t("create.requiredHint")}</span>
            <div>
              <button disabled={savingProject} onClick={() => setProjectDialogOpen(false)} type="button">{t("common.cancel")}</button>
              <button className="workspace-dialog-primary" disabled={savingProject || !projectForm.name.trim()} form="new-project-dialog-form" type="submit">
                {t(savingProject ? "create.creating" : "create.createAndEnter")}<i aria-hidden="true">→</i>
              </button>
            </div>
          </>
        )}
        icon="PJ"
        onClose={() => {
          if (!savingProject) setProjectDialogOpen(false);
        }}
        open={projectDialogOpen}
        title={t("create.title")}
      >
        <form className="workspace-form" id="new-project-dialog-form" onSubmit={createProject}>
          <label className="workspace-field workspace-field-wide">
            <span>{t("create.name")}</span>
            <input autoFocus onChange={(event) => updateProjectForm("name", event.target.value)} placeholder={t("create.namePlaceholder")} required value={projectForm.name} />
          </label>
          <div className="workspace-field">
            <span>{t("create.stage")}</span>
            <WorkspaceSelect ariaLabel={t("create.stageAria")} onChange={(nextValue) => updateProjectForm("status", nextValue)} options={projectStatusOptions(t)} value={projectForm.status} />
          </div>
          <label className="workspace-field">
            <span>{t("create.keywords")}</span>
            <input onChange={(event) => updateProjectForm("keywords", event.target.value)} placeholder="RAG, agent, scientific discovery" value={projectForm.keywords} />
          </label>
          <label className="workspace-field workspace-field-wide">
            <span>{t("create.context")}</span>
            <textarea onChange={(event) => updateProjectForm("raw_context", event.target.value)} placeholder={t("create.contextPlaceholder")} rows={5} value={projectForm.raw_context} />
            <small>{t("create.contextHint")}</small>
          </label>
          <section className="workspace-form-section workspace-field-wide">
            <header><div><span>{t("create.optionalConnection")}</span><strong>Obsidian</strong></div><em>{t(obsidianCapability.available ? "create.available" : "create.disabled")}</em></header>
            <div className="workspace-form-grid">
              <label className="workspace-field">
                <span>{t("create.home")}</span>
                <div className="workspace-path-field">
                  <input disabled={!obsidianCapability.available} onChange={(event) => updateProjectForm("obsidian_project_path", event.target.value)} placeholder="Projects/Research/Home.md" value={projectForm.obsidian_project_path} />
                  <button disabled={!obsidianCapability.available} onClick={() => pickProjectPath("obsidian_project_path", "file", t("create.chooseHome"))} type="button">{t("common.select")}</button>
                </div>
              </label>
              <label className="workspace-field">
                <span>{t("create.outputDirectory")}</span>
                <div className="workspace-path-field">
                  <input disabled={!obsidianCapability.available} onChange={(event) => updateProjectForm("obsidian_output_dir", event.target.value)} placeholder="Projects/Research" value={projectForm.obsidian_output_dir} />
                  <button disabled={!obsidianCapability.available} onClick={() => pickProjectPath("obsidian_output_dir", "directory", t("create.chooseOutput"))} type="button">{t("common.select")}</button>
                </div>
              </label>
            </div>
          </section>
        </form>
      </WorkspaceDialog>
    </section>
  );
}
