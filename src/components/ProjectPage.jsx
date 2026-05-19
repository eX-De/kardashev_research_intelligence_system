import { useCallback, useEffect, useMemo, useState } from "react";

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

function relationOptions(options) {
  return options.map(([value, label]) => <option key={value} value={value}>{label}</option>);
}

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

function ProjectForm({ project, form, setForm, onPickPath, onSubmit }) {
  const update = (name, value) => setForm((current) => ({ ...current, [name]: value }));
  return (
    <div className="detail-card">
      <form className="project-form" onSubmit={onSubmit}>
        <div className="detail-title">
          <h2>{project?.id ? "项目配置" : "新建项目"}</h2>
          <p className="muted">{project?.id ? `Updated ${fmtDate(project.updated_at)}` : "只保留当前会影响流程的配置项。"}</p>
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
        <label>
          <span>Obsidian 项目主页</span>
          <div className="path-input-row">
            <input value={form.obsidian_project_path} placeholder="Projects/Agentic RAG/Home.md" onChange={(event) => update("obsidian_project_path", event.target.value)} />
            <button type="button" onClick={() => onPickPath("obsidian_project_path", "file", "选择 Obsidian 项目主页 Markdown")}>选择</button>
          </div>
        </label>
        <label>
          <span>Obsidian 输出目录</span>
          <div className="path-input-row">
            <input value={form.obsidian_output_dir} placeholder="Projects/Agentic RAG" onChange={(event) => update("obsidian_output_dir", event.target.value)} />
            <button type="button" onClick={() => onPickPath("obsidian_output_dir", "directory", "选择 Obsidian 输出目录")}>选择</button>
          </div>
        </label>
        <div className="form-actions">
          <button type="submit" className="primary">保存配置</button>
        </div>
      </form>
    </div>
  );
}

function ObsidianPanel({ project, artifacts, contextDocuments, onExport }) {
  return (
    <section className="panel automation-panel">
      <div className="panel-title">
        <h2>集成/导出</h2>
        {project?.id ? <button type="button" onClick={onExport}>同步索引到 Obsidian</button> : null}
      </div>
      <div className="project-health-grid">
        <div className={`health-item ${project?.obsidian_project_path ? "ok" : "warn"}`}>
          <span>项目主页</span>
          <strong>{project?.obsidian_project_path || "未配置"}</strong>
        </div>
        <div className={`health-item ${project?.obsidian_folder || project?.obsidian_output_dir ? "ok" : "warn"}`}>
          <span>项目文件夹</span>
          <strong>{project?.obsidian_folder || project?.obsidian_output_dir || "未配置"}</strong>
        </div>
        <div className="health-item neutral">
          <span>来源</span>
          <strong>{project?.discovery_source || "manual"}</strong>
        </div>
        <div className="health-item neutral">
          <span>状态标签</span>
          <strong>{project?.obsidian_status_tag || "—"}</strong>
        </div>
      </div>
      <div>
        <h3>上下文来源</h3>
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
      <div>
        <h3>生成产物</h3>
        <div className="linked-list">
          {artifacts.length ? artifacts.map((artifact) => (
            <div className="linked-item" key={artifact.id}>
              <div>
                <strong>{artifact.title}</strong>
                <p className="muted">{artifact.status} · {artifact.obsidian_path}</p>
              </div>
            </div>
          )) : <p className="muted">暂无生成产物。</p>}
        </div>
      </div>
    </section>
  );
}

function ProjectMatchesPanel({ matches }) {
  return (
    <section className="panel project-match-panel">
      <div className="panel-title">
        <h2>项目候选论文</h2>
        <p>{matches.length} matches</p>
      </div>
      <div className="project-match-list">
        {matches.length ? matches.map((match) => {
          const relationType = match.judgment?.relation_type || "matched";
          return (
            <article className="project-match-item" key={`${match.paper_id}-${match.updated_at}`}>
              <div className="project-match-head">
                <div>
                  <strong>{match.title}</strong>
                  <p className="muted">{match.arxiv_id} · {relationType} · score {fmtScore(match.score)} · {(match.searchers || []).join(", ") || "matched"}</p>
                </div>
                <a href={match.link || "#"} target="_blank" rel="noreferrer">打开</a>
              </div>
              <div className="project-match-evidence">
                <p><span>论文</span>{snippet(match.arxiv_text || match.evidence?.arxiv_text)}</p>
                <p><span>项目</span>{snippet(`${match.note_title || ""} ${match.obsidian_heading || ""} ${match.obsidian_text || ""}`)}</p>
                <p className="muted">{match.note_path || "项目上下文"} · chunk {match.best_obsidian_chunk_id || ""}</p>
              </div>
            </article>
          );
        }) : <p className="muted">暂无基于项目上下文匹配到的论文。</p>}
      </div>
    </section>
  );
}

function LinkedResourcesPanel({ detail, onLinkPaper, onLinkNote, onUnlinkPaper, onUnlinkNote }) {
  const linkedPapers = detail.papers || [];
  const linkedNotes = detail.notes || [];
  const candidatePapers = detail.candidate_papers || [];
  const candidateNotes = detail.candidate_notes || [];
  return (
    <section className="panel resource-panel">
      <div className="panel-title">
        <h2>关联信息</h2>
        <p>{detail.project?.paper_count || 0} papers · {detail.project?.note_count || 0} notes</p>
      </div>
      <div className="link-grid">
        <form className="link-form" onSubmit={onLinkPaper}>
          <label>
            <span>加入论文</span>
            <select name="paper_id" disabled={!candidatePapers.length}>
              {candidatePapers.length ? candidatePapers.map((paper) => <option key={paper.id} value={paper.id}>{compactLabel(`${paper.arxiv_id} · ${paper.title}`)}</option>) : <option value="">无可选论文</option>}
            </select>
          </label>
          <label>
            <span>关系</span>
            <select name="relation" defaultValue="candidate">{relationOptions(PROJECT_PAPER_RELATIONS)}</select>
          </label>
          <button type="submit" disabled={!candidatePapers.length}>加入</button>
        </form>
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
      </div>
      <div className="resource-columns">
        <div>
          <h3>项目论文</h3>
          <div className="linked-list">
            {linkedPapers.length ? linkedPapers.map((paper) => (
              <div className="linked-item" key={paper.id}>
                <div>
                  <strong>{paper.title}</strong>
                  <p className="muted">{paper.relation} · {paper.arxiv_id}{paper.project_score ? ` · score ${fmtScore(paper.project_score)}` : ""}</p>
                  {paper.note ? <p className="muted">{paper.note}</p> : null}
                </div>
                <button type="button" onClick={() => onUnlinkPaper(paper.id)}>移除</button>
              </div>
            )) : <p className="muted">暂无关联论文。</p>}
          </div>
        </div>
        <div>
          <h3>项目笔记</h3>
          <div className="linked-list">
            {linkedNotes.length ? linkedNotes.map((note) => (
              <div className="linked-item" key={note.id}>
                <div>
                  <strong>{note.title}</strong>
                  <p className="muted">{note.relation} · {note.path}</p>
                  {note.note ? <p className="muted">{note.note}</p> : null}
                </div>
                <button type="button" onClick={() => onUnlinkNote(note.id)}>移除</button>
              </div>
            )) : <p className="muted">暂无关联 Obsidian 笔记。</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

export function ProjectPage({ projectId, onBack, onSavedProject, setStatusMessage }) {
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(projectToForm());
  const isNew = !projectId;

  const loadProject = useCallback(async () => {
    if (!projectId) {
      setDetail(null);
      setForm(projectToForm({ status: "active" }));
      return;
    }
    const data = await api(`/api/projects/${projectId}`);
    setDetail(data);
    setForm((current) => ({ ...projectToForm(data.project), raw_context: current.raw_context }));
  }, [projectId]);

  useEffect(() => {
    loadProject().catch((error) => setStatusMessage(error.message));
  }, [loadProject, setStatusMessage]);

  const project = detail?.project || {};
  const title = isNew ? "新建项目" : project.name || "项目";
  const artifacts = detail?.artifacts || [];
  const contextDocuments = detail?.context_documents || [];
  const matches = detail?.retrieval_hits || detail?.project_matches || [];

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
      setStatusMessage(error.message);
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
      setDetail(data);
      setForm(projectToForm(data.project));
      setStatusMessage("Project saved");
      if (!projectId) onSavedProject(data.project.id);
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function exportProject() {
    if (!projectId) return;
    try {
      const data = await postJson(`/api/projects/${projectId}/export-obsidian`);
      setDetail(data);
      setStatusMessage(`Synced ${data.export?.obsidian_path || "project index"}`);
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function submitLink(event, type) {
    event.preventDefault();
    if (!projectId) return;
    const formData = new FormData(event.currentTarget);
    const payload = type === "paper"
      ? { paper_id: formData.get("paper_id"), relation: formData.get("relation") }
      : { note_id: formData.get("note_id"), relation: formData.get("relation") };
    try {
      const data = await postJson(`/api/projects/${projectId}/${type === "paper" ? "papers" : "notes"}`, payload);
      setDetail(data);
      setStatusMessage(type === "paper" ? "Paper linked" : "Note linked");
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function unlink(type, id) {
    if (!projectId) return;
    try {
      const data = await api(`/api/projects/${projectId}/${type === "paper" ? "papers" : "notes"}/${id}`, { method: "DELETE" });
      setDetail(data);
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
          <p>{isNew ? "创建项目配置；从 Obsidian 同步的项目通常不需要手工创建。" : `${project.paper_count || 0} papers · ${project.note_count || 0} notes · ${artifacts.length} outputs`}</p>
        </div>
      </header>

      <div className="project-page-grid">
        <ProjectForm project={project} form={form} setForm={setForm} onPickPath={pickPath} onSubmit={saveProject} />
        {!isNew ? (
          <>
            <ObsidianPanel project={project} artifacts={artifacts} contextDocuments={contextDocuments} onExport={exportProject} />
            <ProjectMatchesPanel matches={matches} />
            <LinkedResourcesPanel
              detail={detail || {}}
              onLinkPaper={(event) => submitLink(event, "paper")}
              onLinkNote={(event) => submitLink(event, "note")}
              onUnlinkPaper={(id) => unlink("paper", id)}
              onUnlinkNote={(id) => unlink("note", id)}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
