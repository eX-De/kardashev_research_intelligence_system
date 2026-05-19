import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LoadingPanel } from "./Loading.jsx";
import { api, fmtDate, postJson, snippet } from "../lib/dashboard.js";

const STATUSES = [
  ["", "全部"],
  ["candidate", "候选"],
  ["saved", "已保存"],
  ["reading", "阅读中"],
  ["read", "已读"],
  ["archived", "归档"],
  ["discarded", "已丢弃"]
];

const SOURCES = [
  ["", "全部来源"],
  ["arxiv", "arXiv"],
  ["url", "URL"],
  ["upload", "上传"],
  ["manual", "手动"]
];

const REPORT_STATUS_LABELS = {
  queued: "排队",
  processing: "生成中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

function statusLabel(status) {
  return Object.fromEntries(STATUSES)[status] || status || "未知";
}

function reportStatusLabel(status) {
  return REPORT_STATUS_LABELS[status] || status || "报告";
}

export function PaperLibraryView({ onOpenReportQueue, onSelectPaper, selectedPaperId, setStatusMessage }) {
  const [items, setItems] = useState([]);
  const [detail, setDetail] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const activeIdRef = useRef(null);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const queryString = useMemo(() => {
    const offset = (page - 1) * pageSize;
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    if (status) params.set("status", status);
    if (sourceType) params.set("source_type", sourceType);
    if (query.trim()) params.set("q", query.trim());
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    return params.toString();
  }, [dateFrom, dateTo, page, pageSize, query, sourceType, status]);

  const loadDetail = useCallback(async (id) => {
    const numericId = Number(id);
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    activeIdRef.current = numericId;
    setActiveId(numericId);
    const data = await api(`/api/library/${id}`);
    if (requestId !== detailRequestRef.current) return;
    setDetail(data);
  }, []);

  const load = useCallback(async () => {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;
    const data = await api(`/api/library?${queryString}`);
    if (requestId !== listRequestRef.current) return;
    const next = data.items || [];
    setItems(next);
    setTotal(Number(data.total || 0));
    const routePaperId = Number(selectedPaperId || 0);
    const selectedId = routePaperId || activeIdRef.current;
    const nextId = selectedId && (routePaperId || next.some((item) => Number(item.id) === Number(selectedId))) ? selectedId : next[0]?.id;
    if (nextId) {
      if (!routePaperId) onSelectPaper?.(nextId, { replace: true });
      const detailRequestId = detailRequestRef.current + 1;
      detailRequestRef.current = detailRequestId;
      const detailData = await api(`/api/library/${nextId}`);
      if (requestId !== listRequestRef.current || detailRequestId !== detailRequestRef.current) return;
      activeIdRef.current = Number(nextId);
      setActiveId(Number(nextId));
      setDetail(detailData);
      return;
    }
    detailRequestRef.current += 1;
    activeIdRef.current = null;
    setActiveId(null);
    setDetail(null);
  }, [onSelectPaper, queryString, selectedPaperId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .catch((error) => setStatusMessage(error.message))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, setStatusMessage]);

  async function updateStatus(nextStatus) {
    if (!detail?.paper?.id) return;
    setBusy(true);
    try {
      const data = await postJson(`/api/library/${detail.paper.id}/status`, { status: nextStatus });
      setDetail(data);
      setStatusMessage(`论文状态已更新为 ${statusLabel(nextStatus)}`);
      await load();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  const paper = detail?.paper;
  const paperReport = detail?.paper_report;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  function updateFilter(setter, value) {
    setter(value);
    setPage(1);
  }

  return (
    <section className="view library-view">
      <section className="library-list-panel">
        <header className="panel-header">
          <div>
            <h1>论文仓库</h1>
            <p>{loading ? "正在读取论文..." : `${total} 篇论文 · 第 ${currentPage} / ${pageCount} 页`}</p>
          </div>
          <button onClick={() => load().catch((error) => setStatusMessage(error.message))} type="button">刷新</button>
        </header>
        <div className="library-toolbar">
          <label className="library-filter-control">
            <span>状态</span>
            <select value={status} onChange={(event) => updateFilter(setStatus, event.target.value)}>
              {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="library-filter-control">
            <span>来源</span>
            <select value={sourceType} onChange={(event) => updateFilter(setSourceType, event.target.value)}>
              {SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="library-filter-control library-search-control">
            <span>搜索</span>
            <input value={query} onChange={(event) => updateFilter(setQuery, event.target.value)} placeholder="标题、摘要或 arXiv" />
          </label>
          <label className="library-filter-control">
            <span>发布日期起</span>
            <input type="date" value={dateFrom} onChange={(event) => updateFilter(setDateFrom, event.target.value)} />
          </label>
          <label className="library-filter-control">
            <span>发布日期止</span>
            <input type="date" value={dateTo} onChange={(event) => updateFilter(setDateTo, event.target.value)} />
          </label>
          <label className="library-filter-control">
            <span>每页</span>
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
              {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}/页</option>)}
            </select>
          </label>
        </div>
        <div className="library-list">
          {loading ? (
            <LoadingPanel compact rows={8} title="读取论文列表" />
          ) : (
            items.length ? items.map((item) => (
              <button
                className={`library-row ${activeId === item.id ? "active" : ""}`}
                key={item.id}
                onClick={() => {
                  if (onSelectPaper) {
                    onSelectPaper(item.id);
                    return;
                  }
                  loadDetail(item.id).catch((error) => setStatusMessage(error.message));
                }}
                type="button"
              >
                <strong className="library-row-title">{item.title}</strong>
                <span className="library-row-meta">{statusLabel(item.library_status)} · {item.arxiv_id || item.venue || item.canonical_key}</span>
                <small className="library-row-counts">
                  <span>{item.asset_count || 0} 资产</span>
                  <span>{item.chunk_count || 0} 正文块</span>
                  <span>{item.artifact_count || 0} 产物</span>
                </small>
              </button>
            )) : <p className="muted">暂无论文。</p>
          )}
        </div>
        <div className="pagination-row">
          <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">上一页</button>
          <span>第 {currentPage} 页，共 {pageCount} 页</span>
          <button disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} type="button">下一页</button>
        </div>
      </section>

      <section className="detail-panel library-detail-panel">
        {loading ? (
          <LoadingPanel description="正在打开首篇论文的摘要、资产和正文片段。" rows={7} title="读取论文详情" />
        ) : paper ? (
          <div className="detail-card">
            <div className="detail-title">
              <h2>{paper.title}</h2>
              <p className="muted">{(paper.authors || []).slice(0, 8).join(", ") || "未记录作者"}</p>
              <p className="muted">{paper.arxiv_id || paper.doi || paper.canonical_key} · {statusLabel(paper.library_status)} · {fmtDate(paper.updated_at)}</p>
            </div>
            <div className="detail-actions">
              {paperReport?.paper_id ? (
                <button onClick={() => onOpenReportQueue?.(paperReport.paper_id)} type="button">
                  打开报告队列 · {reportStatusLabel(paperReport.status)}
                </button>
              ) : null}
              <button disabled={busy} onClick={() => updateStatus("saved")} type="button">保存</button>
              <button disabled={busy} onClick={() => updateStatus("reading")} type="button">阅读中</button>
              <button disabled={busy} onClick={() => updateStatus("read")} type="button">已读</button>
              <button disabled={busy} onClick={() => updateStatus("discarded")} type="button">丢弃</button>
            </div>
            <div className="section">
              <h3>摘要</h3>
              <p className="summary">{paper.abstract || "暂无摘要。"}</p>
            </div>
            <div className="section">
              <h3>项目关联</h3>
              <div className="compact-list">
                {(detail.linked_projects || []).map((project) => (
                  <article className="compact-item" key={project.project_id}>
                    <strong>{project.project_name}</strong>
                    <p>{project.relation} · {project.note || "已关联"}</p>
                  </article>
                ))}
                {!(detail.linked_projects || []).length ? <p className="muted">暂无项目关联。</p> : null}
              </div>
            </div>
            <div className="section">
              <h3>资产和来源</h3>
              <div className="compact-list">
                {(detail.sources || []).map((source) => (
                  <article className="compact-item" key={`source-${source.id}`}>
                    <strong>{source.source_type}</strong>
                    <p>{source.source_identifier || source.source_url || "未记录"}</p>
                  </article>
                ))}
                {(detail.assets || []).map((asset) => (
                  <article className="compact-item" key={`asset-${asset.id}`}>
                    <strong>{asset.asset_type} · {asset.status}</strong>
                    <p>{asset.path || asset.url || asset.error_message || "未记录路径"}</p>
                  </article>
                ))}
              </div>
            </div>
            <div className="section">
              <h3>正文片段</h3>
              <div className="compact-list">
                {(detail.chunks || []).slice(0, 5).map((chunk) => (
                  <article className="compact-item" key={chunk.id}>
                    <strong>Chunk {chunk.chunk_index}</strong>
                    <p>{snippet(chunk.text, 260)}</p>
                  </article>
                ))}
                {!(detail.chunks || []).length ? <p className="muted">暂无正文块。</p> : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-detail">
            <h2>选择一篇论文</h2>
            <p>论文状态、来源、资产和关联项目会显示在这里。</p>
          </div>
        )}
      </section>
    </section>
  );
}
