import { useCallback, useEffect, useState } from "react";

import { api, fmtDate, postJson } from "../lib/dashboard.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";

const REPORT_STATUSES = ["queued", "processing", "done", "failed"];
const STATUS_LABELS = {
  queued: "Queued",
  processing: "Processing",
  done: "Done",
  failed: "Failed"
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "Missing";
}

function ReportRow({ active, busy, item, onGenerate, onSelect }) {
  const canRegenerate = item.status === "done" || item.status === "failed";
  const actionLabel = canRegenerate ? "重新生成" : "生成";

  async function handleGenerate(event) {
    event.stopPropagation();
    await onGenerate(item.paper_id, canRegenerate);
  }

  return (
    <article className={`report-row ${active ? "active" : ""}`} onClick={() => onSelect(item.paper_id)}>
      <div className="report-row-main">
        <div className="report-row-title">{item.title}</div>
        <div className="report-row-meta">
          <span>{item.arxiv_id}</span>
          <span>{item.text_status || "text pending"}</span>
          {item.project_names?.length ? <span>{item.project_names.slice(0, 2).join(", ")}</span> : null}
          {item.project_count > 2 ? <span>{item.project_count} projects</span> : null}
          {item.model ? <span>{item.model}</span> : null}
        </div>
        {item.error_message ? <p className="report-row-error">{item.error_message}</p> : null}
      </div>
      <div className="report-row-actions">
        <span className={`status-pill report-status-${item.status}`}>{statusLabel(item.status)}</span>
        {item.status !== "processing" ? (
          <button disabled={busy} onClick={handleGenerate} type="button">{actionLabel}</button>
        ) : null}
      </div>
    </article>
  );
}

function ReportPreview({ detail, onGenerate, busy }) {
  if (!detail?.paper) {
    return (
      <div className="empty-detail">
        <h2>选择一篇论文</h2>
        <p>全文报告和项目关联会显示在这里。</p>
      </div>
    );
  }
  const paper = detail.paper;
  const report = detail.paper_report || {};
  const ready = report.status === "done" && String(report.report_markdown || "").trim();
  const canRegenerate = report.status === "done" || report.status === "failed";
  return (
    <div className="detail-card report-preview-card">
      <div className="detail-main">
        <div className="detail-title">
          <h2>{paper.title}</h2>
          <p className="muted">
            <a href={paper.link} target="_blank" rel="noreferrer">{paper.arxiv_id}</a>
            {" · "}
            {(paper.categories || []).join(", ") || "arXiv"}
          </p>
          <p className="muted">TXT: {paper.text_status || "pending"}{paper.text_path ? ` · ${paper.text_path}` : ""}</p>
        </div>

        <div className={`report-state ${report.status || "missing"}`}>
          <strong>{statusLabel(report.status)}</strong>
          {report.error_message ? <p>{report.error_message}</p> : null}
          {report.model ? <p>{report.model_provider_id ? `${report.model_provider_id} · ` : ""}{report.model}</p> : null}
          {report.updated_at ? <p>Updated: {fmtDate(report.updated_at)}</p> : null}
        </div>

        <div className="detail-actions">
          {report.status !== "processing" && report.status !== "done" && report.status !== "failed" ? (
            <button disabled={busy} onClick={() => onGenerate(paper.id, false)} type="button">生成全文报告</button>
          ) : null}
          {canRegenerate ? (
            <button disabled={busy} onClick={() => onGenerate(paper.id, true)} type="button">重新生成</button>
          ) : null}
        </div>

        <div className="section">
          <h3>项目关联</h3>
          <div className="evidence-list">
            {(detail.project_recommendations || []).length ? detail.project_recommendations.map((recommendation) => (
              <article className="evidence" key={`${recommendation.project_id}-${recommendation.state}`}>
                <strong>{recommendation.project_name} · {recommendation.relation_type} · {recommendation.state}</strong>
                <p>{recommendation.reason || "暂无推荐理由。"}</p>
              </article>
            )) : <p className="summary">暂无项目级推荐。</p>}
          </div>
        </div>

        <div className="section">
          <h3>全文报告</h3>
          {ready ? <LazyMarkdownReport markdown={report.report_markdown} /> : <p className="muted">报告尚未生成。</p>}
        </div>
      </div>
    </div>
  );
}

export function ReportQueueView({ setStatusMessage }) {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({});
  const [queueStatus, setQueueStatus] = useState({});
  const [activePaperId, setActivePaperId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busyPaperId, setBusyPaperId] = useState(null);

  const loadPaper = useCallback(async (paperId) => {
    const data = await api(`/api/papers/${paperId}`);
    setDetail(data);
    setActivePaperId(Number(paperId));
  }, []);

  const refresh = useCallback(async () => {
    const [data, statusData] = await Promise.all([
      api("/api/paper-reports"),
      api("/api/jobs/status")
    ]);
    const nextItems = data.items || [];
    setItems(nextItems);
    setStats(data.stats || {});
    setQueueStatus(statusData.scheduler?.paper_report_queue || {});
    const nextId = activePaperId && nextItems.some((item) => item.paper_id === activePaperId)
      ? activePaperId
      : nextItems[0]?.paper_id;
    if (nextId) {
      await loadPaper(nextId);
    } else {
      setDetail(null);
      setActivePaperId(null);
    }
  }, [activePaperId, loadPaper]);

  useEffect(() => {
    refresh().catch((error) => setStatusMessage(error.message));
    const timer = setInterval(() => {
      refresh().catch((error) => setStatusMessage(error.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh, setStatusMessage]);

  async function generateReport(paperId, force = false) {
    setBusyPaperId(paperId);
    try {
      const data = await postJson(`/api/papers/${paperId}/report`, { force });
      setDetail(data);
      const report = data.paper_report || {};
      setStatusMessage(report.status === "done" ? "全文报告已生成" : statusLabel(report.status));
      await refresh();
    } catch (error) {
      setStatusMessage(error.message);
      await refresh().catch(() => {});
    } finally {
      setBusyPaperId(null);
    }
  }

  return (
    <section className="view report-queue-view">
      <section className="report-list-panel" aria-label="全文报告队列">
        <header className="panel-header">
          <div>
            <h1>报告队列</h1>
            <p className="muted">
              自动生成{queueStatus.enabled ? "已启用" : "未启用"}
              {queueStatus.concurrency ? ` · concurrency ${queueStatus.active || 0}/${queueStatus.concurrency}` : ""}
              {queueStatus.last_skip_reason ? ` · ${queueStatus.last_skip_reason}` : ""}
            </p>
            <div className="report-stats-row">
              {REPORT_STATUSES.map((status) => (
                <span className={`stat-pill report-status-${status}`} key={status}>
                  {statusLabel(status)}: {stats[status] || 0}
                </span>
              ))}
              <span className="stat-pill">Total: {stats.total || 0}</span>
            </div>
          </div>
          <button onClick={() => refresh().catch((error) => setStatusMessage(error.message))} type="button">
            刷新
          </button>
        </header>
        <div className="report-list">
          {items.length ? items.map((item) => (
            <ReportRow
              active={item.paper_id === activePaperId}
              busy={busyPaperId === item.paper_id}
              item={item}
              key={item.paper_id}
              onGenerate={generateReport}
              onSelect={(paperId) => loadPaper(paperId).catch((error) => setStatusMessage(error.message))}
            />
          )) : (
            <div className="paper-card">
              <h2>暂无全文报告任务</h2>
              <div className="card-meta">项目级推荐通过后会自动进入这里。</div>
            </div>
          )}
        </div>
      </section>

      <section className="detail-panel" aria-label="全文报告预览">
        <ReportPreview
          busy={busyPaperId === activePaperId}
          detail={detail}
          onGenerate={generateReport}
        />
      </section>
    </section>
  );
}
