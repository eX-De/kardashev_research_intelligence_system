import { useEffect, useMemo, useState } from "react";

import { LoadingPanel } from "./Loading.jsx";
import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, fmtDate, postJson, snippet } from "../lib/dashboard.js";
import { RefreshButton } from "./RefreshButton.jsx";

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

const STATUS_LABELS = Object.fromEntries(STATUSES.filter(([value]) => value));
const SOURCE_LABELS = Object.fromEntries(SOURCES.filter(([value]) => value));
const STATUS_TONES = {
  archived: "slate",
  candidate: "blue",
  discarded: "red",
  read: "green",
  reading: "gold",
  saved: "teal"
};
const ASSET_STATUS_LABELS = {
  cached: "已缓存",
  done: "完成",
  error: "失败",
  failed: "失败",
  missing: "缺失",
  pending: "等待",
  ready: "就绪"
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

function reportStatusLabel(status) {
  return REPORT_STATUS_LABELS[status] || status || "报告";
}

function sourceLabel(sourceType) {
  return SOURCE_LABELS[sourceType] || sourceType || "来源";
}

function safeToken(value, fallback = "unknown") {
  const token = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return token || fallback;
}

function primarySource(sources = []) {
  if (!Array.isArray(sources) || !sources.length) return null;
  return sources.find((source) => source.source_type === "arxiv") || sources[0];
}

function paperIdentity(paper) {
  return paper?.arxiv_id || paper?.doi || paper?.canonical_key || "未记录标识";
}

export function PaperLibraryView({ onOpenReportQueue, onSelectPaper, selectedPaperId, setStatusMessage }) {
  const cache = useApiCacheClient();
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [busy, setBusy] = useState(false);

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

  const listQuery = useCachedApi(
    ["library", "list", queryString],
    () => api(`/api/library?${queryString}`),
    { staleTime: 60000 }
  );
  const listData = listQuery.data || { items: [], total: 0 };
  const items = listData.items || [];
  const total = Number(listData.total || 0);
  const detailQuery = useCachedApi(
    ["library", "detail", String(activeId || "")],
    () => api(`/api/library/${activeId}`),
    { enabled: Boolean(activeId), staleTime: 60000 }
  );
  const detail = detailQuery.data || null;
  const loading = !listQuery.hasData;
  const detailLoading = Boolean(activeId) && !detailQuery.hasData;

  useEffect(() => {
    if (!listQuery.hasData) return;
    const routePaperId = Number(selectedPaperId || 0);
    const currentId = Number(activeId || 0);
    const currentInList = currentId && items.some((item) => Number(item.id) === currentId);
    const nextId = routePaperId || (currentInList ? currentId : items[0]?.id);
    if (!nextId) {
      setActiveId(null);
      return;
    }
    setActiveId(Number(nextId));
    if (!routePaperId) onSelectPaper?.(nextId, { replace: true });
  }, [activeId, items, listQuery.hasData, onSelectPaper, selectedPaperId]);

  useEffect(() => {
    const error = listQuery.error || detailQuery.error;
    if (error) setStatusMessage(error.message);
  }, [detailQuery.error, listQuery.error, setStatusMessage]);

  async function updateStatus(nextStatus) {
    if (!detail?.paper?.id) return;
    setBusy(true);
    try {
      const data = await postJson(`/api/library/${detail.paper.id}/status`, { status: nextStatus });
      cache.setCache(["library", "detail", String(detail.paper.id)], data);
      listQuery.patch((current) => {
        const paper = data.paper || {};
        const currentItems = current?.items || [];
        const nextItems = currentItems
          .map((item) => Number(item.id) === Number(paper.id) ? {
            ...item,
            library_status: paper.library_status,
            status: paper.status || item.status,
            updated_at: paper.updated_at || item.updated_at
          } : item)
          .filter((item) => !status || item.library_status === status);
        const removed = currentItems.length - nextItems.length;
        return {
          ...(current || {}),
          items: nextItems,
          total: Math.max(0, Number(current?.total || nextItems.length) - removed)
        };
      });
      cache.markStale(["health", "summary"]);
      setStatusMessage(`论文状态已更新为 ${statusLabel(nextStatus)}`);
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  const paper = detail?.paper;
  const paperReport = detail?.paper_report;
  const sources = detail?.sources || [];
  const assets = detail?.assets || [];
  const chunks = detail?.chunks || [];
  const linkedProjects = detail?.linked_projects || [];
  const artifacts = detail?.artifacts || [];
  const mainSource = primarySource(sources);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const selectedStatusLabel = status ? statusLabel(status) : "全部状态";
  const selectedSourceLabel = sourceType ? sourceLabel(sourceType) : "全部来源";
  const searchLabel = query.trim() ? `搜索：${query.trim()}` : "未搜索";
  const dateRangeLabel = dateFrom || dateTo ? `${dateFrom || "不限"} 至 ${dateTo || "不限"}` : "全部日期";
  const activeFilterCount = [status, sourceType, query.trim(), dateFrom, dateTo].filter(Boolean).length;

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  function updateFilter(setter, value) {
    setter(value);
    setPage(1);
  }

  async function refresh() {
    await Promise.all([
      listQuery.refresh({ force: true }),
      activeId ? detailQuery.refresh({ force: true }) : Promise.resolve()
    ]);
  }

  return (
    <section className="view library-view paper-library-view">
      <section className="library-list-panel paper-library-list-panel">
        <header className="panel-header paper-library-header">
          <div>
            <span className="paper-library-eyebrow">论文仓库</span>
            <h1>论文仓库</h1>
            <p>{loading ? "正在读取论文..." : `${total} 篇论文 · 第 ${currentPage} / ${pageCount} 页`}</p>
          </div>
          <RefreshButton busy={listQuery.status === "loading"} onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
        </header>
        <div className="paper-filter-stack">
          <div className="paper-filter-summary">
            <span>{selectedStatusLabel}</span>
            <span>{selectedSourceLabel}</span>
            <span>{searchLabel}</span>
            <span>{dateRangeLabel}</span>
            <button
              aria-controls="paper-library-filter-panel"
              aria-expanded={filtersOpen}
              className="left-filter-toggle"
              onClick={() => setFiltersOpen((current) => !current)}
              type="button"
            >
              {filtersOpen ? "收起筛选" : `筛选${activeFilterCount ? ` (${activeFilterCount})` : ""}`}
            </button>
          </div>
          {filtersOpen ? (
            <div className="library-toolbar paper-library-toolbar" id="paper-library-filter-panel" aria-label="论文筛选">
              <label className="library-filter-control paper-filter-control">
                <span>状态</span>
                <select value={status} onChange={(event) => updateFilter(setStatus, event.target.value)}>
                  {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="library-filter-control paper-filter-control">
                <span>来源</span>
                <select value={sourceType} onChange={(event) => updateFilter(setSourceType, event.target.value)}>
                  {SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="library-filter-control library-search-control paper-filter-control paper-search-control">
                <span>搜索</span>
                <input value={query} onChange={(event) => updateFilter(setQuery, event.target.value)} placeholder="标题、摘要或 arXiv" />
              </label>
              <label className="library-filter-control paper-filter-control">
                <span>发布日期起</span>
                <input type="date" value={dateFrom} onChange={(event) => updateFilter(setDateFrom, event.target.value)} />
              </label>
              <label className="library-filter-control paper-filter-control">
                <span>发布日期止</span>
                <input type="date" value={dateTo} onChange={(event) => updateFilter(setDateTo, event.target.value)} />
              </label>
              <label className="library-filter-control paper-filter-control">
                <span>每页</span>
                <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
                  {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}/页</option>)}
                </select>
              </label>
            </div>
          ) : null}
        </div>
        <div className="library-list paper-library-list">
          {loading ? (
            <LoadingPanel compact rows={8} title="读取论文列表" />
          ) : (
            items.length ? items.map((item) => {
              const itemStatusTone = STATUS_TONES[item.library_status] || "slate";
              const authors = Array.isArray(item.authors) ? item.authors.slice(0, 3).join(", ") : "";
              const published = item.published_at ? fmtDate(item.published_at) : "未记录发布日期";
              return (
                <button
                  className={`library-row paper-library-row ${activeId === item.id ? "active" : ""}`}
                  key={item.id}
                  onClick={() => {
                    if (onSelectPaper) {
                      onSelectPaper(item.id);
                      return;
                    }
                    setActiveId(Number(item.id));
                  }}
                  type="button"
                >
                  <span className="paper-row-main">
                    <strong>{item.title}</strong>
                    <span>{authors || item.venue || paperIdentity(item)}</span>
                    <span>{paperIdentity(item)} · {published}</span>
                  </span>
                  <span className="paper-row-pills">
                    <span className={`paper-pill paper-status-${itemStatusTone}`}>{statusLabel(item.library_status)}</span>
                    <span className="paper-pill paper-count-pill">{item.asset_count || 0} 资产</span>
                    <span className="paper-pill paper-count-pill">{item.chunk_count || 0} 正文块</span>
                    <span className="paper-pill paper-count-pill">{item.artifact_count || 0} 产物</span>
                  </span>
                </button>
              );
            }) : (
              <div className="paper-empty-state">
                <strong>暂无论文</strong>
                <p>{status || sourceType || query || dateFrom || dateTo ? "当前筛选没有匹配项。" : "导入或保存的论文会显示在这里。"}</p>
              </div>
            )
          )}
        </div>
        <div className="pagination-row paper-pagination-row">
          <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">上一页</button>
          <span>第 {currentPage} 页，共 {pageCount} 页</span>
          <button disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} type="button">下一页</button>
        </div>
      </section>

      <section className="detail-panel library-detail-panel">
        {detailLoading ? (
          <LoadingPanel description="正在打开首篇论文的摘要、资产和正文片段。" rows={7} title="读取论文详情" />
        ) : paper ? (
          <article className="detail-card paper-reader-card">
            <header className="paper-reader-head">
              <div className="paper-reader-title">
                <div className="paper-meta-row">
                  <span className={`paper-pill paper-status-${STATUS_TONES[paper.library_status] || "slate"}`}>{statusLabel(paper.library_status)}</span>
                  <span className="paper-pill paper-source-pill">{sourceLabel(mainSource?.source_type)}</span>
                  {paper.year ? <span className="paper-pill paper-year-pill">{paper.year}</span> : null}
                  {paperReport?.status ? <span className={`paper-pill report-status-${safeToken(paperReport.status)}`}>报告：{reportStatusLabel(paperReport.status)}</span> : null}
                </div>
                <h2>{paper.title}</h2>
                <p>{(paper.authors || []).slice(0, 8).join(", ") || "未记录作者"}</p>
                <p className="muted">{paperIdentity(paper)} · 更新于 {fmtDate(paper.updated_at)}</p>
              </div>
              <div className="paper-reader-actions">
                {paperReport?.paper_id ? (
                  <button className="primary" onClick={() => onOpenReportQueue?.(paperReport.paper_id)} type="button">
                    打开报告队列
                  </button>
                ) : null}
                <div className="paper-status-actions" aria-label="论文状态">
                  <button disabled={busy || paper.library_status === "saved"} onClick={() => updateStatus("saved")} type="button">保存</button>
                  <button disabled={busy || paper.library_status === "reading"} onClick={() => updateStatus("reading")} type="button">阅读中</button>
                  <button disabled={busy || paper.library_status === "read"} onClick={() => updateStatus("read")} type="button">已读</button>
                  <button className="danger" disabled={busy || paper.library_status === "discarded"} onClick={() => updateStatus("discarded")} type="button">丢弃</button>
                </div>
              </div>
            </header>
            <div className="paper-reader-body">
              <section className="paper-abstract-section">
                <h3>摘要</h3>
                <p>{paper.abstract || "暂无摘要。"}</p>
              </section>
              <section className="paper-facts-grid" aria-label="论文指标">
                <div>
                  <span>来源</span>
                  <strong>{sourceLabel(mainSource?.source_type)}</strong>
                  <p>{mainSource?.source_identifier || mainSource?.source_url || "未记录"}</p>
                </div>
                <div>
                  <span>项目</span>
                  <strong>{linkedProjects.length}</strong>
                  <p>已关联项目</p>
                </div>
                <div>
                  <span>资产</span>
                  <strong>{assets.length}</strong>
                  <p>PDF、URL 或缓存文件</p>
                </div>
                <div>
                  <span>正文</span>
                  <strong>{chunks.length}</strong>
                  <p>已索引正文块</p>
                </div>
              </section>
              <div className="paper-detail-grid">
                <section className="paper-info-section">
                  <div className="paper-section-title">
                    <h3>项目关联</h3>
                    <span>{linkedProjects.length}</span>
                  </div>
                  <div className="paper-item-list">
                    {linkedProjects.length ? linkedProjects.map((project) => (
                      <article className="paper-info-item" key={project.project_id}>
                        <strong>{project.project_name}</strong>
                        <p>{project.relation} · {project.note || "已关联"}</p>
                      </article>
                    )) : <p className="muted">暂无项目关联。</p>}
                  </div>
                </section>
                <section className="paper-info-section">
                  <div className="paper-section-title">
                    <h3>产物</h3>
                    <span>{artifacts.length}</span>
                  </div>
                  <div className="paper-item-list">
                    {artifacts.length ? artifacts.slice(0, 6).map((artifact) => (
                      <a className="paper-info-item paper-info-link" href={`/artifacts/${artifact.id}`} key={artifact.id}>
                        <strong>{artifact.title}</strong>
                        <p>{artifact.artifact_type} · {artifact.status} · {fmtDate(artifact.updated_at)}</p>
                      </a>
                    )) : <p className="muted">暂无论文产物。</p>}
                  </div>
                </section>
                <section className="paper-info-section">
                  <div className="paper-section-title">
                    <h3>资产和来源</h3>
                    <span>{sources.length + assets.length}</span>
                  </div>
                  <div className="paper-item-list">
                    {sources.map((source) => (
                      <article className="paper-info-item" key={`source-${source.id}`}>
                        <strong>{sourceLabel(source.source_type)}</strong>
                        <p>{source.source_identifier || source.source_url || "未记录"}</p>
                      </article>
                    ))}
                    {assets.map((asset) => (
                      <article className="paper-info-item" key={`asset-${asset.id}`}>
                        <strong>{asset.asset_type} · {ASSET_STATUS_LABELS[asset.status] || asset.status || "状态未知"}</strong>
                        <p>{asset.path || asset.url || asset.error_message || "未记录路径"}</p>
                      </article>
                    ))}
                    {!(sources.length + assets.length) ? <p className="muted">暂无资产或来源记录。</p> : null}
                  </div>
                </section>
                <section className="paper-info-section paper-chunk-section">
                  <div className="paper-section-title">
                    <h3>正文片段</h3>
                    <span>{chunks.length}</span>
                  </div>
                  <div className="paper-item-list">
                    {chunks.slice(0, 5).map((chunk) => (
                      <article className="paper-info-item" key={chunk.id}>
                        <strong>Chunk {chunk.chunk_index}{chunk.page_start ? ` · p.${chunk.page_start}` : ""}</strong>
                        <p>{snippet(chunk.text, 260)}</p>
                      </article>
                    ))}
                    {!chunks.length ? <p className="muted">暂无正文块。</p> : null}
                  </div>
                </section>
              </div>
            </div>
          </article>
        ) : (
          <div className="empty-detail paper-empty-detail">
            <h2>选择一篇论文</h2>
            <p>论文状态、来源、资产和关联项目会显示在这里。</p>
          </div>
        )}
      </section>
    </section>
  );
}
