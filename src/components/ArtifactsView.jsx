import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { api, fmtDate } from "../lib/dashboard.js";
import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { friendlyObsidianMessage, postObsidianJson, useObsidianCapability } from "../lib/obsidianCapability.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { useWorkspacePageSizeOptions, WorkspacePagination } from "./WorkspacePagination.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/ArtifactsView.css";

const TYPE_CODES = ["", "daily_report", "experiment_report", "paper_report", "project_index", "project_digest", "literature_review", "reading_note"];

const SCOPE_CODES = ["", "system", "project", "paper"];

const TYPE_TONES = {
  daily_report: "green",
  experiment_report: "blue",
  literature_review: "violet",
  paper_report: "gold",
  project_digest: "slate",
  project_index: "teal",
  reading_note: "rose"
};
function translatedLabel(t, group, value, fallbackKey = "status.unknown") {
  const key = String(value || "").trim();
  return key ? t(`${group}.${key}`, { defaultValue: key }) : t(fallbackKey);
}

function safeToken(value, fallback = "unknown") {
  const token = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return token || fallback;
}

function relationLabel(t, relationType) {
  return relationType ? t(`relation.${relationType}`, { defaultValue: relationType }) : t("relation.possible");
}

function sortArtifactsByUpdatedAt(left, right) {
  return new Date(right.updated_at || 0) - new Date(left.updated_at || 0);
}

function patchArtifactItems(items, artifact) {
  if (!artifact?.id || !Array.isArray(items)) return items || [];
  let found = false;
  const next = items.map((item) => {
    if (Number(item.id) !== Number(artifact.id)) return item;
    found = true;
    return { ...item, ...artifact };
  });
  return found ? next.sort(sortArtifactsByUpdatedAt) : next;
}

export function ArtifactsView({ onSelectArtifact, selectedArtifactId, setStatusMessage }) {
  const { t, i18n } = useTranslation("artifacts");
  const types = useMemo(() => TYPE_CODES.map((code) => [code, t(`type.${code || "all"}`)]), [t]);
  const scopes = useMemo(() => SCOPE_CODES.map((code) => [code, t(`scope.${code || "all"}`)]), [t]);
  const pageSizeOptions = useWorkspacePageSizeOptions();
  const [activeId, setActiveId] = useState(null);
  const [artifactType, setArtifactType] = useState("");
  const [scopeType, setScopeType] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [busy, setBusy] = useState(false);
  const selectFirstFromNextList = useRef(false);
  const cache = useApiCacheClient();
  const selectedRouteId = Number.isFinite(Number(selectedArtifactId)) ? Number(selectedArtifactId) : null;
  const handleCapabilityError = useCallback((error) => setStatusMessage(error.message), [setStatusMessage]);
  const obsidianCapability = useObsidianCapability({ onError: handleCapabilityError });

  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String((page - 1) * pageSize)
    });
    if (artifactType) params.set("artifact_type", artifactType);
    if (scopeType) params.set("scope_type", scopeType);
    return params.toString();
  }, [artifactType, page, pageSize, scopeType]);

  const listQuery = useCachedApi(
    ["artifacts", "list", queryString],
    () => api(`/api/artifacts?${queryString}`),
    { staleTime: 120000 }
  );
  const listData = listQuery.data || { items: [], total: 0 };
  const items = listData.items || [];
  const total = Number(listData.total || 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const activeStillExists = activeId && items.some((item) => Number(item.id) === Number(activeId));
  const detailId = selectedRouteId || (activeStillExists ? activeId : items[0]?.id);
  const detailQuery = useCachedApi(
    ["artifact", String(detailId || "")],
    () => api(`/api/artifacts/${encodeURIComponent(String(detailId))}`),
    { enabled: Boolean(detailId), staleTime: 300000 }
  );
  const detail = detailQuery.data?.artifact || null;
  const relatedPapers = Array.isArray(detail?.related_papers)
    ? detail.related_papers
    : [];
  const dailyCandidateCount = new Set(
    (Array.isArray(detail?.source?.project_candidates) ? detail.source.project_candidates : [])
      .map((candidate) => String(candidate?.arxiv_id || "").trim())
      .filter(Boolean)
  ).size;
  const listLoading = !listQuery.hasData;
  const detailMatchesActiveArtifact = Boolean(detail?.id) && Number(detail.id) === Number(detailId);
  const detailLoading = Boolean(detailId) && (
    detailQuery.loading ||
    detailQuery.refreshing && !detailMatchesActiveArtifact ||
    detailQuery.hasData && !detailMatchesActiveArtifact
  );
  const detailPanelLoading = listLoading || detailLoading;
  const refreshBusy = listQuery.loading || listQuery.refreshing || detailQuery.refreshing;
  const selectedTypeLabel = artifactType ? translatedLabel(t, "type", artifactType) : t("type.all");
  const selectedScopeLabel = scopeType ? translatedLabel(t, "scope", scopeType) : t("scope.all");
  const activeFilterCount = [artifactType, scopeType].filter(Boolean).length;
  const activeFilterLabels = [
    artifactType ? selectedTypeLabel : "",
    scopeType ? selectedScopeLabel : ""
  ].filter(Boolean);

  useEffect(() => {
    const error = listQuery.error || detailQuery.error;
    if (error) setStatusMessage(error.message);
  }, [detailQuery.error, listQuery.error, setStatusMessage]);

  useEffect(() => {
    if (detailId) {
      setActiveId(Number(detailId));
      return;
    }
    setActiveId(null);
  }, [detailId]);

  const selectArtifact = useCallback((id) => {
    if (onSelectArtifact) {
      onSelectArtifact(id);
      return;
    }
    setActiveId(Number(id));
  }, [onSelectArtifact]);

  useEffect(() => {
    if (!listQuery.hasData || !selectFirstFromNextList.current) return;
    selectFirstFromNextList.current = false;
    if (items[0]?.id) selectArtifact(items[0].id);
  }, [items, listQuery.hasData, selectArtifact]);

  useEffect(() => {
    if (!listQuery.hasData || page <= pageCount) return;
    selectFirstFromNextList.current = true;
    setPage(pageCount);
  }, [listQuery.hasData, page, pageCount]);

  function updateFilter(setter, value) {
    selectFirstFromNextList.current = true;
    setter(value);
    setPage(1);
  }

  function clearFilters() {
    selectFirstFromNextList.current = true;
    setArtifactType("");
    setScopeType("");
    setPage(1);
  }

  function goToPage(nextPage) {
    const normalizedPage = Math.max(1, Math.min(pageCount, nextPage));
    if (normalizedPage === page) return;
    selectFirstFromNextList.current = true;
    setPage(normalizedPage);
  }

  async function refresh() {
    try {
      await Promise.all([
        listQuery.refresh({ force: true }),
        detailId ? detailQuery.refresh({ force: true }) : Promise.resolve()
      ]);
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function exportObsidian() {
    if (!detail?.id) return;
    if (!obsidianCapability.available) {
      setStatusMessage(obsidianCapability.disabledReason);
      return;
    }
    setBusy(true);
    try {
      const data = await postObsidianJson(`/api/artifacts/${detail.id}/export-obsidian`, {});
      if (data?.queued) {
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        setStatusMessage(t("messages.exportQueued"));
        return;
      }
      if (data.artifact?.id) {
        cache.setCache(["artifact", String(data.artifact.id)], { artifact: data.artifact });
        cache.patch(cacheNamespace("artifacts", "list"), (current) => ({
          ...(current || {}),
          items: patchArtifactItems(current?.items || [], data.artifact)
        }));
      }
      cache.markStale(["artifacts"]);
      cache.markStale(["health"]);
      setStatusMessage(t("messages.exported", { path: data.export?.path || "artifact" }));
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="view artifacts-view artifacts-workspace vision-library vision-artifacts">
      <header className="vision-topbar artifacts-topbar">
        <div className="vision-brand">
          <span>{t("header.eyebrow")}</span>
          <h1>{t("header.title")}</h1>
        </div>
        <div className="vision-top-actions">
          <span className="vision-live-state ready"><i aria-hidden="true" />{listLoading ? t("header.loading") : t("header.count", { count: total })}</span>
          <RefreshButton className="vision-refresh" busy={refreshBusy} onClick={refresh} />
        </div>
      </header>

      <main className="library-workspace-grid artifacts-workspace-grid">
        <section className="library-list-panel paper-library-list-panel artifacts-list-panel">
          <header className="paper-library-header library-list-heading artifacts-list-heading">
            <div>
              <span className="paper-library-eyebrow">{t("list.eyebrow")}</span>
              <h2>{t("list.title")}</h2>
            </div>
            <div className="library-list-heading-actions">
              <em>{listLoading ? "…" : total}</em>
              <WorkspacePagination
                compact
                currentPage={currentPage}
                loading={listQuery.loading}
                onNext={() => goToPage(page + 1)}
                onPrevious={() => goToPage(page - 1)}
                pageCount={pageCount}
              />
            </div>
          </header>

          <div className="paper-filter-stack artifact-filter-stack">
            <div className="paper-filter-summary">
              <div className="paper-active-filters">
                {activeFilterLabels.length
                  ? activeFilterLabels.map((label) => <span key={label}>{label}</span>)
                  : <span>{t("list.all")}</span>}
              </div>
              <div className="artifact-filter-summary-actions">
                {activeFilterCount ? (
                  <button className="filter-clear-button" onClick={clearFilters} type="button">{t("list.clear")}</button>
                ) : null}
                <button
                  aria-controls="artifact-filter-panel"
                  aria-expanded={filtersOpen}
                  className="left-filter-toggle"
                  onClick={() => setFiltersOpen((current) => !current)}
                  type="button"
                >
                  {filtersOpen ? t("list.collapse") : `${t("list.filter")}${activeFilterCount ? ` (${activeFilterCount})` : ""}`}
                </button>
              </div>
            </div>
            <div
              aria-hidden={!filtersOpen}
              className={`paper-filter-collapse ${filtersOpen ? "is-open" : ""}`}
              id="artifact-filter-panel"
              inert={!filtersOpen}
            >
              <div className="library-toolbar paper-library-toolbar artifact-filter-bar" aria-label={t("list.filtersAria")}>
                <div className="library-filter-control paper-filter-control artifact-filter-control">
                  <span>{t("list.type")}</span>
                  <WorkspaceSelect ariaLabel={t("list.typeAria")} onChange={(value) => updateFilter(setArtifactType, value)} options={types} value={artifactType} />
                </div>
                <div className="library-filter-control paper-filter-control artifact-filter-control">
                  <span>{t("list.scope")}</span>
                  <WorkspaceSelect ariaLabel={t("list.scopeAria")} onChange={(value) => updateFilter(setScopeType, value)} options={scopes} value={scopeType} />
                </div>
                <div className="library-filter-control paper-filter-control artifact-filter-control">
                  <span>{t("list.pageSize")}</span>
                  <WorkspaceSelect
                    ariaLabel={t("list.pageSizeAria")}
                    onChange={(value) => {
                      selectFirstFromNextList.current = true;
                      setPageSize(Number(value));
                      setPage(1);
                    }}
                    options={pageSizeOptions}
                    value={String(pageSize)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="library-list paper-library-list artifacts-list">
            {listLoading ? (
              <WorkspacePaneLoader rows={6} title={t("list.loading")} variant="list" />
            ) : items.length ? items.map((item) => {
              const typeLabel = translatedLabel(t, "type", item.artifact_type);
              const scopeLabel = translatedLabel(t, "scope", item.scope_type);
              const statusLabel = translatedLabel(t, "status", item.status);
              const typeTone = TYPE_TONES[item.artifact_type] || "slate";
              const scopeText = `${scopeLabel}${item.scope_id ? ` #${item.scope_id}` : ""}`;
              return (
                <article
                  className={`inbox-paper-row library-paper-row-card artifact-row-card ${activeId === item.id ? "active" : ""}`}
                  key={item.id}
                  onClick={() => selectArtifact(item.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    selectArtifact(item.id);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="inbox-paper-row-head">
                    <span className={`artifact-pill artifact-type-${typeTone}`}>{typeLabel}</span>
                    <span className={`artifact-pill artifact-status-${safeToken(item.status)}`}>{statusLabel}</span>
                  </div>
                  <h2>{item.title}</h2>
                  <div className="inbox-project-match artifact-card-context">
                    <strong>{t("list.artifactScope")}</strong>
                    <div><span>{scopeText}</span><span>{t("list.updatedAt", { date: fmtDate(item.updated_at, i18n.resolvedLanguage) })}</span></div>
                  </div>
                  <div className="inbox-paper-meta artifact-card-meta">
                    <span>Artifact #{item.id}</span>
                    {item.model ? <span>{item.model}</span> : null}
                    <span>{item.created_at ? t("list.createdAt", { date: fmtDate(item.created_at, i18n.resolvedLanguage) }) : t("list.noCreatedAt")}</span>
                  </div>
                </article>
              );
            }) : (
              <div className="artifact-empty-state">
                <strong>{t("list.empty")}</strong>
                <p>{t(artifactType || scopeType ? "list.emptyFiltered" : "list.emptyHint")}</p>
              </div>
            )}
          </div>
          <WorkspacePagination
            currentPage={currentPage}
            loading={listQuery.loading}
            onNext={() => goToPage(page + 1)}
            onPrevious={() => goToPage(page - 1)}
            pageCount={pageCount}
          />
        </section>

        <section className="detail-panel library-detail-panel artifact-detail-panel">
          {detailPanelLoading ? (
            <WorkspacePaneLoader
              className="artifact-detail-loading"
              description={t(detailLoading ? "detail.loadingSelected" : "detail.loadingFirst")}
              title={t(detailLoading ? "detail.opening" : "detail.loading")}
              variant="detail"
            />
          ) : detail ? (
            <article className="inbox-detail-card library-paper-detail artifact-paper-detail library-detail-transition" key={detail.id}>
              <div className="detail-main library-detail-main">
                <header className="detail-title inbox-detail-title library-detail-title artifact-detail-title">
                  <div className="library-detail-hero-copy">
                    <span className="library-detail-eyebrow">{t("detail.eyebrow", { id: detail.id })}</span>
                    <h2>{detail.title}</h2>
                    <p className="library-detail-authors">{t("detail.updatedAt", { type: translatedLabel(t, "type", detail.artifact_type), date: fmtDate(detail.updated_at, i18n.resolvedLanguage) })}</p>
                    <div className="inbox-detail-meta library-detail-meta artifact-meta-row">
                      <span className={`artifact-pill artifact-type-${TYPE_TONES[detail.artifact_type] || "slate"}`}>{translatedLabel(t, "type", detail.artifact_type)}</span>
                      <span className="artifact-pill artifact-scope-pill">{translatedLabel(t, "scope", detail.scope_type)}{detail.scope_id ? ` #${detail.scope_id}` : ""}</span>
                      <span className={`artifact-pill artifact-status-${safeToken(detail.status)}`}>{translatedLabel(t, "status", detail.status)}</span>
                      <button
                        className="library-hero-action"
                        disabled={busy || !obsidianCapability.available}
                        onClick={exportObsidian}
                        title={!obsidianCapability.available ? obsidianCapability.disabledReason : undefined}
                        type="button"
                      >
                        {t(busy ? "detail.exporting" : "detail.exportObsidian")}
                      </button>
                    </div>
                    {!obsidianCapability.available ? <p className="capability-hint artifact-capability-hint">{obsidianCapability.disabledReason}</p> : null}
                  </div>
                </header>

                <section className="library-detail-stat-grid artifact-detail-stat-grid" aria-label={t("detail.statsAria")}>
                  <div><span>{t("detail.type")}</span><strong>{translatedLabel(t, "type", detail.artifact_type)}</strong><p>{t("detail.contentCategory")}</p></div>
                  <div><span>{t("detail.scope")}</span><strong>{translatedLabel(t, "scope", detail.scope_type)}</strong><p>{detail.scope_id ? t("detail.object", { id: detail.scope_id }) : t("detail.systemLevel")}</p></div>
                  <div><span>{t("detail.status")}</span><strong>{translatedLabel(t, "status", detail.status)}</strong><p>{t("detail.lifecycle")}</p></div>
                  <div><span>{t("detail.model")}</span><strong>{detail.model || "—"}</strong><p>{detail.model_provider_id || t("detail.providerMissing")}</p></div>
                </section>

                {detail.artifact_type === "daily_report" ? (
                  <section className="library-content-card artifact-related-papers-card">
                    <header className="library-section-heading">
                      <div><span>{t("detail.dailyRelation")}</span><h3>{t("detail.relatedPapers")}</h3></div>
                      <em>{relatedPapers.length ? t("detail.paperCount", { count: relatedPapers.length }) : t("detail.none")}</em>
                    </header>
                    {relatedPapers.length ? (
                      <div className="artifact-related-paper-list">
                        {relatedPapers.map((paper) => {
                          const pending = paper.state === "pending";
                          const paperPath = pending
                            ? `/papers/inbox/${encodeURIComponent(String(paper.id))}`
                            : paper.library_paper_id
                              ? `/papers/library/${encodeURIComponent(String(paper.library_paper_id))}`
                              : "/papers/library";
                          return (
                            <article className="artifact-related-paper" key={paper.id}>
                              <Link className="artifact-related-paper-title" to={paperPath}>
                                <span>{paper.arxiv_id || "arXiv"}</span>
                                <strong>{paper.title}</strong>
                                <i aria-hidden="true">{t(pending ? "detail.openPending" : "detail.openLibrary")}</i>
                              </Link>
                              <div className="artifact-related-paper-meta">
                                <span className={`artifact-related-paper-state ${pending ? "pending" : "assigned"}`}>
                                  {t(pending ? "detail.pending" : "detail.assigned")}
                                </span>
                                <span>{relationLabel(t, paper.relation_type)}</span>
                                {paper.published_at ? <span>{fmtDate(paper.published_at, i18n.resolvedLanguage)}</span> : null}
                                {(paper.projects || []).map((project) => (
                                  <Link key={project.project_id} to={`/projects/${encodeURIComponent(String(project.project_id))}`}>
                                    {project.project_name}
                                  </Link>
                                ))}
                              </div>
                              {paper.reason ? <p>{paper.reason}</p> : null}
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="artifact-related-paper-empty">
                        {dailyCandidateCount
                          ? t("detail.noRelatedCurrent")
                          : t("detail.noCandidates")}
                      </p>
                    )}
                  </section>
                ) : null}

                <div className="library-detail-content artifact-detail-content">
                  <section className="section inbox-content-section library-content-card artifact-markdown-card">
                    <header className="library-section-heading">
                      <div><span>{t("detail.body")}</span><h3>{t("detail.markdown")}</h3></div>
                      <em>{detail.content_markdown ? t("status.ready") : t("detail.noMarkdown")}</em>
                    </header>
                    <div className="artifact-reader-content">
                      {detail.content_markdown ? (
                        <LazyMarkdownReport markdown={detail.content_markdown} />
                      ) : (
                        <div className="artifact-empty-state artifact-reader-empty">
                          <strong>{t("detail.noMarkdown")}</strong>
                          <p>{t("detail.noMarkdownHint")}</p>
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            </article>
          ) : (
            <div className="empty-detail paper-empty-detail artifact-empty-detail">
              <h2>{t("detail.select")}</h2>
              <p>{t("detail.selectHint")}</p>
            </div>
          )}
        </section>
      </main>
    </section>
  );
}
