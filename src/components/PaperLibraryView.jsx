import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, fmtDate, postJson, snippet } from "../lib/dashboard.js";
import { paperImportanceLabel, paperImportanceOptions } from "../lib/paperImportance.js";
import { commitPaperListSelection, resolvePaperListSelection } from "../lib/paperSelection.js";
import { paperSourceFilterLabel, paperSourceFilterOptions } from "../lib/paperSource.js";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import { useWorkspacePageSizeOptions, WorkspacePagination } from "./WorkspacePagination.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/PaperLibraryView.css";

const STATUS_CODES = ["", "candidate", "saved", "reading", "read", "archived", "discarded"];
const REPORT_PRESENCE_CODES = ["", "with", "without"];
const LIBRARY_SORT_CODES = ["updated", "importance"];
const STATUS_TONES = {
  archived: "slate",
  candidate: "blue",
  discarded: "red",
  read: "green",
  reading: "gold",
  saved: "teal"
};
function statusLabel(status, t) {
  return t(`library.status.${status || "unknown"}`, { defaultValue: status || t("library.status.unknown") });
}

function reportStatusLabel(status, t) {
  return t(`reportStatus.${status || "missing"}`, { defaultValue: status || t("reportStatus.missing") });
}

function sourceLabel(sourceType, t) {
  return t(`library.sourceType.${sourceType || "unknown"}`, { defaultValue: sourceType || t("library.sourceType.unknown") });
}

function safeToken(value, fallback = "unknown") {
  const token = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return token || fallback;
}

function primarySource(sources = []) {
  if (!Array.isArray(sources) || !sources.length) return null;
  return sources.find((source) => source.source_type === "arxiv") || sources[0];
}

function paperIdentity(paper, fallback) {
  return paper?.arxiv_id || paper?.doi || paper?.canonical_key || fallback;
}

function paperListSource(paper) {
  if (paper?.arxiv_id || String(paper?.canonical_key || "").startsWith("arxiv:")) return "arxiv";
  if (String(paper?.canonical_key || "").startsWith("upload:")) return "upload";
  if (String(paper?.canonical_key || "").startsWith("url:")) return "url";
  return paper?.source_type || "manual";
}

export function PaperLibraryView({ onOpenReportQueue, onSelectPaper, selectedPaperId, setStatusMessage }) {
  const { t, i18n } = useTranslation("papers");
  const pageSizeOptions = useWorkspacePageSizeOptions();
  const cache = useApiCacheClient();
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [reportPresence, setReportPresence] = useState("");
  const [importance, setImportance] = useState("");
  const [sort, setSort] = useState("updated");
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
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    if (reportPresence) params.set("report_presence", reportPresence);
    if (importance) params.set("importance", importance);
    if (sort !== "updated") params.set("sort", sort);
    if (query.trim()) params.set("q", query.trim());
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    return params.toString();
  }, [dateFrom, dateTo, importance, page, pageSize, query, reportPresence, sort, sourceFilter, status]);

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
      setStatusMessage(t("library.messages.statusUpdated", { status: statusLabel(nextStatus, t) }));
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
  const statusOptions = STATUS_CODES.map((value) => [value, t(`library.status.${value || "all"}`)]);
  const reportPresenceOptions = REPORT_PRESENCE_CODES.map((value) => [value, t(`library.reportPresence.${value || "all"}`)]);
  const librarySortOptions = LIBRARY_SORT_CODES.map((value) => [value, t(`library.sort.${value}`)]);
  const sourceFilterOptions = paperSourceFilterOptions(t);
  const importanceOptions = paperImportanceOptions(t);
  const selectedStatusLabel = status ? statusLabel(status, t) : t("library.status.allStates");
  const selectedSourceLabel = paperSourceFilterLabel(sourceFilter, t);
  const selectedReportLabel = reportPresenceOptions.find(([value]) => value === reportPresence)?.[1] || t("library.reportPresence.all");
  const selectedImportanceLabel = importanceOptions.find(([value]) => value === importance)?.[1] || t("importance.all");
  const selectedSortLabel = librarySortOptions.find(([value]) => value === sort)?.[1] || t("library.sort.updated");
  const searchLabel = query.trim() ? t("library.filters.searchValue", { query: query.trim() }) : t("library.filters.notSearched");
  const dateRangeLabel = dateFrom || dateTo ? t("library.filters.dateRange", { from: dateFrom || t("common.unlimited"), to: dateTo || t("common.unlimited") }) : t("library.filters.allDates");
  const activeFilterCount = [status, sourceFilter !== "all", reportPresence, importance, sort !== "updated", query.trim(), dateFrom, dateTo].filter(Boolean).length;
  const activeFilterLabels = [
    status ? selectedStatusLabel : "",
    sourceFilter !== "all" ? selectedSourceLabel : "",
    reportPresence ? selectedReportLabel : "",
    importance ? t("library.filters.importanceValue", { value: selectedImportanceLabel }) : "",
    sort !== "updated" ? t("library.filters.sortValue", { value: selectedSortLabel }) : "",
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

  function clearFilters() {
    selectFirstFromNextList.current = true;
    setStatus("");
    setSourceFilter("all");
    setReportPresence("");
    setImportance("");
    setSort("updated");
    setQuery("");
    setDateFrom("");
    setDateTo("");
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
          <span>{t("common.workspace")}</span>
          <h1>{t("library.title")}</h1>
        </div>
        <div className="vision-top-actions">
          <span className="vision-live-state ready"><i aria-hidden="true" />{loading ? t("library.live.loading") : t("library.live.count", { count: total })}</span>
          <RefreshButton className="vision-refresh" busy={listQuery.status === "loading"} onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
        </div>
      </header>

      <main className="library-workspace-grid">
        <section className="library-list-panel paper-library-list-panel">
          <header className="paper-library-header library-list-heading">
          <div>
              <span className="paper-library-eyebrow">{t("library.list.eyebrow")}</span>
              <h2>{t("library.list.title")}</h2>
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
                  : <span>{t("library.filters.allPapers")}</span>}
              </div>
            <div className="paper-filter-summary-actions">
              {activeFilterCount ? (
                <button className="filter-clear-button" onClick={clearFilters} type="button">{t("common.clearFilters")}</button>
              ) : null}
              <button
                aria-controls="paper-library-filter-panel"
                aria-expanded={filtersOpen}
                className="left-filter-toggle"
                onClick={() => setFiltersOpen((current) => !current)}
                type="button"
              >
                {filtersOpen ? t("common.collapseFilters") : t("common.filters", { count: activeFilterCount || "" })}
              </button>
            </div>
          </div>
          <div
            aria-hidden={!filtersOpen}
            className={`paper-filter-collapse ${filtersOpen ? "is-open" : ""}`}
            id="paper-library-filter-panel"
            inert={!filtersOpen}
          >
            <div className="library-toolbar paper-library-toolbar" aria-label={t("library.filters.aria")}>
              <div className="library-filter-control paper-filter-control">
                <span>{t("common.status")}</span>
                <WorkspaceSelect ariaLabel={t("library.filters.statusAria")} onChange={(nextValue) => updateFilter(setStatus, nextValue)} options={statusOptions} value={status} />
              </div>
              <div className="library-filter-control paper-filter-control">
                <span>{t("common.source")}</span>
                <WorkspaceSelect ariaLabel={t("library.filters.sourceAria")} onChange={(nextValue) => updateFilter(setSourceFilter, nextValue)} options={sourceFilterOptions} value={sourceFilter} />
              </div>
              <div className="library-filter-control paper-filter-control">
                <span>{t("common.fullReport")}</span>
                <WorkspaceSelect ariaLabel={t("library.filters.reportAria")} onChange={(nextValue) => updateFilter(setReportPresence, nextValue)} options={reportPresenceOptions} value={reportPresence} />
              </div>
              <div className="library-filter-control paper-filter-control">
                <span>{t("common.importance")}</span>
                <WorkspaceSelect ariaLabel={t("library.filters.importanceAria")} onChange={(nextValue) => updateFilter(setImportance, nextValue)} options={importanceOptions} value={importance} />
              </div>
              <div className="library-filter-control paper-filter-control">
                <span>{t("common.sort")}</span>
                <WorkspaceSelect ariaLabel={t("library.filters.sortAria")} onChange={(nextValue) => updateFilter(setSort, nextValue)} options={librarySortOptions} value={sort} />
              </div>
              <label className="library-filter-control library-search-control paper-filter-control paper-search-control">
                <span>{t("common.search")}</span>
                <input value={query} onChange={(event) => updateFilter(setQuery, event.target.value)} placeholder={t("library.filters.searchPlaceholder")} />
              </label>
              <label className="library-filter-control paper-filter-control">
                <span>{t("library.filters.dateFrom")}</span>
                <input type="date" value={dateFrom} onChange={(event) => updateFilter(setDateFrom, event.target.value)} />
              </label>
              <label className="library-filter-control paper-filter-control">
                <span>{t("library.filters.dateTo")}</span>
                <input type="date" value={dateTo} onChange={(event) => updateFilter(setDateTo, event.target.value)} />
              </label>
              <div className="library-filter-control paper-filter-control">
                <span>{t("common.perPage")}</span>
                <WorkspaceSelect
                  ariaLabel={t("library.filters.perPageAria")}
                  onChange={(nextValue) => { selectFirstFromNextList.current = true; setPageSize(Number(nextValue)); setPage(1); }}
                  options={pageSizeOptions}
                  value={String(pageSize)}
                />
              </div>
            </div>
          </div>
          </div>
          <div className="library-list paper-library-list">
          {loading ? (
            <WorkspacePaneLoader rows={6} title={t("library.list.loader")} variant="list" />
          ) : (
            items.length ? items.map((item) => {
              const itemStatusTone = STATUS_TONES[item.library_status] || "slate";
              const authors = Array.isArray(item.authors) ? item.authors.slice(0, 3).join(", ") : "";
              const published = item.published_at ? fmtDate(item.published_at, i18n.resolvedLanguage || i18n.language) : t("library.noPublishedDate");
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
                    <span className={`paper-pill paper-status-${itemStatusTone}`}>{statusLabel(item.library_status, t)}</span>
                    {item.importance ? <span className={`paper-pill paper-importance-${safeToken(item.importance)}`}>{t("library.importanceBadge", { value: paperImportanceLabel(item.importance, t) })}</span> : null}
                    <span className="library-card-asset-state">{t("library.chunkCount", { count: item.chunk_count || 0 })}</span>
                  </div>
                  <h2>{item.title}</h2>
                  <div className="inbox-project-match library-card-context">
                    <strong>{t("library.collectionInfo")}</strong>
                    <div>
                      <span>{sourceLabel(paperListSource(item), t)}</span>
                      {item.year ? <span>{item.year}</span> : null}
                      <span>{t("library.assetCount", { count: item.asset_count || 0 })}</span>
                      <span>{t("library.artifactCount", { count: item.artifact_count || 0 })}</span>
                    </div>
                  </div>
                  <div className="inbox-paper-meta">
                    <span>{paperIdentity(item, t("library.noIdentity"))}</span>
                    <span>{published}</span>
                    {authors || item.venue ? <span>{authors || item.venue}</span> : null}
                  </div>
                </article>
              );
            }) : (
              <div className="paper-empty-state">
                <strong>{t("library.empty.title")}</strong>
                <p>{status || sourceFilter !== "all" || reportPresence || importance || sort !== "updated" || query || dateFrom || dateTo ? t("library.empty.filtered") : t("library.empty.description")}</p>
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
          <WorkspacePaneLoader description={t("library.detail.loadingDescription")} title={t("library.detail.loadingTitle")} variant="detail" />
        ) : paper ? (
          <article className="inbox-detail-card library-paper-detail library-detail-transition" key={paper.id}>
            <div className="detail-main library-detail-main">
            <header className="detail-title inbox-detail-title library-detail-title">
              <div className="library-detail-hero-copy">
                <span className="library-detail-eyebrow">{t("library.detail.eyebrow", { id: paperIdentity(paper, t("library.noIdentity")) })}</span>
                <h2>{paper.title}</h2>
                <p className="library-detail-authors">{(paper.authors || []).slice(0, 8).join(", ") || t("common.noAuthors")}</p>
                <div className="inbox-detail-meta library-detail-meta">
                  <span className={`paper-pill paper-status-${STATUS_TONES[paper.library_status] || "slate"}`}>{statusLabel(paper.library_status, t)}</span>
                  {paper.importance ? <span className={`paper-pill paper-importance-${safeToken(paper.importance)}`}>{t("library.importanceBadge", { value: paperImportanceLabel(paper.importance, t) })}</span> : null}
                  <span className="paper-pill paper-source-pill">{sourceLabel(mainSource?.source_type, t)}</span>
                  {paper.year ? <span className="paper-pill paper-year-pill">{paper.year}</span> : null}
                  {paperReport?.status ? <span className={`paper-pill report-status-${safeToken(paperReport.status)}`}>{t("library.reportBadge", { status: reportStatusLabel(paperReport.status, t) })}</span> : null}
                  <span>{paper.venue || t("library.noVenue")}</span>
                  <span>{t("common.updatedAt", { date: fmtDate(paper.updated_at, i18n.resolvedLanguage || i18n.language) })}</span>
                </div>
                {paperReport?.paper_id ? (
                  <div className="library-detail-hero-actions">
                    <button className="library-report-action" onClick={() => onOpenReportQueue?.(paperReport.paper_id)} type="button">
                      <span>{t("inbox.actions.openReport")}</span><i aria-hidden="true">→</i>
                    </button>
                  </div>
                ) : null}
              </div>
            </header>

            <section className="library-detail-stat-grid" aria-label={t("library.detail.statsAria")}>
              <div><span>{t("library.detail.linkedProjects")}</span><strong>{linkedProjects.length}</strong><p>{t("library.detail.researchProjects")}</p></div>
              <div><span>{t("library.detail.localAssets")}</span><strong>{assets.length}</strong><p>{t("library.detail.filesCache")}</p></div>
              <div><span>{t("library.detail.textIndex")}</span><strong>{chunks.length}</strong><p>{t("library.detail.searchableChunks")}</p></div>
              <div><span>{t("library.detail.researchArtifacts")}</span><strong>{artifacts.length}</strong><p>{t("library.detail.reportsNotes")}</p></div>
            </section>

            <div className="library-detail-content">
              <section className="section inbox-content-section library-content-card library-abstract-card">
                <header className="library-section-heading">
                  <div><span>{t("library.sections.overview")}</span><h3>{t("library.sections.abstract")}</h3></div>
                  <em>{paper.year || "—"}</em>
                </header>
                <p>{paper.abstract || t("library.noAbstract")}</p>
              </section>

              <section className="section inbox-content-section library-content-card library-status-card">
                <header className="library-section-heading">
                  <div><span>{t("library.sections.readingManagement")}</span><h3>{t("library.sections.paperStatus")}</h3></div>
                  <em>{statusLabel(paper.library_status, t)}</em>
                </header>
                <p>{t("library.statusDescription")}</p>
                <div className="paper-status-actions library-status-actions" aria-label={t("library.sections.paperStatus")}>
                  <button disabled={busy || paper.library_status === "saved"} onClick={() => updateStatus("saved")} type="button"><i className="status-dot saved" />{t("library.status.saved")}</button>
                  <button disabled={busy || paper.library_status === "reading"} onClick={() => updateStatus("reading")} type="button"><i className="status-dot reading" />{t("library.status.reading")}</button>
                  <button disabled={busy || paper.library_status === "read"} onClick={() => updateStatus("read")} type="button"><i className="status-dot read" />{t("library.status.read")}</button>
                  <button className="danger" disabled={busy || paper.library_status === "discarded"} onClick={() => updateStatus("discarded")} type="button"><i className="status-dot discarded" />{t("library.status.discardedAction")}</button>
                </div>
              </section>

              <div className="library-detail-card-grid">
                <section className="section inbox-content-section library-content-card">
                  <header className="library-section-heading">
                    <div><span>{t("library.sections.researchContext")}</span><h3>{t("library.sections.projectLinks")}</h3></div>
                    <em>{linkedProjects.length}</em>
                  </header>
                  <div className="paper-item-list">
                    {linkedProjects.length ? linkedProjects.map((project) => (
                      <a className="paper-info-item paper-info-link" href={`/projects/${encodeURIComponent(String(project.project_id))}`} key={project.project_id}>
                        <strong>{project.project_name}</strong>
                        <p>{t(`relation.${project.relation}`, { defaultValue: project.relation })}{project.importance ? ` · ${t("library.importanceBadge", { value: paperImportanceLabel(project.importance, t) })}` : ""} · {project.note || t("library.linked")}</p>
                      </a>
                    )) : <p className="muted">{t("library.noProjectLinks")}</p>}
                  </div>
                </section>
                <section className="section inbox-content-section library-content-card">
                  <header className="library-section-heading">
                    <div><span>{t("library.sections.researchOutput")}</span><h3>{t("library.sections.paperArtifacts")}</h3></div>
                    <em>{artifacts.length}</em>
                  </header>
                  <div className="paper-item-list">
                    {artifacts.length ? artifacts.slice(0, 6).map((artifact) => (
                      <a className="paper-info-item paper-info-link" href={`/artifacts/${artifact.id}`} key={artifact.id}>
                        <strong>{artifact.title}</strong>
                        <p>{artifact.artifact_type} · {t(`workflowState.${artifact.status}`, { defaultValue: artifact.status })} · {fmtDate(artifact.updated_at, i18n.resolvedLanguage || i18n.language)}</p>
                      </a>
                    )) : <p className="muted">{t("library.noArtifacts")}</p>}
                  </div>
                </section>
                <section className="section inbox-content-section library-content-card">
                  <header className="library-section-heading">
                    <div><span>{t("library.sections.dataCompleteness")}</span><h3>{t("library.sections.assetsSources")}</h3></div>
                    <em>{sources.length + assets.length}</em>
                  </header>
                  <div className="paper-item-list">
                    {sources.map((source) => (
                      <article className="paper-info-item" key={`source-${source.id}`}>
                        <strong>{sourceLabel(source.source_type, t)}</strong>
                        <p>{source.source_identifier || source.source_url || t("common.notRecorded")}</p>
                      </article>
                    ))}
                    {assets.map((asset) => (
                      <article className="paper-info-item" key={`asset-${asset.id}`}>
                        <strong>{asset.asset_type} · {t(`library.assetStatus.${asset.status || "unknown"}`, { defaultValue: asset.status || t("library.assetStatus.unknown") })}</strong>
                        <p>{asset.path || asset.url || asset.error_message || t("library.noPath")}</p>
                      </article>
                    ))}
                    {!(sources.length + assets.length) ? <p className="muted">{t("library.noAssetsSources")}</p> : null}
                  </div>
                </section>
                <section className="section inbox-content-section library-content-card paper-chunk-section">
                  <header className="library-section-heading">
                    <div><span>{t("library.sections.fullTextIndex")}</span><h3>{t("library.sections.textChunks")}</h3></div>
                    <em>{chunks.length}</em>
                  </header>
                  <div className="paper-item-list">
                    {chunks.slice(0, 5).map((chunk) => (
                      <article className="paper-info-item" key={chunk.id}>
                        <strong>{t("library.chunkLabel", { index: chunk.chunk_index })}{chunk.page_start ? ` · ${t("library.pageLabel", { page: chunk.page_start })}` : ""}</strong>
                        <p>{snippet(chunk.text, 260)}</p>
                      </article>
                    ))}
                    {!chunks.length ? <p className="muted">{t("library.noChunks")}</p> : null}
                  </div>
                </section>
              </div>
            </div>
            </div>
          </article>
        ) : (
          <div className="empty-detail paper-empty-detail">
            <h2>{t("library.detail.selectTitle")}</h2>
            <p>{t("library.detail.selectDescription")}</p>
          </div>
        )}
        </section>
      </main>
    </section>
  );
}
