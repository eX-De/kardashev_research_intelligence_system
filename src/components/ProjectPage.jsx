import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

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
import { paperImportanceLabel } from "../lib/paperImportance.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { LoadingPanel } from "./Loading.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { VisionMetric } from "./VisionMetric.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/ProjectPage.css";

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
    <section className="project-detail-section project-detail-settings">
      <header className="project-detail-section-header">
        <div><span>Project configuration</span><h2>{project?.id ? "项目设置" : "创建研究项目"}</h2></div>
        <p>{project?.id ? `最后更新 ${fmtDate(project.updated_at)}` : "保存后进入完整项目工作区"}</p>
      </header>
      <form className="project-detail-form" onSubmit={onSubmit}>
        <label className="project-detail-field">
          <span>项目名称</span>
          <input value={form.name} required onChange={(event) => update("name", event.target.value)} />
        </label>
        <div className="project-detail-field">
          <span>状态</span>
          <WorkspaceSelect ariaLabel="选择项目状态" onChange={(value) => update("status", value)} options={PROJECT_STATUSES} value={form.status} />
        </div>
        <label className="project-detail-field project-detail-field-wide">
          <span>关键词</span>
          <input value={form.keywords} placeholder="RAG,agent,scientific discovery" onChange={(event) => update("keywords", event.target.value)} />
        </label>
        <label className="project-detail-field project-detail-field-wide">
          <span>原始项目上下文</span>
          <textarea
            value={form.raw_context}
            placeholder="粘贴项目 README、研究问题、实验计划或任意自由文本。保存后会进入系统内知识文档。"
            onChange={(event) => update("raw_context", event.target.value)}
            rows={7}
          />
        </label>
        <label className={`project-detail-field project-detail-field-wide ${obsidianDisabled ? "capability-disabled" : ""}`}>
          <span>Obsidian 项目主页</span>
          <div className="path-input-row">
            <input disabled={obsidianDisabled} value={form.obsidian_project_path} placeholder="Projects/Agentic RAG/Home.md" onChange={(event) => update("obsidian_project_path", event.target.value)} />
            <button disabled={obsidianDisabled} title={obsidianDisabled ? obsidianHint : undefined} type="button" onClick={() => onPickPath("obsidian_project_path", "file", "选择 Obsidian 项目主页 Markdown")}>选择</button>
          </div>
          {obsidianDisabled ? <small className="capability-hint">{obsidianHint}</small> : null}
        </label>
        <label className={`project-detail-field project-detail-field-wide ${obsidianDisabled ? "capability-disabled" : ""}`}>
          <span>Obsidian 输出目录</span>
          <div className="path-input-row">
            <input disabled={obsidianDisabled} value={form.obsidian_output_dir} placeholder="Projects/Agentic RAG" onChange={(event) => update("obsidian_output_dir", event.target.value)} />
            <button disabled={obsidianDisabled} title={obsidianDisabled ? obsidianHint : undefined} type="button" onClick={() => onPickPath("obsidian_output_dir", "directory", "选择 Obsidian 输出目录")}>选择</button>
          </div>
          {obsidianDisabled ? <small className="capability-hint">{obsidianHint}</small> : null}
        </label>
        <div className="project-detail-form-actions project-detail-field-wide">
          <p>保存会同步更新项目检索上下文。</p>
          <button type="submit">保存项目 <i aria-hidden="true">→</i></button>
        </div>
      </form>
    </section>
  );
}

function ProjectDailyBrief({ artifact }) {
  const profile = artifact?.content_json || {};
  const findings = Array.isArray(profile.current_findings) ? profile.current_findings.slice(0, 3) : [];
  const questions = Array.isArray(profile.open_questions) ? profile.open_questions.slice(0, 3) : [];
  const model = artifact?.source?.model?.model || "每日任务";
  return (
    <article className={`project-daily-brief ${artifact ? "has-summary" : "is-empty"}`}>
      <header>
        <div><span><i aria-hidden="true" />每日项目摘要</span><h2>{artifact ? "今天从这里继续" : "等待首次项目摘要"}</h2></div>
        {artifact ? <time>{fmtDate(artifact.updated_at)}</time> : <em>每日任务</em>}
      </header>
      {artifact ? (
        <>
          <p className="project-daily-brief-summary">{profile.summary || snippet(artifact.content_markdown || "", 520)}</p>
          <div className="project-daily-brief-columns">
            <section><span>已记录发现</span>{findings.length ? <ul>{findings.map((item) => <li key={item}>{item}</li>)}</ul> : <p>暂无可靠发现记录。</p>}</section>
            <section><span>待解决问题</span>{questions.length ? <ul>{questions.map((item) => <li key={item}>{item}</li>)}</ul> : <p>暂无待解决问题。</p>}</section>
          </div>
          <footer><span>{model} · 自动更新</span><a href={`/artifacts/${artifact.id}`}>查看完整摘要 <i aria-hidden="true">→</i></a></footer>
        </>
      ) : (
        <div className="project-daily-brief-empty">
          <span aria-hidden="true">◎</span>
          <div><strong>每日任务尚未生成项目 Chat 摘要</strong><p>运行每日任务后，这里会汇总项目目标、当前方法、已记录发现与下一步问题。</p></div>
        </div>
      )}
    </article>
  );
}

function PendingPaperQueuePanel({ papers, evidenceByPaperId, onAcceptRecommendation }) {
  return (
    <section className="project-detail-section project-pending-section">
      <header className="project-detail-section-header">
        <div>
          <span>Decision queue</span><h2>待判断论文</h2>
        </div>
        <p>{papers.length} 篇等待决策</p>
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
                  <p>{paper.arxiv_id} · {relationType} · 匹配 {fmtScore(paper.score)}{paper.confidence ? ` · 置信度 ${fmtScore(paper.confidence)}` : ""}</p>
                </div>
                <div className="project-detail-paper-actions">
                  {paper.link ? <a href={paper.link} target="_blank" rel="noreferrer">arXiv</a> : null}
                  <a href={`/papers/inbox/${paper.id}`}>打开待判断</a>
                  <div className="project-detail-importance" aria-label="保存重要性">
                    <span>保存</span>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "high")}>高</button>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "medium")}>中</button>
                    <button type="button" onClick={() => onAcceptRecommendation(paper.id, "low")}>低</button>
                  </div>
                </div>
              </div>
              <p className="project-detail-paper-reason"><span>推荐理由</span>{paper.reason || "暂无推荐理由。"}</p>
              {primaryEvidence ? (
                <div className="project-detail-evidence">
                  <p><span>论文匹配片段</span>{snippet(primaryEvidence.arxiv_text || primaryEvidence.evidence?.arxiv_text)}</p>
                  <p><span>项目上下文片段</span>{snippet(`${primaryEvidence.note_title || ""} ${primaryEvidence.obsidian_heading || ""} ${primaryEvidence.obsidian_text || ""}`)}</p>
                  <p>{primaryEvidence.note_path || "项目上下文"} · chunk {primaryEvidence.best_obsidian_chunk_id || ""}</p>
                </div>
              ) : null}
            </article>
          );
        }) : <div className="project-detail-empty"><strong>当前队列为空</strong><p>运行每日任务或同步上下文后，新的项目候选论文会出现在这里。</p></div>}
      </div>
    </section>
  );
}

function ExperimentProgressPanel({ reports, obsidianCapability, onExport }) {
  const exportDisabled = !obsidianCapability?.available;
  const obsidianHint = obsidianCapability?.disabledReason || "请先配置可选 Obsidian 集成。";
  return (
    <section className="project-detail-section project-experiment-section">
      <header className="project-detail-section-header"><div><span>Research outputs</span><h2>实验进展</h2></div><p>{reports.length} 份报告</p></header>
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
                  <p>{sourceAgent} · {fmtDate(report.updated_at)}{report.obsidian_path ? ` · ${report.obsidian_path}` : ""}</p>
                </div>
                <div className="project-detail-report-actions">
                  <a href={`/artifacts/${report.id}`}>打开产物</a>
                  <button disabled={exportDisabled} title={exportDisabled ? obsidianHint : undefined} type="button" onClick={() => onExport(report.id)}>导出</button>
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
        }) : <div className="project-detail-empty"><strong>暂无实验进展</strong><p>Agent 回传的实验报告会显示在这里。</p></div>}
      </div>
    </section>
  );
}

function LinkedPapersPanel({ linkedPapers, onUnlinkPaper }) {
  return (
    <section className="project-detail-section project-linked-section">
      <header className="project-detail-section-header">
        <div>
          <span>Paper collection</span><h2>已关联论文</h2>
        </div>
        <p>{linkedPapers.length} 篇论文</p>
      </header>
      <div className="project-detail-resource-list">
        {linkedPapers.length ? linkedPapers.map((paper) => (
          <article className="project-detail-resource-item" key={paper.id}>
            <div>
              <Link
                aria-label={`打开论文报告：${paper.title}`}
                className="project-detail-resource-link"
                to={`/papers/reports/${encodeURIComponent(String(paper.id))}`}
              >
                <strong>{paper.title}</strong>
                <p>{PROJECT_PAPER_RELATION_LABELS[paper.relation] || paper.relation} · {paper.arxiv_id}{paper.importance ? ` · 重要性 ${paperImportanceLabel(paper.importance)}` : ""}{paper.project_score ? ` · 匹配 ${fmtScore(paper.project_score)}` : ""}</p>
                {paper.note ? <small>{paper.note}</small> : null}
              </Link>
            </div>
            <button type="button" onClick={() => onUnlinkPaper(paper.id)}>移除</button>
          </article>
        )) : <div className="project-detail-empty"><strong>暂无关联论文</strong><p>从待判断队列保存论文后会进入这里。</p></div>}
      </div>
    </section>
  );
}

function ProjectContextPanel({ contextDocuments, linkedNotes, candidateNotes, onLinkNote, onUnlinkNote }) {
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
          <span>Knowledge context</span><h2>项目上下文</h2>
        </div>
        <p>{contextDocuments.length} 文档 · {linkedNotes.length} 笔记</p>
      </header>
      <div className="project-detail-context-group">
        <h3>系统内上下文</h3>
        <div className="project-detail-resource-list">
          {contextDocuments.length ? contextDocuments.map((document) => (
            <article className="project-detail-resource-item" key={`${document.document_id}-${document.relation}`}>
              <div>
                <strong>{document.title}</strong>
                <p>{document.source_type} · {document.relation} · {document.chunk_count} 个片段</p>
                {document.excerpt ? <small>{snippet(document.excerpt, 160)}</small> : null}
              </div>
            </article>
          )) : <div className="project-detail-empty compact"><p>暂无系统内上下文文档。</p></div>}
        </div>
      </div>
      <div className="project-detail-context-group">
        <h3>项目笔记</h3>
        <form className="project-detail-note-form" onSubmit={(event) => { event.preventDefault(); if (noteId) onLinkNote(noteId, relation); }}>
          <div className="project-detail-field">
            <span>加入笔记</span>
            <WorkspaceSelect ariaLabel="选择项目笔记" disabled={!candidateNotes.length} onChange={setNoteId} options={candidateNotes.length ? candidateNotes.map((note) => [String(note.id), compactLabel(`${note.title} · ${note.path}`)]) : [["", "无可选笔记"]]} value={noteId} />
          </div>
          <div className="project-detail-field">
            <span>关系</span>
            <WorkspaceSelect ariaLabel="选择笔记关系" onChange={setRelation} options={PROJECT_NOTE_RELATIONS} value={relation} />
          </div>
          <button type="submit" disabled={!candidateNotes.length}>加入</button>
        </form>
        <div className="project-detail-resource-list">
          {linkedNotes.length ? linkedNotes.map((note) => (
            <article className="project-detail-resource-item" key={note.id}>
              <div>
                <strong>{note.title}</strong>
                <p>{PROJECT_NOTE_RELATION_LABELS[note.relation] || note.relation} · {note.path}</p>
                {note.note ? <small>{note.note}</small> : null}
              </div>
              <button type="button" onClick={() => onUnlinkNote(note.id)}>移除</button>
            </article>
          )) : <div className="project-detail-empty compact"><p>暂无关联笔记。</p></div>}
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
    <section className="view project-detail-view">
      <header className="vision-topbar project-detail-topbar">
        <div className="project-detail-title-group">
          <button aria-label="返回项目中心" className="project-detail-back" type="button" onClick={onBack}>←</button>
          <div className="vision-brand">
            <span>{isNew ? "创建研究空间" : "项目研究空间"}</span>
            <h1>{title}</h1>
          </div>
        </div>
        {!isNew ? (
          <div className="vision-top-actions">
            <span className={`vision-live-state ${["active", "exploring", "writing"].includes(project.status) ? "running" : "ready"}`}><i aria-hidden="true" />{PROJECT_STATUS_LABELS[project.status] || project.status || "未设置"}</span>
            <RefreshButton busy={projectQuery.loading || projectQuery.refreshing} className="vision-refresh" onClick={() => refreshProject().catch((error) => setStatusMessage(error.message))} />
          </div>
        ) : null}
      </header>

      {projectLoading ? (
        <LoadingPanel
          className="project-page-loading"
          description="正在读取项目配置、关联论文、上下文和生成产物。"
          rows={8}
          title="读取项目详情"
        />
      ) : (
        <main className={`project-detail-layout ${isNew ? "is-new" : ""}`}>
          {isNew ? (
            <ProjectForm project={project} form={form} setForm={setForm} obsidianCapability={obsidianCapability} onPickPath={pickPath} onSubmit={saveProject} />
          ) : (
            <>
              <section className="project-detail-hero">
                <div className="project-detail-intro">
                  <span>Research workspace</span>
                  <h2>{project.name}</h2>
                  <p>{project.summary || project.goals || "这个项目尚未填写人工概述。可以在页面下方的项目设置中补充研究背景和目标。"}</p>
                  <div className="project-detail-tags">
                    {(project.keywords || []).length ? project.keywords.slice(0, 8).map((keyword) => <span key={keyword}>{keyword}</span>) : <span>暂无关键词</span>}
                  </div>
                  <footer><span>创建于 {fmtDate(project.created_at)}</span><span>更新于 {fmtDate(project.updated_at)}</span></footer>
                </div>
                <ProjectDailyBrief artifact={dailyProjectSummary} />
              </section>

              <section className="vision-stats project-detail-stats" aria-label="项目规模">
                <VisionMetric hint="等待项目决策" label="待判断" tone="coral" value={pendingPapers.length} />
                <VisionMetric hint="已进入项目资产" label="关联论文" tone="blue" value={linkedPapers.length} />
                <VisionMetric hint={`${contextDocuments.length} 文档 · ${linkedNotes.length} 笔记`} label="知识上下文" tone="gold" value={contextDocuments.length + linkedNotes.length} />
                <VisionMetric hint={`${experimentReports.length} 份实验报告`} label="研究产物" tone="violet" value={artifacts.length} />
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
