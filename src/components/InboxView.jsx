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
        <span className="pill">{(paper.categories || []).slice(0, 2).join(", ") || "arXiv"}</span>
        {paper.feedback_status ? <span className="pill">{paper.feedback_status}</span> : null}
      </div>
    </button>
  ));
}

function PaperDetail({ detail, onFeedback }) {
  if (!detail?.paper) {
    return (
      <div className="empty-detail">
        <h2>选择一篇论文</h2>
        <p>摘要、证据片段和标注操作会显示在这里。</p>
      </div>
    );
  }
  const paper = detail.paper;
  const explanation = detail.explanation || {};
  const evidence = detail.evidence || [];
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

        <div className="detail-actions">
          {["relevant", "not_relevant", "read_later", "read", "favorite"].map((status) => (
            <button data-status={status} key={status} onClick={() => onFeedback(status)} type="button">{status}</button>
          ))}
        </div>

        <div className="section">
          <h3>Recommendation</h3>
          <p className="summary">{explanation.recommendation_reason || "No explanation generated yet."}</p>
        </div>

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

  async function markFeedback(status) {
    if (!activePaperId) return;
    try {
      await postJson(`/api/papers/${activePaperId}/feedback`, { status });
      setStatusMessage(`Marked ${status}`);
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
        <PaperDetail detail={detail} onFeedback={markFeedback} />
      </section>
    </section>
  );
}
