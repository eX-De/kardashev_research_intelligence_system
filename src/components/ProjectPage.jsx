import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import {
  api,
  chooseLocalPath,
  compactLabel,
  csv,
  fmtDate,
  fmtScore,
  postJson,
  projectNoteRelationOptions,
  projectStatusOptions,
  statusLabel,
  snippet
} from "../lib/dashboard.js";
import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { friendlyObsidianMessage, postObsidianJson, useObsidianCapability } from "../lib/obsidianCapability.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { LoadingPanel } from "./Loading.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { VisionMetric } from "./VisionMetric.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/ProjectPage.css";

function projectToForm(project = {}) {
  return {
    name: project.name || "",
    status: project.status || "active",
    keywords: csv(project.keywords || []),
    raw_context: "",
    obsidian_project_path: project.obsidian_project_path || "",
    obsidian_output_dir: project.obsidian_output_dir || ""
  };
}

const PROJECT_STATUS_ORDER = {
  active: 1,
  exploring: 2,
  writing: 3,
  paused: 4
};

function projectListItemFromDetail(detail) {
  const project = detail?.project;
  if (!project) return null;
  const artifacts = Array.isArray(detail.artifacts) ? detail.artifacts : [];
  return {
    ...project,
    artifact_count: artifacts.length || project.artifact_count || 0,
    latest_artifact_at: artifacts[0]?.updated_at || project.latest_artifact_at || ""
  };
}

function sortProjectRows(left, right) {
  const leftRank = PROJECT_STATUS_ORDER[left.status] || 5;
  const rightRank = PROJECT_STATUS_ORDER[right.status] || 5;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return new Date(right.updated_at || 0) - new Date(left.updated_at || 0);
}

function upsertProjectRow(projects, project) {
  if (!project?.id) return projects;
  const next = Array.isArray(projects) ? [...projects] : [];
  const index = next.findIndex((item) => Number(item.id) === Number(project.id));
  if (index >= 0) next[index] = { ...next[index], ...project };
  else next.push(project);
  return next.sort(sortProjectRows);
}

function ProjectForm({ project, form, setForm, obsidianCapability, onPickPath, onSubmit }) {
  const { t, i18n } = useTranslation("projects");
  const update = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const obsidianDisabled = !obsidianCapability?.available;
  const obsidianHint = obsidianCapability?.disabledReason || t("detail.obsidianHint");
  return (
    <section className="project-detail-section project-detail-settings">
      <header className="project-detail-section-header">
        <div><span>{t("common.projectConfiguration")}</span><h2>{t(project?.id ? "detail.settings" : "detail.create")}</h2></div>
        <p>{project?.id ? t("detail.lastUpdated", { date: fmtDate(project.updated_at, i18n.resolvedLanguage) }) : t("detail.afterSave")}</p>
      </header>
      <form className="project-detail-form" onSubmit={onSubmit}>
        <label className="project-detail-field">
          <span>{t("detail.name")}</span>
          <input value={form.name} required onChange={(event) => update("name", event.target.value)} />
        </label>
        <div className="project-detail-field">
          <span>{t("detail.status")}</span>
          <WorkspaceSelect ariaLabel={t("detail.statusAria")} onChange={(value) => update("status", value)} options={projectStatusOptions(t)} value={form.status} />
        </div>
        <label className="project-detail-field project-detail-field-wide">
          <span>{t("detail.keywords")}</span>
          <input value={form.keywords} placeholder="RAG,agent,scientific discovery" onChange={(event) => update("keywords", event.target.value)} />
        </label>
        <label className="project-detail-field project-detail-field-wide">
          <span>{t("detail.rawContext")}</span>
          <textarea
            value={form.raw_context}
            placeholder={t("detail.rawContextPlaceholder")}
            onChange={(event) => update("raw_context", event.target.value)}
            rows={7}
          />
        </label>
        <label className={`project-detail-field project-detail-field-wide ${obsidianDisabled ? "capability-disabled" : ""}`}>
          <span>{t("detail.obsidianHome")}</span>
          <div className="path-input-row">
            <input disabled={obsidianDisabled} value={form.obsidian_project_path} placeholder="Projects/Agentic RAG/Home.md" onChange={(event) => update("obsidian_project_path", event.target.value)} />
            <button disabled={obsidianDisabled} title={obsidianDisabled ? obsidianHint : undefined} type="button" onClick={() => onPickPath("obsidian_project_path", "file", t("detail.chooseHome"))}>{t("common.select")}</button>
          </div>
          {obsidianDisabled ? <small className="capability-hint">{obsidianHint}</small> : null}
        </label>
        <label className={`project-detail-field project-detail-field-wide ${obsidianDisabled ? "capability-disabled" : ""}`}>
          <span>{t("detail.obsidianOutput")}</span>
          <div className="path-input-row">
            <input disabled={obsidianDisabled} value={form.obsidian_output_dir} placeholder="Projects/Agentic RAG" onChange={(event) => update("obsidian_output_dir", event.target.value)} />
            <button disabled={obsidianDisabled} title={obsidianDisabled ? obsidianHint : undefined} type="button" onClick={() => onPickPath("obsidian_output_dir", "directory", t("detail.chooseOutput"))}>{t("common.select")}</button>
          </div>
          {obsidianDisabled ? <small className="capability-hint">{obsidianHint}</small> : null}
        </label>
        <div className="project-detail-form-actions project-detail-field-wide">
          <p>{t("detail.saveHint")}</p>
          <button type="submit">{t("detail.save")} <i aria-hidden="true">→</i></button>
        </div>
      </form>
    </section>
  );
}

function ProjectDailyBrief({ artifact }) {
  const { t, i18n } = useTranslation("projects");
  const profile = artifact?.content_json || {};
  const findings = Array.isArray(profile.current_findings) ? profile.current_findings.slice(0, 3) : [];
  const questions = Array.isArray(profile.open_questions) ? profile.open_questions.slice(0, 3) : [];
  const model = artifact?.source?.model?.model || t("detail.dailyTask");
  return (
    <article className={`project-daily-brief ${artifact ? "has-summary" : "is-empty"}`}>
      <header>
        <div><span><i aria-hidden="true" />{t("detail.dailyBrief")}</span><h2>{t(artifact ? "detail.continueToday" : "detail.waitingBrief")}</h2></div>
        {artifact ? <time>{fmtDate(artifact.updated_at, i18n.resolvedLanguage)}</time> : <em>{t("detail.dailyTask")}</em>}
      </header>
      {artifact ? (
        <>
          <p className="project-daily-brief-summary">{profile.summary || snippet(artifact.content_markdown || "", 520)}</p>
          <div className="project-daily-brief-columns">
            <section><span>{t("detail.findings")}</span>{findings.length ? <ul>{findings.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{t("detail.noFindings")}</p>}</section>
            <section><span>{t("detail.questions")}</span>{questions.length ? <ul>{questions.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{t("detail.noQuestions")}</p>}</section>
          </div>
          <footer><span>{t("detail.autoUpdated", { model })}</span><a href={`/artifacts/${artifact.id}`}>{t("detail.viewSummary")} <i aria-hidden="true">→</i></a></footer>
        </>
      ) : (
        <div className="project-daily-brief-empty">
          <span aria-hidden="true">◎</span>
          <div><strong>{t("detail.noChatSummary")}</strong><p>{t("detail.chatSummaryHint")}</p></div>
        </div>
      )}
    </article>
  );
}

function PendingPaperQueuePanel({ papers, evidenceByPaperId, onAcceptRecommendation }) {
  const { t } = useTranslation("projects");
  return (
    <section className="project-detail-section project-pending-section">
      <header className="project-detail-section-header">
        <div>
          <span>{t("common.decisionQueue")}</span><h2>{t("detail.pendingPapers")}</h2>
        </div>
        <p>{t("detail.waitingDecision", { count: papers.length })}</p>
      </header>
      <div className="project-detail-paper-list">
        {papers.length ? papers.map((paper) => {
          const relationType = paper.relation_type || "recommended";
          const evidence = evidenceByPaperId.get(Number(paper.id)) || [];
          const primaryEvidence = evidence[0] || null;
          return (
            <article className="project-detail-paper-card" key={`${paper.id}-${paper.recommendation_updated_at || ""}`}>
              <div className="project-detail-paper-head">
                <div>
                  <strong>{paper.title}</strong>
                  <p>{paper.arxiv_id} · {relationType} · {t("detail.match", { score: fmtScore(paper.score) })}{paper.confidence ? ` · ${t("detail.confidence", { score: fmtScore(paper.confidence) })}` : ""}</p>
                </div>
                <div className="project-detail-paper-actions">
                  {paper.link ? <a href={paper.link} target="_blank" rel="noreferrer">arXiv</a> : null}
                  <a href={`/papers/inbox/${paper.id}`}>{t("detail.openPending")}</a>
                  <div className="project-detail-importance" aria-label={t("detail.saveImportanceAria")}>
                    <span>{t("detail.save")}</span>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "high")}>{t("importance.high")}</button>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "medium")}>{t("importance.medium")}</button>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "low")}>{t("importance.low")}</button>
                  </div>
                </div>
              </div>
              <p className="project-detail-paper-reason"><span>{t("detail.reason")}</span>{paper.reason || t("detail.noReason")}</p>
              {primaryEvidence ? (
                <div className="project-detail-evidence">
                  <p><span>{t("detail.paperEvidence")}</span>{snippet(primaryEvidence.arxiv_text || primaryEvidence.evidence?.arxiv_text)}</p>
                  <p><span>{t("detail.contextEvidence")}</span>{snippet(`${primaryEvidence.note_title || ""} ${primaryEvidence.obsidian_heading || ""} ${primaryEvidence.obsidian_text || ""}`)}</p>
                  <p>{primaryEvidence.note_path || t("detail.projectContextFallback")} · {t("detail.chunkCount", { count: primaryEvidence.best_obsidian_chunk_id || 0 })}</p>
                </div>
              ) : null}
            </article>
          );
        }) : <div className="project-detail-empty"><strong>{t("detail.emptyQueue")}</strong><p>{t("detail.emptyQueueHint")}</p></div>}
      </div>
    </section>
  );
}

function ExperimentProgressPanel({ reports, obsidianCapability, onExport }) {
  const { t, i18n } = useTranslation("projects");
  const exportDisabled = !obsidianCapability?.available;
  const obsidianHint = obsidianCapability?.disabledReason || t("detail.obsidianHint");
  return (
    <section className="project-detail-section project-experiment-section">
      <header className="project-detail-section-header"><div><span>{t("common.researchOutputs")}</span><h2>{t("detail.experimentProgress")}</h2></div><p>{t("detail.reportCount", { count: reports.length })}</p></header>
      <div className="project-detail-report-list">
        {reports.length ? reports.map((report) => {
          const content = report.content_json || {};
          const reportJson = content.report_json || {};
          const sourceAgent = content.source_agent || report.source?.source_agent || "manual";
          const summary = reportJson.task_summary || reportJson.goal || reportJson.conclusion || snippet(report.content_markdown || "", 220);
          return (
            <article className="project-detail-report-card" key={report.id}>
              <div className="project-detail-report-head">
                <div>
                  <strong>{report.title}</strong>
                  <p>{sourceAgent} · {fmtDate(report.updated_at, i18n.resolvedLanguage)}{report.obsidian_path ? ` · ${report.obsidian_path}` : ""}</p>
                </div>
                <div className="project-detail-report-actions">
                  <a href={`/artifacts/${report.id}`}>{t("detail.openArtifact")}</a>
                  <button disabled={exportDisabled} title={exportDisabled ? obsidianHint : undefined} type="button" onClick={() => onExport(report.id)}>{t("detail.export")}</button>
                </div>
              </div>
              {summary ? <p className="project-detail-report-summary">{summary}</p> : null}
              {report.content_markdown ? (
                <div className="project-detail-report-preview">
                  <LazyMarkdownReport markdown={report.content_markdown.slice(0, 1400)} />
                </div>
              ) : null}
            </article>
          );
        }) : <div className="project-detail-empty"><strong>{t("detail.noProgress")}</strong><p>{t("detail.noProgressHint")}</p></div>}
      </div>
    </section>
  );
}

function LinkedPapersPanel({ linkedPapers, onUnlinkPaper }) {
  const { t } = useTranslation("projects");
  return (
    <section className="project-detail-section project-linked-section">
      <header className="project-detail-section-header">
        <div>
          <span>{t("common.paperCollection")}</span><h2>{t("detail.linkedPapers")}</h2>
        </div>
        <p>{t("detail.paperCount", { count: linkedPapers.length })}</p>
      </header>
      <div className="project-detail-resource-list">
        {linkedPapers.length ? linkedPapers.map((paper) => (
          <article className="project-detail-resource-item" key={paper.id}>
            <div>
              <Link
                aria-label={t("detail.openPaperReport", { title: paper.title })}
                className="project-detail-resource-link"
                to={`/papers/reports/${encodeURIComponent(String(paper.id))}`}
              >
                <strong>{paper.title}</strong>
                <p>{t(`paperRelation.${paper.relation}`, { defaultValue: paper.relation })} · {paper.arxiv_id}{paper.importance ? ` · ${t("detail.importance", { value: t(`importance.${paper.importance}`, { defaultValue: paper.importance }) })}` : ""}{paper.project_score ? ` · ${t("detail.match", { score: fmtScore(paper.project_score) })}` : ""}</p>
                {paper.note ? <small>{paper.note}</small> : null}
              </Link>
            </div>
            <button type="button" onClick={() => onUnlinkPaper(paper.id)}>{t("common.remove")}</button>
          </article>
        )) : <div className="project-detail-empty"><strong>{t("detail.noLinkedPapers")}</strong><p>{t("detail.noLinkedPapersHint")}</p></div>}
      </div>
    </section>
  );
}

function ProjectContextPanel({ contextDocuments, linkedNotes, candidateNotes, onLinkNote, onUnlinkNote }) {
  const { t } = useTranslation("projects");
  const [noteId, setNoteId] = useState("");
  const [relation, setRelation] = useState("source");
  useEffect(() => {
    if (!candidateNotes.length) setNoteId("");
    else if (!candidateNotes.some((note) => String(note.id) === String(noteId))) setNoteId(String(candidateNotes[0].id));
  }, [candidateNotes, noteId]);
  return (
    <section className="project-detail-section project-context-section-card">
      <header className="project-detail-section-header">
        <div>
          <span>{t("common.knowledgeContext")}</span><h2>{t("detail.projectContext")}</h2>
        </div>
        <p>{t("detail.documentNoteCount", { documents: contextDocuments.length, notes: linkedNotes.length })}</p>
      </header>
      <div className="project-detail-context-group">
        <h3>{t("detail.systemContext")}</h3>
        <div className="project-detail-resource-list">
          {contextDocuments.length ? contextDocuments.map((document) => (
            <article className="project-detail-resource-item" key={`${document.document_id}-${document.relation}`}>
              <div>
                <strong>{document.title}</strong>
                <p>{t(`sourceType.${document.source_type}`, { defaultValue: document.source_type })} · {t(`noteRelation.${document.relation}`, { defaultValue: document.relation })} · {t("detail.chunkCount", { count: document.chunk_count })}</p>
                {document.excerpt ? <small>{snippet(document.excerpt, 160)}</small> : null}
              </div>
            </article>
          )) : <div className="project-detail-empty compact"><p>{t("detail.noSystemContext")}</p></div>}
        </div>
      </div>
      <div className="project-detail-context-group">
        <h3>{t("detail.projectNotes")}</h3>
        <form className="project-detail-note-form" onSubmit={(event) => { event.preventDefault(); if (noteId) onLinkNote(noteId, relation); }}>
          <div className="project-detail-field">
            <span>{t("detail.addNote")}</span>
            <WorkspaceSelect ariaLabel={t("detail.noteAria")} disabled={!candidateNotes.length} onChange={setNoteId} options={candidateNotes.length ? candidateNotes.map((note) => [String(note.id), compactLabel(`${note.title} · ${note.path}`)]) : [["", t("detail.noNotes")]]} value={noteId} />
          </div>
          <div className="project-detail-field">
            <span>{t("detail.relation")}</span>
            <WorkspaceSelect ariaLabel={t("detail.relationAria")} onChange={setRelation} options={projectNoteRelationOptions(t)} value={relation} />
          </div>
          <button type="submit" disabled={!candidateNotes.length}>{t("detail.add")}</button>
        </form>
        <div className="project-detail-resource-list">
          {linkedNotes.length ? linkedNotes.map((note) => (
            <article className="project-detail-resource-item" key={note.id}>
              <div>
                <strong>{note.title}</strong>
                <p>{t(`noteRelation.${note.relation}`, { defaultValue: note.relation })} · {note.path}</p>
                {note.note ? <small>{note.note}</small> : null}
              </div>
              <button type="button" onClick={() => onUnlinkNote(note.id)}>{t("common.remove")}</button>
            </article>
          )) : <div className="project-detail-empty compact"><p>{t("detail.noLinkedNotes")}</p></div>}
        </div>
      </div>
    </section>
  );
}

export function ProjectPage({ projectId, onBack, onSavedProject, setStatusMessage }) {
  const { t, i18n } = useTranslation("projects");
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(projectToForm());
  const isNew = !projectId;
  const cache = useApiCacheClient();
  const hydratedProjectRef = useRef("");
  const projectCacheKey = useMemo(() => ["project", String(projectId || "")], [projectId]);
  const handleCapabilityError = useCallback((error) => setStatusMessage(error.message), [setStatusMessage]);
  const obsidianCapability = useObsidianCapability({ onError: handleCapabilityError });
  const projectQuery = useCachedApi(
    projectCacheKey,
    () => api(`/api/projects/${projectId}`),
    { enabled: !isNew, staleTime: 120000 }
  );
  const refreshProjectCache = projectQuery.refresh;

  const applyProjectDetail = useCallback((data, { updateForm = false } = {}) => {
    setDetail(data);
    if (data?.project?.id) {
      const listProject = projectListItemFromDetail(data);
      cache.setCache(["project", String(data.project.id)], data);
      if (listProject) {
        cache.patch({ key: "projects" }, (current) => ({
          ...(current || {}),
          items: upsertProjectRow(current?.items || [], listProject)
        }));
      }
      cache.markStale(["projects"]);
      cache.markStale(["health"]);
      cache.markStale(["notifications"]);
    }
    if (updateForm && data?.project) {
      setForm(projectToForm(data.project));
    }
  }, [cache]);

  const refreshProject = useCallback(async () => {
    if (isNew) return null;
    const data = await refreshProjectCache({ force: true });
    applyProjectDetail(data);
    return data;
  }, [applyProjectDetail, isNew, refreshProjectCache]);

  useEffect(() => {
    if (isNew) {
      hydratedProjectRef.current = "new";
      setDetail(null);
      setForm(projectToForm({ status: "active" }));
    }
  }, [isNew]);

  useEffect(() => {
    if (isNew || !projectQuery.data?.project) return;
    const signature = `${projectId}:${projectQuery.updatedAt}`;
    if (hydratedProjectRef.current === signature) return;
    hydratedProjectRef.current = signature;
    setDetail(projectQuery.data);
    setForm((current) => ({ ...projectToForm(projectQuery.data.project), raw_context: current.raw_context }));
  }, [isNew, projectId, projectQuery.data, projectQuery.updatedAt]);

  useEffect(() => {
    if (projectQuery.error) setStatusMessage(projectQuery.error.message);
  }, [projectQuery.error, setStatusMessage]);

  const project = detail?.project || {};
  const projectMatchesRoute = Boolean(project.id) && Number(project.id) === Number(projectId);
  const projectLoading = !isNew && !projectMatchesRoute && projectQuery.status !== "error";
  const title = isNew ? t("detail.newTitle") : project.name || t("detail.fallbackTitle");
  const artifacts = detail?.artifacts || [];
  const experimentReports = useMemo(
    () => artifacts.filter((artifact) => artifact.artifact_type === "experiment_report"),
    [artifacts]
  );
  const dailyProjectSummary = useMemo(
    () => artifacts.find((artifact) => artifact.artifact_type === "project_chat_profile" && artifact.status === "ready") || null,
    [artifacts]
  );
  const contextDocuments = detail?.context_documents || [];
  const linkedPapers = detail?.papers || [];
  const linkedNotes = detail?.notes || [];
  const candidatePapers = detail?.candidate_papers || [];
  const candidateNotes = detail?.candidate_notes || [];
  const matches = detail?.retrieval_hits || detail?.project_matches || [];
  const pendingPapers = useMemo(
    () => candidatePapers.filter((paper) => (paper.recommendation_state || "pending") === "pending"),
    [candidatePapers]
  );
  const evidenceByPaperId = useMemo(
    () => {
      const grouped = new Map();
      for (const match of matches) {
        const paperId = Number(match.paper_id);
        if (!paperId) continue;
        const current = grouped.get(paperId) || [];
        current.push(match);
        grouped.set(paperId, current);
      }
      return grouped;
    },
    [matches]
  );

  const payloadBase = useMemo(() => ({
    summary: project.summary || "",
    goals: project.goals || "",
    source_tags: project.source_tags || [],
    arxiv_categories: project.arxiv_categories || [],
    automation: project.automation || {},
    obsidian_folder: project.obsidian_folder || "",
    discovery_source: project.discovery_source || "manual"
  }), [project]);

  async function pickPath(field, mode, titleText) {
    if (!obsidianCapability.available) {
      setStatusMessage(obsidianCapability.disabledReason);
      return;
    }
    try {
      setStatusMessage(t("detail.openingPicker"));
      const data = await chooseLocalPath({ mode, title: titleText, relativeTo: "obsidian_vault" });
      if (data.cancelled) {
        setStatusMessage(t("detail.pickerCancelled"));
        return;
      }
      setForm((current) => ({ ...current, [field]: data.relative_path ?? data.path ?? "" }));
      setStatusMessage(t("detail.pathSelected"));
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error, t));
    }
  }

  async function saveProject(event) {
    event.preventDefault();
    try {
      const payload = {
        ...payloadBase,
        id: projectId || undefined,
        name: form.name,
        status: form.status,
        keywords: form.keywords,
        raw_context: form.raw_context,
        obsidian_project_path: form.obsidian_project_path,
        obsidian_output_dir: form.obsidian_output_dir
      };
      const data = await postJson(projectId ? `/api/projects/${projectId}` : "/api/projects", payload);
      applyProjectDetail(data, { updateForm: true });
      setStatusMessage(t(data.context_job?.queued ? "detail.savedQueued" : "detail.saved"));
      if (!projectId) onSavedProject(data.project.id);
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function exportArtifact(artifactId) {
    if (!artifactId) return;
    if (!obsidianCapability.available) {
      setStatusMessage(obsidianCapability.disabledReason);
      return;
    }
    try {
      const data = await postObsidianJson(`/api/artifacts/${artifactId}/export-obsidian`, {});
      if (data?.queued) {
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        setStatusMessage(t("detail.exportQueued"));
        return;
      }
      cache.markStale(["artifact", String(artifactId)]);
      cache.markStale(["artifacts"]);
      await refreshProject();
      setStatusMessage(t("detail.synced", { path: data.export?.path || "artifact" }));
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error, t));
    }
  }

  async function acceptProjectRecommendation(paperId, importance) {
    if (!projectId || !paperId) return;
    try {
      await postJson(`/api/papers/${paperId}/recommendation`, {
        action: "accept",
        importance,
        project_ids: [Number(projectId)]
      });
      cache.markStale(["inbox"]);
      cache.markStale(["library"]);
      cache.markStale(["projects"]);
      await refreshProject();
      setStatusMessage(t("detail.recommendationAccepted"));
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function linkNoteById(noteId, relation = "source") {
    if (!projectId || !noteId) return;
    try {
      const data = await postJson(`/api/projects/${projectId}/notes`, { note_id: noteId, relation });
      applyProjectDetail(data);
      setStatusMessage(t("detail.noteLinked"));
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function unlink(type, id) {
    if (!projectId) return;
    try {
      const data = await api(`/api/projects/${projectId}/${type === "paper" ? "papers" : "notes"}/${id}`, { method: "DELETE" });
      applyProjectDetail(data);
      if (type === "paper") cache.markStale(["library"]);
      setStatusMessage(t(type === "paper" ? "detail.paperRemoved" : "detail.noteRemoved"));
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  return (
    <section className="view project-detail-view">
      <header className="vision-topbar project-detail-topbar">
        <div className="project-detail-title-group">
          <button aria-label={t("detail.backAria")} className="project-detail-back" type="button" onClick={onBack}>←</button>
          <div className="vision-brand">
            <span>{t(isNew ? "detail.createSpace" : "detail.projectSpace")}</span>
            <h1>{title}</h1>
          </div>
        </div>
        {!isNew ? (
          <div className="vision-top-actions">
            <span className={`vision-live-state ${["active", "exploring", "writing"].includes(project.status) ? "running" : "ready"}`}><i aria-hidden="true" />{statusLabel(project.status, t) || t("common.notSet")}</span>
            <RefreshButton busy={projectQuery.loading || projectQuery.refreshing} className="vision-refresh" onClick={() => refreshProject().catch((error) => setStatusMessage(error.message))} />
          </div>
        ) : null}
      </header>

      {projectLoading ? (
        <LoadingPanel
          className="project-page-loading"
          description={t("detail.loadingDescription")}
          rows={8}
          title={t("detail.loadingTitle")}
        />
      ) : (
        <main className={`project-detail-layout ${isNew ? "is-new" : ""}`}>
          {isNew ? (
            <ProjectForm project={project} form={form} setForm={setForm} obsidianCapability={obsidianCapability} onPickPath={pickPath} onSubmit={saveProject} />
          ) : (
            <>
              <section className="project-detail-hero">
                <div className="project-detail-intro">
                  <span>{t("common.researchWorkspace")}</span>
                  <h2>{project.name}</h2>
                  <p>{project.summary || project.goals || t("detail.summaryFallback")}</p>
                  <div className="project-detail-tags">
                    {(project.keywords || []).length ? project.keywords.slice(0, 8).map((keyword) => <span key={keyword}>{keyword}</span>) : <span>{t("detail.noKeywords")}</span>}
                  </div>
                  <footer><span>{t("detail.createdAt", { date: fmtDate(project.created_at, i18n.resolvedLanguage) })}</span><span>{t("detail.updatedAt", { date: fmtDate(project.updated_at, i18n.resolvedLanguage) })}</span></footer>
                </div>
                <ProjectDailyBrief artifact={dailyProjectSummary} />
              </section>

              <section className="vision-stats project-detail-stats" aria-label={t("detail.scaleAria")}>
                <VisionMetric hint={t("detail.pendingHint")} label={t("detail.pending")} tone="coral" value={pendingPapers.length} />
                <VisionMetric hint={t("detail.linkedHint")} label={t("detail.linkedPapers")} tone="blue" value={linkedPapers.length} />
                <VisionMetric hint={t("detail.contextHint", { documents: contextDocuments.length, notes: linkedNotes.length })} label={t("list.knowledgeContext")} tone="gold" value={contextDocuments.length + linkedNotes.length} />
                <VisionMetric hint={t("detail.artifactHint", { count: experimentReports.length })} label={t("list.artifacts")} tone="violet" value={artifacts.length} />
              </section>

              <div className="project-detail-primary-grid">
                <PendingPaperQueuePanel
                  evidenceByPaperId={evidenceByPaperId}
                  onAcceptRecommendation={acceptProjectRecommendation}
                  papers={pendingPapers}
                />
                <div className="project-detail-side-stack">
                  <LinkedPapersPanel
                    linkedPapers={linkedPapers}
                    onUnlinkPaper={(id) => unlink("paper", id)}
                  />
                  <ExperimentProgressPanel reports={experimentReports} obsidianCapability={obsidianCapability} onExport={exportArtifact} />
                </div>
              </div>
              <div className="project-detail-secondary-grid">
                <ProjectContextPanel
                  candidateNotes={candidateNotes}
                  contextDocuments={contextDocuments}
                  linkedNotes={linkedNotes}
                  onLinkNote={linkNoteById}
                  onUnlinkNote={(id) => unlink("note", id)}
                />
                <ProjectForm project={project} form={form} setForm={setForm} obsidianCapability={obsidianCapability} onPickPath={pickPath} onSubmit={saveProject} />
              </div>
            </>
          )}
        </main>
      )}
    </section>
  );
}
