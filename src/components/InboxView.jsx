import { useCallback, useEffect, useState } from "react";

import { api, fmtScore, postJson } from "../lib/dashboard.js";

function PaperList({ papers, activePaperId, onSelect }) {
  if (!papers.length) {
    return <div className="paper-card"><h2>还没有推荐</h2><div className="card-meta">先在“配置与任务”里保存配置，再执行 run-daily。</div></div>;
  }
  return papers.map((paper) => (
    <button className={`paper-card ${paper.id === activePaperId ? "active" : ""}`} key={paper.id} onClick={() => onSelect(paper.id)} type="button">
      <h2>{paper.title}</h2>
      <div className="card-meta">
        <span className="pill score">{fmtScore(paper.score)}</span>
        {paper.project_name ? <span className="pill">{paper.project_name}</span> : null}
        {paper.project_count > 1 ? <span className="pill">{paper.project_count} projects</span> : null}
        {paper.relation_type ? <span className="pill">{paper.relation_type}</span> : null}
        <span className="pill">{(paper.categories || []).slice(0, 2).join(", ") || "arXiv"}</span>
        {paper.feedback_status ? <span className="pill">{paper.feedback_status}</span> : null}
      </div>
    </button>
  ));
}

function PaperDetail({ detail, onRecommendation }) {
  const [selectedProjectIds, setSelectedProjectIds] = useState([]);
  const [importance, setImportance] = useState("");

  useEffect(() => {
    const recommendations = detail?.project_recommendations || [];
    setSelectedProjectIds(
      recommendations
        .filter((recommendation) => recommendation.state === "pending")
        .map((recommendation) => recommendation.project_id)
    );
    setImportance("");
  }, [detail?.paper?.id, detail?.project_recommendations]);

  if (!detail?.paper) {
    return (
      <div className="empty-detail">
        <h2>选择一篇论文</h2>
        <p>摘要、项目关联和处理操作会显示在这里。</p>
      </div>
    );
  }
  const paper = detail.paper;
  const recommendations = detail.project_recommendations || [];
  const pendingRecommendations = recommendations.filter((recommendation) => recommendation.state === "pending");
  const judgments = detail.project_judgments || [];
  const evidence = detail.evidence || [];
  const importanceOptions = [
    ["high", "高"],
    ["medium", "中"],
    ["low", "低"]
  ];
  const canAccept = Boolean(importance) && selectedProjectIds.length > 0 && pendingRecommendations.length > 0;

  function toggleProject(projectId) {
    setSelectedProjectIds((current) => (
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId]
    ));
  }

  return (
    <div className="detail-card">
      <div className="detail-main">
        <div className="detail-title">
          <h2>{paper.title}</h2>
          <p className="muted">{(paper.authors || []).slice(0, 6).join(", ")}</p>
          <p className="muted">
            <a href={paper.link} target="_blank" rel="noreferrer">{paper.arxiv_id}</a>
            {" · "}
            {(paper.categories || []).join(", ")}
          </p>
          <p className="muted">
            TXT: {paper.text_status || "pending"}
            {paper.text_path ? ` · ${paper.text_path}` : ""}
          </p>
        </div>

        {pendingRecommendations.length ? (
          <div className="recommendation-control">
            <div className="importance-row" role="group" aria-label="重要性">
              {importanceOptions.map(([value, label]) => (
                <button className={importance === value ? "active" : ""} key={value} onClick={() => setImportance(value)} type="button">{label}</button>
              ))}
            </div>
            <div className="project-checkbox-list">
              {pendingRecommendations.map((recommendation) => (
                <label className="checkbox-line project-checkbox" key={recommendation.project_id}>
                  <input
                    checked={selectedProjectIds.includes(recommendation.project_id)}
                    onChange={() => toggleProject(recommendation.project_id)}
                    type="checkbox"
                  />
                  <span>{recommendation.project_name} · {recommendation.relation_type} · {fmtScore(recommendation.usefulness_score)}</span>
                </label>
              ))}
            </div>
            <div className="detail-actions">
              <button className="primary" disabled={!canAccept} onClick={() => onRecommendation({ action: "accept", importance, project_ids: selectedProjectIds })} type="button">加入论文仓库</button>
              <button className="danger" onClick={() => onRecommendation({ action: "discard" })} type="button">遗弃</button>
            </div>
          </div>
        ) : null}

        <div className="section">
          <h3>项目关联</h3>
          <div className="evidence-list">
            {recommendations.length ? recommendations.map((recommendation) => (
              <article className="evidence" key={`${recommendation.project_id}-${recommendation.state}`}>
                <strong>{recommendation.project_name} · {recommendation.relation_type} · {recommendation.state}</strong>
                <p>{recommendation.reason || "暂无推荐理由。"}</p>
                {recommendation.obsidian_path ? <p className="muted">{recommendation.obsidian_path}</p> : null}
              </article>
            )) : <p className="summary">暂无项目级推荐。</p>}
          </div>
        </div>

        {judgments.length ? (
          <div className="section">
            <h3>项目判定</h3>
            <div className="evidence-list">
              {judgments.map((judgment) => (
                <article className="evidence" key={`${judgment.project_id}-${judgment.relation_type}`}>
                  <strong>{judgment.project_name} · {judgment.relation_type} · {fmtScore(judgment.usefulness_score)}</strong>
                  <p>{judgment.reason || "No judgment reason."}</p>
                  {judgment.missing_evidence ? <p className="muted">{judgment.missing_evidence}</p> : null}
                </article>
              ))}
            </div>
          </div>
        ) : null}

        <div className="section">
          <h3>Abstract</h3>
          <p className="summary">{paper.summary}</p>
        </div>

        <div className="section">
          <h3>Evidence</h3>
          <div className="evidence-list">
            {evidence.length ? evidence.map((item, index) => (
              <article className="evidence" key={`${item.chunk_id || item.note_path}-${index}`}>
                <strong>{item.note_title || item.note_path} · {fmtScore(item.score)}</strong>
                {item.arxiv_text ? (
                  <>
                    <p className="muted">Paper chunk {item.arxiv_chunk_index ?? ""}{item.arxiv_page_start ? ` · pages ${item.arxiv_page_start}-${item.arxiv_page_end || item.arxiv_page_start}` : ""}</p>
                    <p>{String(item.arxiv_text).slice(0, 700)}</p>
                  </>
                ) : null}
                <p className="muted">Matched note chunk</p>
                <p>{item.text}</p>
                <p className="muted">{(item.searchers || []).join(", ")}</p>
              </article>
            )) : <p className="muted">No evidence chunks found.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function InboxView({ setStatusMessage }) {
  const [papers, setPapers] = useState([]);
  const [activePaperId, setActivePaperId] = useState(null);
  const [detail, setDetail] = useState(null);

  const loadPaper = useCallback(async (id) => {
    const data = await api(`/api/papers/${id}`);
    setDetail(data);
    setActivePaperId(Number(id));
  }, []);

  const loadInbox = useCallback(async () => {
    const data = await api("/api/inbox");
    const items = data.items || [];
    setPapers(items);
    const nextId = activePaperId && items.some((paper) => paper.id === activePaperId) ? activePaperId : items[0]?.id;
    if (nextId) await loadPaper(nextId);
  }, [activePaperId, loadPaper]);

  useEffect(() => {
    loadInbox().catch((error) => setStatusMessage(error.message));
  }, [loadInbox, setStatusMessage]);

  async function updateRecommendation(payload) {
    if (!activePaperId) return;
    try {
      await postJson(`/api/papers/${activePaperId}/recommendation`, payload);
      setStatusMessage(payload.action === "discard" ? "已遗弃推荐" : "已加入论文仓库");
      await loadInbox();
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  return (
    <section className="view inbox-view">
      <section className="inbox-panel" aria-label="论文 inbox">
        <header className="panel-header">
          <div>
            <h1>论文推荐</h1>
            <p>{papers.length} recommendations</p>
          </div>
          <button className="icon-button" title="刷新" aria-label="刷新" onClick={() => loadInbox().catch((error) => setStatusMessage(error.message))} type="button">
            <span aria-hidden="true">↻</span>
          </button>
        </header>
        <div className="paper-list">
          <PaperList papers={papers} activePaperId={activePaperId} onSelect={(id) => loadPaper(id).catch((error) => setStatusMessage(error.message))} />
        </div>
      </section>

      <section className="detail-panel" aria-label="论文详情">
        <PaperDetail detail={detail} onRecommendation={updateRecommendation} />
      </section>
    </section>
  );
}
