import { useEffect, useMemo, useRef, useState } from "react";

import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, fmtDate, postJson, snippet } from "../lib/dashboard.js";
import { commitPaperListSelection, resolvePaperListSelection } from "../lib/paperSelection.js";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import { WORKSPACE_PAGE_SIZE_OPTIONS, WorkspacePagination } from "./WorkspacePagination.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/PaperLibraryView.css";

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

const REPORT_PRESENCE = [
  ["", "全部报告"],
  ["with", "有报告"],
  ["without", "无报告"]
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

function paperListSource(paper) {
  if (paper?.arxiv_id || String(paper?.canonical_key || "").startsWith("arxiv:")) return "arxiv";
  if (String(paper?.canonical_key || "").startsWith("upload:")) return "upload";
  if (String(paper?.canonical_key || "").startsWith("url:")) return "url";
  return paper?.source_type || "manual";
}

export function PaperLibraryView({ onOpenReportQueue, onSelectPaper, selectedPaperId, setStatusMessage }) {
  const cache = useApiCacheClient();
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [reportPresence, setReportPresence] = useState("");
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [busy, setBusy] = useState(false);
  const selectFirstFromNextList = useRef(false);

  const queryString = useMemo(() => {
    const offset = (page - 1) * pageSize;
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    if (status) params.set("status", status);
    if (sourceType) params.set("source_type", sourceType);
    if (reportPresence) params.set("report_presence", reportPresence);
    if (query.trim()) params.set("q", query.trim());
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    return params.toString();
  }, [dateFrom, dateTo, page, pageSize, query, reportPresence, sourceType, status]);

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
  const detailResult = detailQuery.data || null;
  const detailMatchesActivePaper = Boolean(detailResult?.paper?.id)
    && Number(detailResult.paper.id) === Number(activeId);
  const detail = detailMatchesActivePaper ? detailResult : null;
  const loading = !listQuery.hasData;
  const detailLoading = Boolean(activeId) && (!detailQuery.hasData || !detailMatchesActivePaper);

  useEffect(() => {
    if (!listQuery.hasData) return;
    const shouldFollowNewList = selectFirstFromNextList.current;
    const routePaperId = Number(selectedPaperId || 0);
    const nextId = resolvePaperListSelection({
      activeId,
      items,
      routePaperId,
      selectFirst: shouldFollowNewList
    });
    selectFirstFromNextList.current = false;
    if (!nextId) {
      setActiveId(null);
      return;
    }
    if (Number(activeId) !== Number(nextId)) setActiveId(Number(nextId));
    if (routePaperId !== Number(nextId)) onSelectPaper?.(nextId, { replace: true });
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
  const selectedReportLabel = REPORT_PRESENCE.find(([value]) => value === reportPresence)?.[1] || "全部报告";
  const searchLabel = query.trim() ? `搜索：${query.trim()}` : "未搜索";
  const dateRangeLabel = dateFrom || dateTo ? `${dateFrom || "不限"} 至 ${dateTo || "不限"}` : "全部日期";
  const activeFilterCount = [status, sourceType, reportPresence, query.trim(), dateFrom, dateTo].filter(Boolean).length;
  const activeFilterLabels = [
    status ? selectedStatusLabel : "",
    sourceType ? selectedSourceLabel : "",
    reportPresence ? selectedReportLabel : "",
    query.trim() ? searchLabel : "",
    dateFrom || dateTo ? dateRangeLabel : ""
  ].filter(Boolean);

  useEffect(() => {
    // A new page starts with an empty cache entry. Do not treat that loading
    // window as a real one-page result and immediately bounce back to page 1.
    if (!listQuery.hasData) return;
    if (page > pageCount) {
      selectFirstFromNextList.current = true;
      setPage(pageCount);
    }
  }, [listQuery.hasData, page, pageCount]);

  function updateFilter(setter, value) {
    selectFirstFromNextList.current = true;
    setter(value);
    setPage(1);
  }

  function goToPage(nextPage) {
    const normalizedPage = Math.max(1, Math.min(pageCount, nextPage));
    if (normalizedPage === page) return;
    selectFirstFromNextList.current = true;
    setPage(normalizedPage);
  }

  function selectLibraryPaper(paperId) {
    commitPaperListSelection({
      onRouteSelect: onSelectPaper,
      onSelectLocal: setActiveId,
      paperId
    });
  }

  async function refresh() {
    await Promise.all([
      listQuery.refresh({ force: true }),
      activeId ? detailQuery.refresh({ force: true }) : Promise.resolve()
    ]);
  }

  return (
    <section className="view library-view paper-library-view vision-library">
      <header className="vision-topbar library-topbar">
        <div className="vision-brand">
          <span>论文工作区</span>
          <h1>论文仓库</h1>
        </div>
        <div className="vision-top-actions">
          <span className="vision-live-state ready"><i aria-hidden="true" />{loading ? "读取仓库" : `${total} 篇论文`}</span>
          <RefreshButton className="vision-refresh" busy={listQuery.status === "loading"} onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
        </div>
      </header>

      <main className="library-workspace-grid">
        <section className="library-list-panel paper-library-list-panel">
          <header className="paper-library-header library-list-heading">
          <div>
              <span className="paper-library-eyebrow">馆藏目录</span>
              <h2>论文列表</h2>
          </div>
            <div className="library-list-heading-actions">
              <em>{loading ? "…" : total}</em>
              <WorkspacePagination
                compact
                currentPage={currentPage}
                loading={listQuery.status === "loading"}
                onNext={() => goToPage(page + 1)}
                onPrevious={() => goToPage(page - 1)}
                pageCount={pageCount}
              />
            </div>
          </header>
          <div className="paper-filter-stack">
          <div className="paper-filter-summary">
              <div className="paper-active-filters">
                {activeFilterLabels.length
                  ? activeFilterLabels.map((label) => <span key={label}>{label}</span>)
                  : <span>全部论文</span>}
              </div>
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
          <div
            aria-hidden={!filtersOpen}
            className={`paper-filter-collapse ${filtersOpen ? "is-open" : ""}`}
            id="paper-library-filter-panel"
            inert={!filtersOpen}
          >
            <div className="library-toolbar paper-library-toolbar" aria-label="论文筛选">
              <div className="library-filter-control paper-filter-control">
                <span>状态</span>
                <WorkspaceSelect ariaLabel="筛选论文状态" onChange={(nextValue) => updateFilter(setStatus, nextValue)} options={STATUSES} value={status} />
              </div>
              <div className="library-filter-control paper-filter-control">
                <span>来源</span>
                <WorkspaceSelect ariaLabel="筛选论文来源" onChange={(nextValue) => updateFilter(setSourceType, nextValue)} options={SOURCES} value={sourceType} />
              </div>
              <div className="library-filter-control paper-filter-control">
                <span>全文报告</span>
                <WorkspaceSelect ariaLabel="筛选全文报告" onChange={(nextValue) => updateFilter(setReportPresence, nextValue)} options={REPORT_PRESENCE} value={reportPresence} />
              </div>
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
              <div className="library-filter-control paper-filter-control">
                <span>每页</span>
                <WorkspaceSelect
                  ariaLabel="每页论文数量"
                  onChange={(nextValue) => { selectFirstFromNextList.current = true; setPageSize(Number(nextValue)); setPage(1); }}
                  options={WORKSPACE_PAGE_SIZE_OPTIONS}
                  value={String(pageSize)}
                />
              </div>
            </div>
          </div>
          </div>
          <div className="library-list paper-library-list">
          {loading ? (
            <WorkspacePaneLoader rows={6} title="读取论文列表" variant="list" />
          ) : (
            items.length ? items.map((item) => {
              const itemStatusTone = STATUS_TONES[item.library_status] || "slate";
              const authors = Array.isArray(item.authors) ? item.authors.slice(0, 3).join(", ") : "";
              const published = item.published_at ? fmtDate(item.published_at) : "未记录发布日期";
              return (
                <article
                  className={`inbox-paper-row library-paper-row-card ${activeId === item.id ? "active" : ""}`}
                  key={item.id}
                  onClick={() => selectLibraryPaper(item.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    selectLibraryPaper(item.id);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="inbox-paper-row-head">
                    <span className={`paper-pill paper-status-${itemStatusTone}`}>{statusLabel(item.library_status)}</span>
                    <span className="library-card-asset-state">{item.chunk_count || 0} 正文块</span>
                  </div>
                  <h2>{item.title}</h2>
                  <div className="inbox-project-match library-card-context">
                    <strong>馆藏信息</strong>
                    <div>
                      <span>{sourceLabel(paperListSource(item))}</span>
                      {item.year ? <span>{item.year}</span> : null}
                      <span>{item.asset_count || 0} 项资产</span>
                      <span>{item.artifact_count || 0} 项产物</span>
                    </div>
                  </div>
                  <div className="inbox-paper-meta">
                    <span>{paperIdentity(item)}</span>
                    <span>{published}</span>
                    {authors || item.venue ? <span>{authors || item.venue}</span> : null}
                  </div>
                </article>
              );
            }) : (
              <div className="paper-empty-state">
                <strong>暂无论文</strong>
                <p>{status || sourceType || reportPresence || query || dateFrom || dateTo ? "当前筛选没有匹配项。" : "导入或保存的论文会显示在这里。"}</p>
              </div>
            )
          )}
          </div>
          <WorkspacePagination
            currentPage={currentPage}
            loading={listQuery.status === "loading"}
            onNext={() => goToPage(page + 1)}
            onPrevious={() => goToPage(page - 1)}
            pageCount={pageCount}
          />
        </section>

        <section className="detail-panel library-detail-panel">
        {detailLoading ? (
          <WorkspacePaneLoader description="正在打开首篇论文的摘要、资产和正文片段。" title="读取论文详情" variant="detail" />
        ) : paper ? (
          <article className="inbox-detail-card library-paper-detail library-detail-transition" key={paper.id}>
            <div className="detail-main library-detail-main">
            <header className="detail-title inbox-detail-title library-detail-title">
              <div className="library-detail-hero-copy">
                <span className="library-detail-eyebrow">馆藏论文 · {paperIdentity(paper)}</span>
                <h2>{paper.title}</h2>
                <p className="library-detail-authors">{(paper.authors || []).slice(0, 8).join(", ") || "未记录作者"}</p>
                <div className="inbox-detail-meta library-detail-meta">
                  <span className={`paper-pill paper-status-${STATUS_TONES[paper.library_status] || "slate"}`}>{statusLabel(paper.library_status)}</span>
                  <span className="paper-pill paper-source-pill">{sourceLabel(mainSource?.source_type)}</span>
                  {paper.year ? <span className="paper-pill paper-year-pill">{paper.year}</span> : null}
                  {paperReport?.status ? <span className={`paper-pill report-status-${safeToken(paperReport.status)}`}>报告：{reportStatusLabel(paperReport.status)}</span> : null}
                  <span>{paper.venue || "未记录发表场所"}</span>
                  <span>更新于 {fmtDate(paper.updated_at)}</span>
                  {paperReport?.paper_id ? (
                    <button className="library-hero-action" onClick={() => onOpenReportQueue?.(paperReport.paper_id)} type="button">
                      打开报告队列
                    </button>
                  ) : null}
                </div>
              </div>
            </header>

            <section className="library-detail-stat-grid" aria-label="论文关键数据">
              <div><span>关联项目</span><strong>{linkedProjects.length}</strong><p>研究项目</p></div>
              <div><span>本地资产</span><strong>{assets.length}</strong><p>文件与缓存</p></div>
              <div><span>正文索引</span><strong>{chunks.length}</strong><p>可检索块</p></div>
              <div><span>研究产物</span><strong>{artifacts.length}</strong><p>报告与笔记</p></div>
            </section>

            <div className="library-detail-content">
              <section className="section inbox-content-section library-content-card library-abstract-card">
                <header className="library-section-heading">
                  <div><span>论文概览</span><h3>摘要</h3></div>
                  <em>{paper.year || "—"}</em>
                </header>
                <p>{paper.abstract || "暂无摘要。"}</p>
              </section>

              <section className="section inbox-content-section library-content-card library-status-card">
                <header className="library-section-heading">
                  <div><span>阅读管理</span><h3>论文状态</h3></div>
                  <em>{statusLabel(paper.library_status)}</em>
                </header>
                <p>更新当前论文在研究工作流中的位置。</p>
                <div className="paper-status-actions library-status-actions" aria-label="论文状态">
                  <button disabled={busy || paper.library_status === "saved"} onClick={() => updateStatus("saved")} type="button"><i className="status-dot saved" />保存</button>
                  <button disabled={busy || paper.library_status === "reading"} onClick={() => updateStatus("reading")} type="button"><i className="status-dot reading" />阅读中</button>
                  <button disabled={busy || paper.library_status === "read"} onClick={() => updateStatus("read")} type="button"><i className="status-dot read" />已读</button>
                  <button className="danger" disabled={busy || paper.library_status === "discarded"} onClick={() => updateStatus("discarded")} type="button"><i className="status-dot discarded" />丢弃</button>
                </div>
              </section>

              <div className="library-detail-card-grid">
                <section className="section inbox-content-section library-content-card">
                  <header className="library-section-heading">
                    <div><span>研究脉络</span><h3>项目关联</h3></div>
                    <em>{linkedProjects.length}</em>
                  </header>
                  <div className="paper-item-list">
                    {linkedProjects.length ? linkedProjects.map((project) => (
                      <article className="paper-info-item" key={project.project_id}>
                        <strong>{project.project_name}</strong>
                        <p>{project.relation} · {project.note || "已关联"}</p>
                      </article>
                    )) : <p className="muted">暂无项目关联。</p>}
                  </div>
                </section>
                <section className="section inbox-content-section library-content-card">
                  <header className="library-section-heading">
                    <div><span>研究输出</span><h3>论文产物</h3></div>
                    <em>{artifacts.length}</em>
                  </header>
                  <div className="paper-item-list">
                    {artifacts.length ? artifacts.slice(0, 6).map((artifact) => (
                      <a className="paper-info-item paper-info-link" href={`/artifacts/${artifact.id}`} key={artifact.id}>
                        <strong>{artifact.title}</strong>
                        <p>{artifact.artifact_type} · {artifact.status} · {fmtDate(artifact.updated_at)}</p>
                      </a>
                    )) : <p className="muted">暂无论文产物。</p>}
                  </div>
                </section>
                <section className="section inbox-content-section library-content-card">
                  <header className="library-section-heading">
                    <div><span>数据完整度</span><h3>资产和来源</h3></div>
                    <em>{sources.length + assets.length}</em>
                  </header>
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
                <section className="section inbox-content-section library-content-card paper-chunk-section">
                  <header className="library-section-heading">
                    <div><span>全文索引</span><h3>正文片段</h3></div>
                    <em>{chunks.length}</em>
                  </header>
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
            </div>
          </article>
        ) : (
          <div className="empty-detail paper-empty-detail">
            <h2>选择一篇论文</h2>
            <p>论文状态、来源、资产和关联项目会显示在这里。</p>
          </div>
        )}
        </section>
      </main>
    </section>
  );
}
