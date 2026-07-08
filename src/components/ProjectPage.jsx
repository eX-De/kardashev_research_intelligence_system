import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  chooseLocalPath,
  compactLabel,
  csv,
  fmtDate,
  fmtScore,
  postJson,
  PROJECT_NOTE_RELATIONS,
  PROJECT_PAPER_RELATIONS,
  PROJECT_STATUSES,
  snippet
} from "../lib/dashboard.js";
import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { friendlyObsidianMessage, postObsidianJson, useObsidianCapability } from "../lib/obsidianCapability.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { LoadingPanel } from "./Loading.jsx";
import { RefreshButton } from "./RefreshButton.jsx";

function relationOptions(options) {
  return options.map(([value, label]) => <option key={value} value={value}>{label}</option>);
}

const PROJECT_STATUS_LABELS = Object.fromEntries(PROJECT_STATUSES);
const PROJECT_PAPER_RELATION_LABELS = Object.fromEntries(PROJECT_PAPER_RELATIONS);
const PROJECT_NOTE_RELATION_LABELS = Object.fromEntries(PROJECT_NOTE_RELATIONS);

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
  const update = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  const obsidianDisabled = !obsidianCapability?.available;
  const obsidianHint = obsidianCapability?.disabledReason || "请先配置可选 Obsidian 集成。";
  return (
    <div className="detail-card project-settings-card">
      <form className="project-form" onSubmit={onSubmit}>
        <div className="detail-title">
          <h2>{project?.id ? "项目设置" : "新建项目"}</h2>
          <p className="muted">{project?.id ? `项目元数据和上下文输入 · Updated ${fmtDate(project.updated_at)}` : "先创建项目；论文判断、关联和实验进展会在保存后进入工作台。"}</p>
        </div>
        <label>
          <span>项目名称</span>
          <input value={form.name} required onChange={(event) => update("name", event.target.value)} />
        </label>
        <label>
          <span>状态</span>
          <select value={form.status} onChange={(event) => update("status", event.target.value)}>
            {PROJECT_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>关键词</span>
          <input value={form.keywords} placeholder="RAG,agent,scientific discovery" onChange={(event) => update("keywords", event.target.value)} />
        </label>
        <label>
          <span>原始项目上下文</span>
          <textarea
            value={form.raw_context}
            placeholder="粘贴项目 README、研究问题、实验计划或任意自由文本。保存后会进入系统内知识文档。"
            onChange={(event) => update("raw_context", event.target.value)}
            rows={7}
          />
        </label>
        <label className={obsidianDisabled ? "capability-disabled" : ""}>
          <span>Obsidian 项目主页</span>
          <div className="path-input-row">
            <input disabled={obsidianDisabled} value={form.obsidian_project_path} placeholder="Projects/Agentic RAG/Home.md" onChange={(event) => update("obsidian_project_path", event.target.value)} />
            <button disabled={obsidianDisabled} title={obsidianDisabled ? obsidianHint : undefined} type="button" onClick={() => onPickPath("obsidian_project_path", "file", "选择 Obsidian 项目主页 Markdown")}>选择</button>
          </div>
          {obsidianDisabled ? <small className="capability-hint">{obsidianHint}</small> : null}
        </label>
        <label className={obsidianDisabled ? "capability-disabled" : ""}>
          <span>Obsidian 输出目录</span>
          <div className="path-input-row">
            <input disabled={obsidianDisabled} value={form.obsidian_output_dir} placeholder="Projects/Agentic RAG" onChange={(event) => update("obsidian_output_dir", event.target.value)} />
            <button disabled={obsidianDisabled} title={obsidianDisabled ? obsidianHint : undefined} type="button" onClick={() => onPickPath("obsidian_output_dir", "directory", "选择 Obsidian 输出目录")}>选择</button>
          </div>
          {obsidianDisabled ? <small className="capability-hint">{obsidianHint}</small> : null}
        </label>
        <div className="form-actions">
          <button type="submit" className="primary">保存项目</button>
        </div>
      </form>
    </div>
  );
}

function ProjectSummaryStrip({ project, pendingCount, linkedPaperCount, reportCount, contextCount, artifactCount }) {
  const statusLabel = PROJECT_STATUS_LABELS[project?.status] || project?.status || "未设置";
  return (
    <div className="project-summary-strip" aria-label="项目状态摘要">
      <div className="project-summary-item primary">
        <span>待判断论文</span>
        <strong>{pendingCount}</strong>
      </div>
      <div className="project-summary-item">
        <span>已关联论文</span>
        <strong>{linkedPaperCount}</strong>
      </div>
      <div className="project-summary-item">
        <span>实验进展</span>
        <strong>{reportCount}</strong>
      </div>
      <div className="project-summary-item">
        <span>Context</span>
        <strong>{contextCount}</strong>
      </div>
      <div className="project-summary-item">
        <span>项目状态</span>
        <strong>{statusLabel}</strong>
        <p>{artifactCount} outputs</p>
      </div>
    </div>
  );
}

function PendingPaperQueuePanel({ papers, evidenceByPaperId, onAcceptRecommendation }) {
  return (
    <section className="panel project-match-panel pending-paper-panel">
      <div className="panel-title">
        <div>
          <h2>待判断论文</h2>
          <p>来自论文 inbox 的项目级 pending 推荐；相似度匹配只作为解释证据。</p>
        </div>
        <p>{papers.length} pending</p>
      </div>
      <div className="project-match-list">
        {papers.length ? papers.map((paper) => {
          const relationType = paper.relation_type || "recommended";
          const evidence = evidenceByPaperId.get(Number(paper.id)) || [];
          const primaryEvidence = evidence[0] || null;
          return (
            <article className="project-match-item" key={`${paper.id}-${paper.recommendation_updated_at || ""}`}>
              <div className="project-match-head">
                <div>
                  <strong>{paper.title}</strong>
                  <p className="muted">{paper.arxiv_id} · {relationType} · usefulness {fmtScore(paper.score)}{paper.confidence ? ` · confidence ${fmtScore(paper.confidence)}` : ""}</p>
                </div>
                <div className="project-match-actions">
                  {paper.link ? <a href={paper.link} target="_blank" rel="noreferrer">arXiv</a> : null}
                  <a href={`/papers/inbox/${paper.id}`}>打开待判断</a>
                  <div className="recommendation-quick-actions" aria-label="保存重要性">
                    <span>保存</span>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "high")}>高</button>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "medium")}>中</button>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "low")}>低</button>
                  </div>
                </div>
              </div>
              <p className="project-recommendation-reason"><span>推荐理由</span>{paper.reason || "暂无推荐理由。"}</p>
              {primaryEvidence ? (
                <div className="project-match-evidence">
                  <p><span>论文匹配片段</span>{snippet(primaryEvidence.arxiv_text || primaryEvidence.evidence?.arxiv_text)}</p>
                  <p><span>项目上下文片段</span>{snippet(`${primaryEvidence.note_title || ""} ${primaryEvidence.obsidian_heading || ""} ${primaryEvidence.obsidian_text || ""}`)}</p>
                  <p className="muted">{primaryEvidence.note_path || "项目上下文"} · chunk {primaryEvidence.best_obsidian_chunk_id || ""}</p>
                </div>
              ) : null}
            </article>
          );
        }) : <p className="muted">暂无来自论文 inbox 的待判断推荐。运行每日任务或同步上下文后，这里会出现新的 pending 推荐。</p>}
      </div>
    </section>
  );
}

function ExperimentProgressPanel({ reports, obsidianCapability, onExport }) {
  const exportDisabled = !obsidianCapability?.available;
  const obsidianHint = obsidianCapability?.disabledReason || "请先配置可选 Obsidian 集成。";
  return (
    <section className="panel experiment-progress-panel">
      <div className="panel-title">
        <h2>实验进展</h2>
        <p>{reports.length} reports</p>
      </div>
      <div className="experiment-report-list">
        {reports.length ? reports.map((report) => {
          const content = report.content_json || {};
          const reportJson = content.report_json || {};
          const sourceAgent = content.source_agent || report.source?.source_agent || "manual";
          const summary = reportJson.task_summary || reportJson.goal || reportJson.conclusion || snippet(report.content_markdown || "", 220);
          return (
            <article className="experiment-report-item" key={report.id}>
              <div className="experiment-report-head">
                <div>
                  <strong>{report.title}</strong>
                  <p className="muted">{sourceAgent} · {fmtDate(report.updated_at)}{report.obsidian_path ? ` · ${report.obsidian_path}` : ""}</p>
                </div>
                <div className="experiment-report-actions">
                  <a href={`/artifacts/${report.id}`}>打开产物</a>
                  <button disabled={exportDisabled} title={exportDisabled ? obsidianHint : undefined} type="button" onClick={() => onExport(report.id)}>导出</button>
                </div>
              </div>
              {summary ? <p className="summary">{summary}</p> : null}
              {report.content_markdown ? (
                <div className="experiment-report-preview">
                  <LazyMarkdownReport markdown={report.content_markdown.slice(0, 1400)} />
                </div>
              ) : null}
            </article>
          );
        }) : <p className="muted">暂无实验进展报告。</p>}
      </div>
    </section>
  );
}

function LinkedPapersPanel({ linkedPapers, onUnlinkPaper }) {
  return (
    <section className="panel linked-papers-panel resource-panel">
      <div className="panel-title">
        <div>
          <h2>已关联论文</h2>
          <p>已经进入这个项目知识资产的论文。</p>
        </div>
        <p>{linkedPapers.length} papers</p>
      </div>
      <div className="linked-list">
        {linkedPapers.length ? linkedPapers.map((paper) => (
          <div className="linked-item" key={paper.id}>
            <div>
              <strong>{paper.title}</strong>
              <p className="muted">{PROJECT_PAPER_RELATION_LABELS[paper.relation] || paper.relation} · {paper.arxiv_id}{paper.project_score ? ` · score ${fmtScore(paper.project_score)}` : ""}</p>
              {paper.note ? <p className="muted">{paper.note}</p> : null}
            </div>
            <button type="button" onClick={() => onUnlinkPaper(paper.id)}>移除</button>
          </div>
        )) : <p className="muted">暂无关联论文。先在待判断论文里按重要性保存，或进入 /papers/inbox 完成处理。</p>}
      </div>
    </section>
  );
}

function ProjectContextPanel({ contextDocuments, linkedNotes, candidateNotes, onLinkNote, onUnlinkNote }) {
  return (
    <section className="panel project-context-panel resource-panel">
      <div className="panel-title">
        <div>
          <h2>Context</h2>
          <p>推荐和判断用到的项目上下文，作为论文工作流的输入层。</p>
        </div>
        <p>{contextDocuments.length} docs · {linkedNotes.length} notes</p>
      </div>
      <div className="project-context-section">
        <h3>系统内上下文</h3>
        <div className="linked-list">
          {contextDocuments.length ? contextDocuments.map((document) => (
            <div className="linked-item" key={`${document.document_id}-${document.relation}`}>
              <div>
                <strong>{document.title}</strong>
                <p className="muted">{document.source_type} · {document.relation} · {document.chunk_count} chunks</p>
                {document.excerpt ? <p className="muted">{snippet(document.excerpt, 160)}</p> : null}
              </div>
            </div>
          )) : <p className="muted">暂无系统内上下文文档。</p>}
        </div>
      </div>
      <div className="project-context-section">
        <h3>项目笔记</h3>
        <form className="link-form" onSubmit={onLinkNote}>
          <label>
            <span>加入笔记</span>
            <select name="note_id" disabled={!candidateNotes.length}>
              {candidateNotes.length ? candidateNotes.map((note) => <option key={note.id} value={note.id}>{compactLabel(`${note.title} · ${note.path}`)}</option>) : <option value="">无可选笔记</option>}
            </select>
          </label>
          <label>
            <span>关系</span>
            <select name="relation" defaultValue="source">{relationOptions(PROJECT_NOTE_RELATIONS)}</select>
          </label>
          <button type="submit" disabled={!candidateNotes.length}>加入</button>
        </form>
        <div className="linked-list">
          {linkedNotes.length ? linkedNotes.map((note) => (
            <div className="linked-item" key={note.id}>
              <div>
                <strong>{note.title}</strong>
                <p className="muted">{PROJECT_NOTE_RELATION_LABELS[note.relation] || note.relation} · {note.path}</p>
                {note.note ? <p className="muted">{note.note}</p> : null}
              </div>
              <button type="button" onClick={() => onUnlinkNote(note.id)}>移除</button>
            </div>
          )) : <p className="muted">暂无关联笔记。</p>}
        </div>
      </div>
    </section>
  );
}

export function ProjectPage({ projectId, onBack, onSavedProject, setStatusMessage }) {
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
  const title = isNew ? "新建项目" : project.name || "项目";
  const artifacts = detail?.artifacts || [];
  const experimentReports = useMemo(
    () => artifacts.filter((artifact) => artifact.artifact_type === "experiment_report"),
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
      setStatusMessage("正在打开本地路径选择器...");
      const data = await chooseLocalPath({ mode, title: titleText, relativeTo: "obsidian_vault" });
      if (data.cancelled) {
        setStatusMessage("已取消路径选择");
        return;
      }
      setForm((current) => ({ ...current, [field]: data.relative_path ?? data.path ?? "" }));
      setStatusMessage("路径已选择");
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error));
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
      setStatusMessage(data.context_job?.queued ? "Project saved; context queued" : "Project saved");
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
        setStatusMessage("Artifact export queued");
        return;
      }
      cache.markStale(["artifact", String(artifactId)]);
      cache.markStale(["artifacts"]);
      await refreshProject();
      setStatusMessage(`Synced ${data.export?.path || "artifact"}`);
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error));
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
      setStatusMessage("已从待判断保存到当前项目");
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function linkNoteById(noteId, relation = "source") {
    if (!projectId || !noteId) return;
    try {
      const data = await postJson(`/api/projects/${projectId}/notes`, { note_id: noteId, relation });
      applyProjectDetail(data);
      setStatusMessage("Note linked");
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function submitNoteLink(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await linkNoteById(formData.get("note_id"), formData.get("relation") || "source");
  }

  async function unlink(type, id) {
    if (!projectId) return;
    try {
      const data = await api(`/api/projects/${projectId}/${type === "paper" ? "papers" : "notes"}/${id}`, { method: "DELETE" });
      applyProjectDetail(data);
      if (type === "paper") cache.markStale(["library"]);
      setStatusMessage(type === "paper" ? "Paper removed from project" : "Note removed from project");
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  return (
    <section className="view project-view project-page">
      <header className="project-dashboard-header">
        <div>
          <button type="button" onClick={onBack}>← 返回项目中心</button>
          <h1>{title}</h1>
          <p>{projectLoading ? "正在读取项目详情" : isNew ? "创建系统内项目配置；保存后进入论文工作台。" : `论文判断工作台 · ${linkedPapers.length} papers · ${linkedNotes.length} notes · ${artifacts.length} outputs`}</p>
        </div>
        {!isNew ? <RefreshButton busy={projectQuery.loading || projectQuery.refreshing} onClick={() => refreshProject().catch((error) => setStatusMessage(error.message))} /> : null}
      </header>

      {projectLoading ? (
        <LoadingPanel
          className="project-page-loading"
          description="正在读取项目配置、关联论文、上下文和生成产物。"
          rows={8}
          title="读取项目详情"
        />
      ) : (
        <div className={`project-page-grid ${isNew ? "project-new-layout" : ""}`}>
          {isNew ? (
            <ProjectForm project={project} form={form} setForm={setForm} obsidianCapability={obsidianCapability} onPickPath={pickPath} onSubmit={saveProject} />
          ) : (
            <>
              <ProjectSummaryStrip
                artifactCount={artifacts.length}
                contextCount={contextDocuments.length + linkedNotes.length}
                linkedPaperCount={linkedPapers.length}
                pendingCount={pendingPapers.length}
                project={project}
                reportCount={experimentReports.length}
              />
              <div className="project-workbench-grid">
                <PendingPaperQueuePanel
                  evidenceByPaperId={evidenceByPaperId}
                  onAcceptRecommendation={acceptProjectRecommendation}
                  papers={pendingPapers}
                />
                <div className="project-workbench-side">
                  <LinkedPapersPanel
                    linkedPapers={linkedPapers}
                    onUnlinkPaper={(id) => unlink("paper", id)}
                  />
                  <ExperimentProgressPanel reports={experimentReports} obsidianCapability={obsidianCapability} onExport={exportArtifact} />
                </div>
              </div>
              <div className="project-secondary-grid">
                <ProjectForm project={project} form={form} setForm={setForm} obsidianCapability={obsidianCapability} onPickPath={pickPath} onSubmit={saveProject} />
                <ProjectContextPanel
                  candidateNotes={candidateNotes}
                  contextDocuments={contextDocuments}
                  linkedNotes={linkedNotes}
                  onLinkNote={submitNoteLink}
                  onUnlinkNote={(id) => unlink("note", id)}
                />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
