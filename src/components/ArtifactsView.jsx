import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, fmtDate } from "../lib/dashboard.js";
import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { friendlyObsidianMessage, postObsidianJson, useObsidianCapability } from "../lib/obsidianCapability.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { WORKSPACE_PAGE_SIZE_OPTIONS, WorkspacePagination } from "./WorkspacePagination.jsx";
import { WorkspaceSelect } from "./WorkspaceSelect.jsx";
import "../styles/ArtifactsView.css";

const TYPES = [
  ["", "全部类型"],
  ["daily_report", "日报"],
  ["experiment_report", "实验报告"],
  ["paper_report", "论文报告"],
  ["project_index", "项目索引"],
  ["project_digest", "项目摘要"],
  ["literature_review", "综述"],
  ["reading_note", "阅读笔记"]
];

const SCOPES = [
  ["", "全部范围"],
  ["system", "系统"],
  ["project", "项目"],
  ["paper", "论文"]
];

const TYPE_LABELS = Object.fromEntries(TYPES.filter(([value]) => value));
const TYPE_TONES = {
  daily_report: "green",
  experiment_report: "blue",
  literature_review: "violet",
  paper_report: "gold",
  project_digest: "slate",
  project_index: "teal",
  reading_note: "rose"
};
const SCOPE_LABELS = {
  paper: "论文",
  project: "项目",
  system: "系统"
};
const STATUS_LABELS = {
  active: "可用",
  done: "完成",
  draft: "草稿",
  failed: "失败",
  pending: "等待",
  ready: "就绪",
  removed: "已移除",
  synced: "已同步"
};

function labelFor(labels, value, fallback = "未知") {
  const key = String(value || "").trim();
  return key ? labels[key] || key : fallback;
}

function safeToken(value, fallback = "unknown") {
  const token = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return token || fallback;
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
  const listLoading = !listQuery.hasData;
  const detailMatchesActiveArtifact = Boolean(detail?.id) && Number(detail.id) === Number(detailId);
  const detailLoading = Boolean(detailId) && (
    detailQuery.loading ||
    detailQuery.refreshing && !detailMatchesActiveArtifact ||
    detailQuery.hasData && !detailMatchesActiveArtifact
  );
  const detailPanelLoading = listLoading || detailLoading;
  const refreshBusy = listQuery.loading || listQuery.refreshing || detailQuery.refreshing;
  const selectedTypeLabel = artifactType ? labelFor(TYPE_LABELS, artifactType) : "全部类型";
  const selectedScopeLabel = scopeType ? labelFor(SCOPE_LABELS, scopeType) : "全部范围";
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
        setStatusMessage("Artifact export queued");
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
      setStatusMessage(`已导出 ${data.export?.path || "artifact"}`);
    } catch (error) {
      setStatusMessage(friendlyObsidianMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="view artifacts-view artifacts-workspace vision-library vision-artifacts">
      <header className="vision-topbar artifacts-topbar">
        <div className="vision-brand">
          <span>研究工作区</span>
          <h1>研究产物</h1>
        </div>
        <div className="vision-top-actions">
          <span className="vision-live-state ready"><i aria-hidden="true" />{listLoading ? "读取产物" : `${total} 个产物`}</span>
          <RefreshButton className="vision-refresh" busy={refreshBusy} onClick={refresh} />
        </div>
      </header>

      <main className="library-workspace-grid artifacts-workspace-grid">
        <section className="library-list-panel paper-library-list-panel artifacts-list-panel">
          <header className="paper-library-header library-list-heading artifacts-list-heading">
            <div>
              <span className="paper-library-eyebrow">产物目录</span>
              <h2>产物列表</h2>
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
                  : <span>全部产物</span>}
              </div>
              <button
                aria-controls="artifact-filter-panel"
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
              id="artifact-filter-panel"
              inert={!filtersOpen}
            >
              <div className="library-toolbar paper-library-toolbar artifact-filter-bar" aria-label="产物筛选">
                <div className="library-filter-control paper-filter-control artifact-filter-control">
                  <span>类型</span>
                  <WorkspaceSelect ariaLabel="筛选产物类型" onChange={(value) => updateFilter(setArtifactType, value)} options={TYPES} value={artifactType} />
                </div>
                <div className="library-filter-control paper-filter-control artifact-filter-control">
                  <span>范围</span>
                  <WorkspaceSelect ariaLabel="筛选产物范围" onChange={(value) => updateFilter(setScopeType, value)} options={SCOPES} value={scopeType} />
                </div>
                <div className="library-filter-control paper-filter-control artifact-filter-control">
                  <span>每页</span>
                  <WorkspaceSelect
                    ariaLabel="每页产物数量"
                    onChange={(value) => {
                      selectFirstFromNextList.current = true;
                      setPageSize(Number(value));
                      setPage(1);
                    }}
                    options={WORKSPACE_PAGE_SIZE_OPTIONS}
                    value={String(pageSize)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="library-list paper-library-list artifacts-list">
            {listLoading ? (
              <WorkspacePaneLoader rows={6} title="读取产物列表" variant="list" />
            ) : items.length ? items.map((item) => {
              const typeLabel = labelFor(TYPE_LABELS, item.artifact_type);
              const scopeLabel = labelFor(SCOPE_LABELS, item.scope_type);
              const statusLabel = labelFor(STATUS_LABELS, item.status, "未知状态");
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
                    <strong>产物范围</strong>
                    <div><span>{scopeText}</span><span>更新于 {fmtDate(item.updated_at)}</span></div>
                  </div>
                  <div className="inbox-paper-meta artifact-card-meta">
                    <span>Artifact #{item.id}</span>
                    {item.model ? <span>{item.model}</span> : null}
                    <span>{item.created_at ? `创建于 ${fmtDate(item.created_at)}` : "未记录创建时间"}</span>
                  </div>
                </article>
              );
            }) : (
              <div className="artifact-empty-state">
                <strong>暂无产物</strong>
                <p>{artifactType || scopeType ? "当前筛选没有匹配项。" : "系统生成的 Markdown 产物会显示在这里。"}</p>
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
              description={detailLoading ? "正在读取所选产物的正文、状态和同步信息。" : "正在读取产物列表和首个产物正文。"}
              title={detailLoading ? "打开产物详情" : "读取产物详情"}
              variant="detail"
            />
          ) : detail ? (
            <article className="inbox-detail-card library-paper-detail artifact-paper-detail library-detail-transition" key={detail.id}>
              <div className="detail-main library-detail-main">
                <header className="detail-title inbox-detail-title library-detail-title artifact-detail-title">
                  <div className="library-detail-hero-copy">
                    <span className="library-detail-eyebrow">研究产物 · Artifact #{detail.id}</span>
                    <h2>{detail.title}</h2>
                    <p className="library-detail-authors">{labelFor(TYPE_LABELS, detail.artifact_type)} · 更新于 {fmtDate(detail.updated_at)}</p>
                    <div className="inbox-detail-meta library-detail-meta artifact-meta-row">
                      <span className={`artifact-pill artifact-type-${TYPE_TONES[detail.artifact_type] || "slate"}`}>{labelFor(TYPE_LABELS, detail.artifact_type)}</span>
                      <span className="artifact-pill artifact-scope-pill">{labelFor(SCOPE_LABELS, detail.scope_type)}{detail.scope_id ? ` #${detail.scope_id}` : ""}</span>
                      <span className={`artifact-pill artifact-status-${safeToken(detail.status)}`}>{labelFor(STATUS_LABELS, detail.status, "未知状态")}</span>
                      <button
                        className="library-hero-action"
                        disabled={busy || !obsidianCapability.available}
                        onClick={exportObsidian}
                        title={!obsidianCapability.available ? obsidianCapability.disabledReason : undefined}
                        type="button"
                      >
                        {busy ? "导出中" : "导出到 Obsidian"}
                      </button>
                    </div>
                    {!obsidianCapability.available ? <p className="capability-hint artifact-capability-hint">{obsidianCapability.disabledReason}</p> : null}
                  </div>
                </header>

                <section className="library-detail-stat-grid artifact-detail-stat-grid" aria-label="产物关键数据">
                  <div><span>产物类型</span><strong>{labelFor(TYPE_LABELS, detail.artifact_type)}</strong><p>内容分类</p></div>
                  <div><span>归属范围</span><strong>{labelFor(SCOPE_LABELS, detail.scope_type)}</strong><p>{detail.scope_id ? `对象 #${detail.scope_id}` : "系统级"}</p></div>
                  <div><span>当前状态</span><strong>{labelFor(STATUS_LABELS, detail.status, "未知")}</strong><p>产物生命周期</p></div>
                  <div><span>生成模型</span><strong>{detail.model || "—"}</strong><p>{detail.model_provider_id || "未记录提供方"}</p></div>
                </section>

                <div className="library-detail-content artifact-detail-content">
                  <section className="section inbox-content-section library-content-card artifact-markdown-card">
                    <header className="library-section-heading">
                      <div><span>产物正文</span><h3>Markdown 内容</h3></div>
                      <em>{detail.content_markdown ? "READY" : "EMPTY"}</em>
                    </header>
                    <div className="artifact-reader-content">
                      {detail.content_markdown ? (
                        <LazyMarkdownReport markdown={detail.content_markdown} />
                      ) : (
                        <div className="artifact-empty-state artifact-reader-empty">
                          <strong>暂无 Markdown 正文</strong>
                          <p>该产物当前没有可阅读正文。</p>
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              </div>
            </article>
          ) : (
            <div className="empty-detail paper-empty-detail artifact-empty-detail">
              <h2>选择一个产物</h2>
              <p>Markdown 正文、状态和生成信息会显示在这里。</p>
            </div>
          )}
        </section>
      </main>
    </section>
  );
}
