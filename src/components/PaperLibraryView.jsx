import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, fmtDate, postJson, snippet } from "../lib/dashboard.js";
import { paperImportanceLabel, paperImportanceOptions } from "../lib/paperImportance.js";
import { paperImportNotificationFromJob, paperImportNotificationToastType } from "../lib/paperImportNotifications.js";
import { commitPaperListSelection, resolvePaperListSelection } from "../lib/paperSelection.js";
import { isRecentManualPaperImport, paperSourceFilterLabel, paperSourceFilterOptions } from "../lib/paperSource.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { PaperImportDialog } from "./PaperImportDialog.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import { useWorkspacePageSizeOptions, WorkspacePagination } from "./WorkspacePagination.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/PaperLibraryView.css";

const STATUS_CODES = ["", "candidate", "saved", "reading", "read", "archived", "discarded"];
const REPORT_STATUS_CODES = ["", "missing", "queued", "processing", "done", "failed", "cancelled"];
const LIBRARY_SORT_CODES = ["updated", "imported", "workflow", "importance"];
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

function latestByUpdatedAt(items = []) {
  return [...items].sort((left, right) => {
    const updatedOrder = String(right?.updated_at || "").localeCompare(String(left?.updated_at || ""));
    return updatedOrder || Number(right?.id || 0) - Number(left?.id || 0);
  })[0] || null;
}

function paperSourceUrl(sources = []) {
  return latestByUpdatedAt(sources.filter((source) => source?.source_url))?.source_url || "";
}

function paperPdfUrl(paperId, assets = []) {
  const pdfAsset = latestByUpdatedAt(assets.filter((asset) => asset?.asset_type === "pdf"));
  if (pdfAsset?.path) return `/api/reader/papers/${paperId}/pdf`;
  return pdfAsset?.url || "";
}

function paperIdentity(paper, fallback) {
  return paper?.arxiv_id || paper?.doi || paper?.canonical_key || fallback;
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function paperListSource(paper) {
  if (paper?.source_type) return paper.source_type;
  if (paper?.arxiv_id || String(paper?.canonical_key || "").startsWith("arxiv:")) return "arxiv";
  if (String(paper?.canonical_key || "").startsWith("upload:")) return "upload";
  if (String(paper?.canonical_key || "").startsWith("url:")) return "url";
  return paper?.source || "manual";
}

function importTypeLabel(importType, t) {
  return t(`library.importStatus.type.${importType || "unknown"}`, {
    defaultValue: importType || t("library.importStatus.type.unknown")
  });
}

function importStatusLabel(status, t) {
  return t(`library.importStatus.status.${status || "queued"}`, {
    defaultValue: status || t("library.importStatus.status.queued")
  });
}

function importTargetTitle(target, t) {
  const value = String(target || "").trim();
  if (!value) return t("library.importStatus.unknownTarget");
  try {
    const url = new URL(value);
    const pathPart = url.pathname.split("/").filter(Boolean).at(-1);
    return decodeURIComponent(pathPart || url.hostname) || value;
  } catch {
    return value;
  }
}

export function PaperLibraryView({
  importOpen = false,
  notify = () => {},
  onClosePaperImport,
  onOpenChat,
  onSelectPaper,
  selectedPaperId,
  setStatusMessage
}) {
  const { t, i18n } = useTranslation("papers");
  const pageSizeOptions = useWorkspacePageSizeOptions();
  const cache = useApiCacheClient();
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [reportStatusFilter, setReportStatusFilter] = useState("");
  const [importance, setImportance] = useState("");
  const [sort, setSort] = useState("updated");
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [busy, setBusy] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState("overview");
  const [linkingProjectId, setLinkingProjectId] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [recencyClock, setRecencyClock] = useState(() => Date.now());
  const [trackedImportJobIds, setTrackedImportJobIds] = useState([]);
  const selectFirstFromNextList = useRef(false);
  const pendingImportedPaperId = useRef(null);

  useEffect(() => {
    const timer = window.setInterval(() => setRecencyClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const queryString = useMemo(() => {
    const offset = (page - 1) * pageSize;
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    if (status) params.set("status", status);
    if (sourceFilter !== "all") params.set("source", sourceFilter);
    if (reportStatusFilter) params.set("report_status", reportStatusFilter);
    if (importance) params.set("importance", importance);
    if (sort !== "updated") params.set("sort", sort);
    if (query.trim()) params.set("q", query.trim());
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    return params.toString();
  }, [dateFrom, dateTo, importance, page, pageSize, query, reportStatusFilter, sort, sourceFilter, status]);

  const listQuery = useCachedApi(
    ["library", "list", queryString],
    () => api(`/api/library?${queryString}`),
    { staleTime: 60000 }
  );
  const importStatusQuery = useCachedApi(
    ["library", "imports"],
    () => api("/api/library/imports?limit=100"),
    { staleTime: 5000 }
  );
  const jobStatusQuery = useCachedApi(
    ["jobs", "status"],
    () => api("/api/jobs/status"),
    { staleTime: 5000 }
  );
  const listData = listQuery.data || { items: [], total: 0 };
  const items = listData.items || [];
  const total = Number(listData.total || 0);
  const importStatusData = importStatusQuery.data || {};
  const importStats = importStatusData.stats || {};
  const activeImportItems = importStatusData.active_items || [];
  const latestImport = importStatusData.latest || null;
  const pendingImportEntries = useMemo(() => activeImportItems.flatMap((item) => {
    const targets = Array.isArray(item.targets) && item.targets.length
      ? item.targets
      : [""];
    return targets.map((target, index) => ({
      importType: item.import_type,
      jobId: item.id,
      key: `import-${item.id}-${index}`,
      status: item.display_status || item.status,
      submittedAt: item.created_at,
      target,
      title: importTargetTitle(target, t)
    }));
  }), [activeImportItems, t]);
  const reportQueueStatus = jobStatusQuery.data?.scheduler?.paper_report_queue || {};

  useEffect(() => {
    if (!trackedImportJobIds.length) return undefined;
    const timer = window.setInterval(() => {
      importStatusQuery.refresh({ force: true }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [importStatusQuery.refresh, trackedImportJobIds.length]);

  useEffect(() => {
    if (!trackedImportJobIds.length || !importStatusQuery.hasData) return;
    const jobsById = new Map((importStatusData.items || []).map((item) => [Number(item.id), item]));
    const finishedIds = new Set();
    for (const jobId of trackedImportJobIds) {
      const notification = paperImportNotificationFromJob(jobsById.get(Number(jobId)));
      if (!notification) continue;
      notify(
        { kind: "system-notification", notification },
        { dedupeKey: notification.id, type: paperImportNotificationToastType(notification) }
      );
      finishedIds.add(Number(jobId));
    }
    if (finishedIds.size) {
      setTrackedImportJobIds((current) => current.filter((jobId) => !finishedIds.has(Number(jobId))));
    }
  }, [importStatusData.items, importStatusQuery.hasData, notify, trackedImportJobIds]);
  const detailQuery = useCachedApi(
    ["library", "detail", String(activeId || "")],
    () => api(`/api/library/${activeId}`),
    { enabled: Boolean(activeId), staleTime: 60000 }
  );
  const projectsQuery = useCachedApi(["projects"], () => api("/api/projects"), { staleTime: 60000 });
  const detailResult = detailQuery.data || null;
  const detailMatchesActivePaper = Boolean(detailResult?.paper?.id)
    && Number(detailResult.paper.id) === Number(activeId);
  const detail = detailMatchesActivePaper ? detailResult : null;
  const loading = !listQuery.hasData;
  const detailLoading = Boolean(activeId) && (!detailQuery.hasData || !detailMatchesActivePaper);

  useEffect(() => {
    if (!listQuery.hasData) return;
    const importedPaperId = Number(pendingImportedPaperId.current || 0);
    if (importedPaperId) {
      const importedPaperVisible = items.some((item) => Number(item.id) === importedPaperId);
      if (importedPaperVisible) {
        pendingImportedPaperId.current = null;
        setActiveId(importedPaperId);
        if (Number(selectedPaperId || 0) !== importedPaperId) onSelectPaper?.(importedPaperId, { replace: true });
        return;
      }
      if (listQuery.stale || listQuery.refreshing) return;
      pendingImportedPaperId.current = null;
    }
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
  }, [activeId, items, listQuery.hasData, listQuery.refreshing, listQuery.stale, onSelectPaper, selectedPaperId]);

  useEffect(() => {
    const error = listQuery.error || detailQuery.error || projectsQuery.error || importStatusQuery.error || jobStatusQuery.error;
    if (error) setStatusMessage(error.message);
  }, [detailQuery.error, importStatusQuery.error, jobStatusQuery.error, listQuery.error, projectsQuery.error, setStatusMessage]);

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

  async function refreshPaperData() {
    cache.markStale(cacheNamespace("library"));
    cache.markStale(cacheNamespace("reader", "papers"));
    cache.markStale(cacheNamespace("paper-reports"));
    await Promise.all([
      listQuery.refresh({ force: true }),
      importStatusQuery.refresh({ force: true }),
      jobStatusQuery.refresh({ force: true }),
      activeId ? detailQuery.refresh({ force: true }) : Promise.resolve()
    ]);
  }

  async function runReportAction(action) {
    if (!detail?.paper?.id || busy) return;
    const paperId = detail.paper.id;
    setBusy(true);
    try {
      if (action === "generate" || action === "regenerate") {
        await postJson(`/api/papers/${paperId}/report`, {
          force: action === "regenerate",
          locale: i18n.resolvedLanguage || i18n.language
        });
        setStatusMessage(t("library.report.messages.queued"));
      } else if (action === "cancel") {
        await postJson(`/api/reader/papers/${paperId}/cancel`, {});
        setStatusMessage(t("library.report.messages.cancelled"));
      } else if (action === "retry") {
        await postJson(`/api/reader/papers/${paperId}/retry`, {
          locale: i18n.resolvedLanguage || i18n.language
        });
        setStatusMessage(t("library.report.messages.requeued"));
      } else if (action === "delete") {
        if (!window.confirm(t("library.report.confirmDelete"))) return;
        await api(`/api/reader/papers/${paperId}/report`, { method: "DELETE" });
        setStatusMessage(t("library.report.messages.deleted"));
      }
      await refreshPaperData();
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function linkPaperToProject(projectId) {
    const paperId = Number(detail?.paper?.id || 0);
    const numericProjectId = Number(projectId || 0);
    if (!paperId || !numericProjectId || linkingProjectId) return;
    const project = (projectsQuery.data?.items || []).find((item) => Number(item.id) === numericProjectId);
    setLinkingProjectId(numericProjectId);
    try {
      await postJson(`/api/projects/${numericProjectId}/papers`, {
        paper_id: paperId,
        relation: "reading",
        note: "manual_from_paper_library"
      });
      cache.markStale(cacheNamespace("library"));
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["reader", "paper", String(paperId)]);
      cache.markStale(["project", String(numericProjectId)]);
      cache.markStale(["projects"]);
      await detailQuery.refresh({ force: true });
      setStatusMessage(t("reader.messages.projectLinked", { project: project?.name || "" }));
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLinkingProjectId(null);
    }
  }

  async function unlinkPaperFromProject(projectId) {
    const paperId = Number(detail?.paper?.id || 0);
    const numericProjectId = Number(projectId || 0);
    if (!paperId || !numericProjectId || linkingProjectId) return;
    const project = (projectsQuery.data?.items || []).find((item) => Number(item.id) === numericProjectId);
    setLinkingProjectId(numericProjectId);
    try {
      await api(`/api/projects/${numericProjectId}/papers/${paperId}`, { method: "DELETE" });
      cache.markStale(cacheNamespace("library"));
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["reader", "paper", String(paperId)]);
      cache.markStale(["project", String(numericProjectId)]);
      cache.markStale(["projects"]);
      await detailQuery.refresh({ force: true });
      setStatusMessage(t("reader.messages.projectUnlinked", { project: project?.name || "" }));
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setLinkingProjectId(null);
    }
  }

  async function savePaperTitle(event) {
    event.preventDefault();
    const paperId = Number(detail?.paper?.id || 0);
    const title = titleDraft.trim();
    if (!paperId || savingTitle) return;
    if (!title || title === String(detail.paper.title || "").trim()) {
      setTitleDraft(detail.paper.title || "");
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      const data = await api(`/api/reader/papers/${paperId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title })
      });
      const updatedAt = data?.paper?.updated_at || detail.paper.updated_at;
      detailQuery.patch((current) => ({
        ...(current || {}),
        paper: { ...(current?.paper || {}), title, updated_at: updatedAt }
      }));
      listQuery.patch((current) => ({
        ...(current || {}),
        items: (current?.items || []).map((item) => Number(item.id) === paperId ? { ...item, title, updated_at: updatedAt } : item)
      }));
      cache.markStale(cacheNamespace("reader", "papers"));
      cache.markStale(["reader", "paper", String(paperId)]);
      setEditingTitle(false);
      setStatusMessage(t("reader.messages.titleUpdated"));
    } catch (error) {
      setStatusMessage(error.message);
    } finally {
      setSavingTitle(false);
    }
  }

  const paper = detail?.paper;
  const paperReport = detail?.paper_report;
  const reportStatus = paperReport?.status || "missing";
  const sources = detail?.sources || [];
  const assets = detail?.assets || [];
  const chunks = detail?.chunks || [];
  const linkedProjects = detail?.linked_projects || [];
  const artifacts = detail?.artifacts || [];
  const projects = projectsQuery.data?.items || [];
  const mainSource = primarySource(sources);
  const pdfAsset = latestByUpdatedAt(assets.filter((asset) => asset?.asset_type === "pdf"));
  const textAsset = latestByUpdatedAt(assets.filter((asset) => asset?.asset_type === "text"));
  const categories = stringList(mainSource?.metadata?.categories);
  const sourceUrl = paperSourceUrl(sources);
  const pdfUrl = paperPdfUrl(paper?.id, assets);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const statusOptions = STATUS_CODES.map((value) => [value, t(`library.status.${value || "all"}`)]);
  const reportStatusOptions = REPORT_STATUS_CODES.map((value) => [value, t(`reportStatus.${value || "all"}`)]);
  const librarySortOptions = LIBRARY_SORT_CODES.map((value) => [value, t(`library.sort.${value}`)]);
  const sourceFilterOptions = paperSourceFilterOptions(t);
  const importanceOptions = paperImportanceOptions(t);
  const selectedStatusLabel = status ? statusLabel(status, t) : t("library.status.allStates");
  const selectedSourceLabel = paperSourceFilterLabel(sourceFilter, t);
  const selectedReportLabel = reportStatusOptions.find(([value]) => value === reportStatusFilter)?.[1] || t("reportStatus.all");
  const selectedImportanceLabel = importanceOptions.find(([value]) => value === importance)?.[1] || t("importance.all");
  const selectedSortLabel = librarySortOptions.find(([value]) => value === sort)?.[1] || t("library.sort.updated");
  const searchLabel = query.trim() ? t("library.filters.searchValue", { query: query.trim() }) : t("library.filters.notSearched");
  const dateRangeLabel = dateFrom || dateTo ? t("library.filters.dateRange", { from: dateFrom || t("common.unlimited"), to: dateTo || t("common.unlimited") }) : t("library.filters.allDates");
  const activeFilterCount = [status, sourceFilter !== "all", reportStatusFilter, importance, sort !== "updated", query.trim(), dateFrom, dateTo].filter(Boolean).length;
  const activeFilterLabels = [
    status ? selectedStatusLabel : "",
    sourceFilter !== "all" ? selectedSourceLabel : "",
    reportStatusFilter ? selectedReportLabel : "",
    importance ? t("library.filters.importanceValue", { value: selectedImportanceLabel }) : "",
    sort !== "updated" ? t("library.filters.sortValue", { value: selectedSortLabel }) : "",
    query.trim() ? searchLabel : "",
    dateFrom || dateTo ? dateRangeLabel : ""
  ].filter(Boolean);

  const linkedProjectIds = new Set(linkedProjects.map((item) => Number(item.project_id)));
  const projectLinkOptions = [
    ["", !projects.length ? t("reader.projectLink.noProjects") : linkingProjectId ? t("reader.projectLink.linking") : t("reader.projectLink.action")],
    ...projects.map((project) => ({
      disabled: linkedProjectIds.has(Number(project.id)),
      label: linkedProjectIds.has(Number(project.id)) ? t("reader.projectLink.linkedName", { name: project.name }) : project.name,
      value: String(project.id)
    }))
  ];

  useEffect(() => {
    setActiveDetailTab("overview");
    setEditingTitle(false);
  }, [paper?.id]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(paper?.title || "");
  }, [editingTitle, paper?.id, paper?.title]);

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
    setReportStatusFilter("");
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
      importStatusQuery.refresh({ force: true }),
      jobStatusQuery.refresh({ force: true }),
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
          <span className={`vision-live-state ${Number(reportQueueStatus.active || 0) ? "running" : "ready"}`}>
            <i aria-hidden="true" />
            {!jobStatusQuery.hasData
              ? t("library.queue.loading")
              : reportQueueStatus.enabled
                ? t("library.queue.capacity", { active: Number(reportQueueStatus.active || 0), capacity: Number(reportQueueStatus.concurrency || 0) })
                : t("library.queue.disabled")}
          </span>
          <RefreshButton className="vision-refresh" busy={listQuery.status === "loading" || importStatusQuery.status === "loading"} onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
        </div>
      </header>

      <section aria-label={t("library.importStatus.aria")} className="inbox-summary-strip library-import-summary-strip">
        <div>
          <span>{t("library.importStatus.queued")}</span>
          <strong>{importStatusQuery.hasData ? Number(importStats.queued || 0) : "—"}</strong>
          <p>{t("library.importStatus.queuedHint")}</p>
        </div>
        <div>
          <span>{t("library.importStatus.running")}</span>
          <strong>{importStatusQuery.hasData ? Number(importStats.running || 0) : "—"}</strong>
          <p>{t("library.importStatus.runningHint")}</p>
        </div>
        <div>
          <span>{t("library.importStatus.latest")}</span>
          <strong>{importStatusQuery.hasData ? importStatusLabel(latestImport?.status || "idle", t) : "—"}</strong>
          <p>{latestImport
            ? t(latestImport.status === "failed" ? "library.importStatus.latestFailed" : "library.importStatus.latestDetail", {
              count: Number(latestImport.imported_count || 0),
              type: importTypeLabel(latestImport.import_type, t)
            })
            : t("library.importStatus.noRecent")}</p>
        </div>
      </section>

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
                <WorkspaceSelect ariaLabel={t("library.filters.reportAria")} onChange={(nextValue) => updateFilter(setReportStatusFilter, nextValue)} options={reportStatusOptions} value={reportStatusFilter} />
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
            <>
            {pendingImportEntries.map((entry) => (
              <article aria-busy="true" className={`inbox-paper-row library-paper-row-card library-import-pending-row is-${safeToken(entry.status)}`} key={entry.key}>
                <div className="inbox-paper-row-head">
                  <span className={`paper-pill library-import-status-pill is-${safeToken(entry.status)}`}><i aria-hidden="true" />{importStatusLabel(entry.status, t)}</span>
                  <span className="paper-pill paper-source-pill">{importTypeLabel(entry.importType, t)}</span>
                  <span className="library-card-asset-state">{t("library.importStatus.job", { id: entry.jobId })}</span>
                </div>
                <h2 title={entry.target}>{entry.title}</h2>
                <div className="inbox-project-match library-card-context">
                  <strong>{t("library.importStatus.pendingTitle")}</strong>
                  <div><span>{entry.status === "running" ? t("library.importStatus.extracting") : t("library.importStatus.waiting")}</span></div>
                </div>
                <div className="inbox-paper-meta">
                  <span>{entry.target || t("library.importStatus.unknownTarget")}</span>
                  <span>{t("library.importStatus.submittedAt", { date: fmtDate(entry.submittedAt, i18n.resolvedLanguage || i18n.language) })}</span>
                </div>
              </article>
            ))}
            {items.length ? items.map((item) => {
              const itemStatusTone = STATUS_TONES[item.library_status] || "slate";
              const recentImport = isRecentManualPaperImport(item, recencyClock);
              const authors = Array.isArray(item.authors) ? item.authors.slice(0, 3).join(", ") : "";
              const published = item.published_at ? fmtDate(item.published_at, i18n.resolvedLanguage || i18n.language) : t("library.noPublishedDate");
              return (
                <article
                  className={`inbox-paper-row library-paper-row-card ${activeId === item.id ? "active" : ""} ${recentImport ? "recent-import" : ""}`}
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
                    <span className={`paper-pill report-status-${safeToken(item.paper_report?.status || "missing")}`}>{reportStatusLabel(item.paper_report?.status, t)}</span>
                    {recentImport ? <span className="library-recent-import-badge" title={t("library.recentImportTitle")}><i aria-hidden="true" />{t("library.recentImport")}</span> : null}
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
            }) : pendingImportEntries.length ? null : (
              <div className="paper-empty-state">
                <strong>{t("library.empty.title")}</strong>
                <p>{status || sourceFilter !== "all" || reportStatusFilter || importance || sort !== "updated" || query || dateFrom || dateTo ? t("library.empty.filtered") : t("library.empty.description")}</p>
              </div>
            )
            }</>
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
                <div className="paper-detail-actions">
                  <button className="paper-detail-action" onClick={() => onOpenChat?.(paper.id)} type="button">
                    <span>{t("library.actions.openChat")}</span><i aria-hidden="true">→</i>
                  </button>
                  {sourceUrl ? (
                    <a className="paper-detail-action" href={sourceUrl} target="_blank" rel="noreferrer" title={sourceUrl}>
                      <span>{t("reader.actions.openSource")}</span><i aria-hidden="true">↗</i>
                    </a>
                  ) : null}
                  {pdfUrl ? (
                    <a className="paper-detail-action" href={pdfUrl} target="_blank" rel="noreferrer">
                      <span>{t("reader.actions.openPdf")}</span><i aria-hidden="true">↗</i>
                    </a>
                  ) : null}
                </div>
              </div>
            </header>

            <div aria-label={t("library.tabs.aria")} className="library-detail-tabs" role="tablist">
              {[
                ["overview", "01", t("library.tabs.overview"), t("library.tabs.overviewBadge")],
                ["report", "02", t("library.tabs.report"), t("library.tabs.reportBadge")],
                ["metadata", "03", t("library.tabs.metadata"), t("library.tabs.metadataBadge")]
              ].map(([tab, index, label, badge]) => (
                <button
                  aria-controls={`library-${tab}-panel`}
                  aria-selected={activeDetailTab === tab}
                  className={activeDetailTab === tab ? "active" : ""}
                  id={`library-${tab}-tab`}
                  key={tab}
                  onClick={() => setActiveDetailTab(tab)}
                  role="tab"
                  type="button"
                >
                  <i aria-hidden="true">{index}</i><span><strong>{label}</strong><small>{badge}</small></span>
                </button>
              ))}
            </div>

            {activeDetailTab === "overview" ? (
              <div aria-labelledby="library-overview-tab" className="library-tab-panel" id="library-overview-panel" role="tabpanel">
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
                    <section className="section inbox-content-section library-content-card library-project-card">
                      <header className="library-section-heading">
                        <div><span>{t("library.sections.researchContext")}</span><h3>{t("library.sections.projectLinks")}</h3></div>
                        <em>{linkedProjects.length}</em>
                      </header>
                      <div className="library-project-link-control">
                        <span>{t("reader.projectLink.label")}</span>
                        <WorkspaceSelect
                          ariaLabel={t("reader.projectLink.aria")}
                          className="library-project-link-select"
                          disabled={!projects.length || Boolean(linkingProjectId)}
                          onChange={linkPaperToProject}
                          options={projectLinkOptions}
                          value=""
                        />
                      </div>
                      <div className="paper-item-list library-project-list">
                        {linkedProjects.length ? linkedProjects.map((project) => (
                          <article className="paper-info-item library-project-item" key={project.project_id}>
                            <a className="paper-info-link library-project-link" href={`/projects/${encodeURIComponent(String(project.project_id))}`}>
                              <strong>{project.project_name}</strong>
                              <p>{t(`relation.${project.relation}`, { defaultValue: project.relation })}{project.importance ? ` · ${t("library.importanceBadge", { value: paperImportanceLabel(project.importance, t) })}` : ""} · {project.note || t("reader.projectLink.manualNote")}</p>
                            </a>
                            <button className="library-project-unlink" disabled={Boolean(linkingProjectId)} onClick={() => unlinkPaperFromProject(project.project_id)} type="button">
                              {linkingProjectId === Number(project.project_id) ? t("reader.projectLink.linking") : t("reader.projectLink.unlink")}
                            </button>
                          </article>
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
                  </div>
                </div>
              </div>
            ) : null}

            {activeDetailTab === "report" ? (
              <section aria-labelledby="library-report-tab" className="section inbox-content-section library-content-card library-report-card library-tab-panel" id="library-report-panel" role="tabpanel">
                <header className="library-section-heading">
                  <div><span>{t("library.report.eyebrow")}</span><h3>{t("library.report.title")}</h3></div>
                  <em>{reportStatusLabel(reportStatus, t)}</em>
                </header>
                <div className={`library-report-state report-status-${safeToken(reportStatus)}`}>
                  <div>
                    <strong>{reportStatusLabel(reportStatus, t)}</strong>
                    {paperReport?.model ? <p>{paperReport.model_provider_id ? `${paperReport.model_provider_id} · ` : ""}{paperReport.model}</p> : null}
                    {paperReport?.error_message ? <p className="library-report-error">{paperReport.error_message}</p> : null}
                    {paperReport?.updated_at ? <p>{t("common.updatedAt", { date: fmtDate(paperReport.updated_at, i18n.resolvedLanguage || i18n.language) })}</p> : null}
                  </div>
                  <div className="library-report-controls">
                    {reportStatus === "missing" ? <button className="primary" disabled={busy} onClick={() => runReportAction("generate")} type="button">{t("library.report.actions.generate")}</button> : null}
                    {reportStatus === "queued" ? <button disabled={busy} onClick={() => runReportAction("cancel")} type="button">{t("library.report.actions.cancel")}</button> : null}
                    {["failed", "cancelled"].includes(reportStatus) ? <button className="primary" disabled={busy} onClick={() => runReportAction("retry")} type="button">{t("library.report.actions.retry")}</button> : null}
                    {reportStatus === "done" ? <button disabled={busy} onClick={() => runReportAction("regenerate")} type="button">{t("library.report.actions.regenerate")}</button> : null}
                    {paperReport && reportStatus !== "processing" ? <button className="danger" disabled={busy} onClick={() => runReportAction("delete")} type="button">{t("library.report.actions.delete")}</button> : null}
                  </div>
                </div>
                {reportStatus === "processing" || reportStatus === "queued" ? <p className="muted">{t("library.report.processingHint")}</p> : null}
                {reportStatus === "done" && paperReport?.report_markdown ? (
                  <div className="library-report-content"><LazyMarkdownReport markdown={paperReport.report_markdown} /></div>
                ) : reportStatus === "missing" ? <p className="muted">{t("library.report.empty")}</p> : null}
              </section>
            ) : null}

            {activeDetailTab === "metadata" ? (
              <div aria-labelledby="library-metadata-tab" className="library-tab-panel library-metadata-panel" id="library-metadata-panel" role="tabpanel">
                <section className="section inbox-content-section library-content-card library-metadata-card">
                  <header className="library-section-heading">
                    <div><span>{t("reader.meta.eyebrow")}</span><h3>{t("reader.meta.title")}</h3></div>
                    <em>{t("reader.meta.itemCount", { count: 12 })}</em>
                  </header>
                  <div className="library-meta-grid">
                    <div className="library-meta-item wide">
                      <div className="library-meta-label-row">
                        <span>{t("reader.meta.paperTitle")}</span>
                        {!editingTitle ? (
                          <button aria-label={t("reader.meta.editTitleAria")} className="library-meta-edit-button" onClick={() => setEditingTitle(true)} title={t("reader.meta.editTitle")} type="button">
                            <svg aria-hidden="true" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"><path d="m4 14.8.7-3.3L13 3.2a1.7 1.7 0 0 1 2.4 0l1.4 1.4a1.7 1.7 0 0 1 0 2.4l-8.3 8.3-3.3.7Z" /><path d="m11.8 4.4 3.8 3.8M4.7 11.5l3.8 3.8" /></svg>
                          </button>
                        ) : null}
                      </div>
                      {editingTitle ? (
                        <form className="library-title-editor" onSubmit={savePaperTitle}>
                          <input aria-label={t("reader.meta.paperTitle")} autoFocus disabled={savingTitle} onChange={(event) => setTitleDraft(event.target.value)} value={titleDraft} />
                          <div>
                            <button disabled={savingTitle} onClick={() => { setTitleDraft(paper.title || ""); setEditingTitle(false); }} type="button">{t("common.cancel")}</button>
                            <button className="primary" disabled={savingTitle || !titleDraft.trim()} type="submit">{savingTitle ? t("common.saving") : t("common.save")}</button>
                          </div>
                        </form>
                      ) : <strong>{paper.title || t("common.notRecorded")}</strong>}
                    </div>
                    <div className="library-meta-item"><span>arXiv</span><strong>{paper.arxiv_id || t("common.notRecorded")}</strong></div>
                    <div className="library-meta-item"><span>DOI</span><strong>{paper.doi || t("common.notRecorded")}</strong></div>
                    <div className="library-meta-item wide"><span>{t("library.metadata.canonicalKey")}</span><strong>{paper.canonical_key || t("common.notRecorded")}</strong></div>
                    <div className="library-meta-item wide"><span>{t("reader.meta.categories")}</span><strong>{categories.join(", ") || t("common.notRecorded")}</strong></div>
                    <div className="library-meta-item wide"><span>{t("reader.meta.authors")}</span><strong>{(paper.authors || []).join(", ") || t("common.notRecorded")}</strong></div>
                    <div className="library-meta-item"><span>{t("library.metadata.venue")}</span><strong>{paper.venue || t("common.notRecorded")}</strong></div>
                    <div className="library-meta-item"><span>{t("library.metadata.publishedAt")}</span><strong>{paper.published_at ? fmtDate(paper.published_at, i18n.resolvedLanguage || i18n.language) : t("common.notRecorded")}</strong></div>
                    <div className="library-meta-item"><span>{t("reader.meta.txtStatus")}</span><strong>{textAsset?.status || "pending"}</strong></div>
                    <div className="library-meta-item"><span>PDF</span><strong>{pdfAsset?.path ? t("reader.meta.cached") : t("reader.meta.notCached")}</strong></div>
                    <div className="library-meta-item wide"><span>{t("reader.meta.txtPath")}</span><strong className="is-path">{textAsset?.path || t("reader.meta.notGenerated")}</strong></div>
                    <div className="library-meta-item wide"><span>{t("reader.meta.pdfPath")}</span><strong className="is-path">{pdfAsset?.path || t("reader.meta.notCached")}</strong></div>
                  </div>
                </section>

                <div className="library-detail-card-grid library-metadata-records">
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
            ) : null}
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
      <PaperImportDialog
        notify={notify}
        onClose={onClosePaperImport}
        onImported={async (paperId) => {
          const importedPaperId = Number(paperId || 0);
          if (!importedPaperId) {
            await refreshPaperData();
            return;
          }
          pendingImportedPaperId.current = importedPaperId;
          cache.markStale(cacheNamespace("library"));
          cache.markStale(cacheNamespace("reader", "papers"));
          cache.markStale(cacheNamespace("paper-reports"));
          if (page !== 1) {
            setPage(1);
            return;
          }
          await listQuery.refresh({ force: true });
        }}
        onQueued={async (data) => {
          const workerJobId = Number(data?.worker_job_id || data?.worker_job?.id || 0);
          if (workerJobId) {
            setTrackedImportJobIds((current) => current.includes(workerJobId) ? current : [...current, workerJobId]);
          }
          cache.markStale(["library", "imports"]);
          cache.markStale(["jobs", "status"]);
          await Promise.all([
            importStatusQuery.refresh({ force: true }),
            jobStatusQuery.refresh({ force: true })
          ]);
        }}
        open={importOpen}
        setStatusMessage={setStatusMessage}
      />
    </section>
  );
}
