import { useCallback, useEffect, useMemo, useState } from "react";

import { api, fmtDate } from "../lib/dashboard.js";
import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { friendlyObsidianMessage, postObsidianJson, useObsidianCapability } from "../lib/obsidianCapability.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { RefreshButton } from "./RefreshButton.jsx";

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
  const [busy, setBusy] = useState(false);
  const cache = useApiCacheClient();
  const selectedRouteId = Number.isFinite(Number(selectedArtifactId)) ? Number(selectedArtifactId) : null;
  const handleCapabilityError = useCallback((error) => setStatusMessage(error.message), [setStatusMessage]);
  const obsidianCapability = useObsidianCapability({ onError: handleCapabilityError });

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ limit: "100" });
    if (artifactType) params.set("artifact_type", artifactType);
    if (scopeType) params.set("scope_type", scopeType);
    return params.toString();
  }, [artifactType, scopeType]);

  const listQuery = useCachedApi(
    ["artifacts", "list", queryString],
    () => api(`/api/artifacts?${queryString}`),
    { staleTime: 120000 }
  );
  const items = listQuery.data?.items || [];
  const activeStillExists = activeId && items.some((item) => Number(item.id) === Number(activeId));
  const detailId = selectedRouteId || (activeStillExists ? activeId : items[0]?.id);
  const detailQuery = useCachedApi(
    ["artifact", String(detailId || "")],
    () => api(`/api/artifacts/${encodeURIComponent(String(detailId))}`),
    { enabled: Boolean(detailId), staleTime: 300000 }
  );
  const detail = detailQuery.data?.artifact || null;
  const latestUpdatedAt = items[0]?.updated_at || "";
  const selectedTypeLabel = artifactType ? labelFor(TYPE_LABELS, artifactType) : "全部类型";
  const selectedScopeLabel = scopeType ? labelFor(SCOPE_LABELS, scopeType) : "全部范围";
  const activeFilterCount = [artifactType, scopeType].filter(Boolean).length;

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
    <section className="view artifacts-view artifacts-workspace">
      <section className="library-list-panel artifacts-list-panel">
        <header className="panel-header artifacts-panel-header">
          <div>
            <span className="artifact-eyebrow">系统产物</span>
            <h1>产物</h1>
            <p>{items.length} 个产物{latestUpdatedAt ? ` · 最近更新 ${fmtDate(latestUpdatedAt)}` : ""}</p>
          </div>
          <RefreshButton busy={listQuery.status === "loading"} onClick={refresh} />
        </header>
        <div className="artifact-filter-stack">
          <div className="artifact-list-summary">
            <span>{selectedTypeLabel}</span>
            <span>{selectedScopeLabel}</span>
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
          {filtersOpen ? (
            <div className="artifact-filter-bar" id="artifact-filter-panel" aria-label="产物筛选">
              <label className="artifact-filter-control">
                <span>类型</span>
                <select value={artifactType} onChange={(event) => setArtifactType(event.target.value)}>
                  {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="artifact-filter-control">
                <span>范围</span>
                <select value={scopeType} onChange={(event) => setScopeType(event.target.value)}>
                  <option value="">全部范围</option>
                  <option value="system">系统</option>
                  <option value="project">项目</option>
                  <option value="paper">论文</option>
                </select>
              </label>
            </div>
          ) : null}
        </div>
        <div className="library-list artifacts-list">
          {items.length ? items.map((item) => {
            const typeLabel = labelFor(TYPE_LABELS, item.artifact_type);
            const scopeLabel = labelFor(SCOPE_LABELS, item.scope_type);
            const statusLabel = labelFor(STATUS_LABELS, item.status, "未知状态");
            const typeTone = TYPE_TONES[item.artifact_type] || "slate";
            const scopeText = `${scopeLabel}${item.scope_id ? ` #${item.scope_id}` : ""}`;
            return (
              <button className={`library-row artifact-row ${activeId === item.id ? "active" : ""}`} key={item.id} onClick={() => selectArtifact(item.id)} type="button">
                <span className="artifact-row-main">
                  <strong>{item.title}</strong>
                  <span>{scopeText} · {fmtDate(item.updated_at)}</span>
                </span>
                <span className="artifact-row-pills">
                  <span className={`artifact-pill artifact-type-${typeTone}`}>{typeLabel}</span>
                  <span className={`artifact-pill artifact-status-${safeToken(item.status)}`}>{statusLabel}</span>
                </span>
              </button>
            );
          }) : (
            <div className="artifact-empty-state">
              <strong>暂无产物</strong>
              <p>{artifactType || scopeType ? "当前筛选没有匹配项。" : "系统生成的 Markdown 产物会显示在这里。"}</p>
            </div>
          )}
        </div>
      </section>

      <section className="detail-panel artifact-detail-panel">
        {detail ? (
          <article className="detail-card artifact-reader-card">
            <header className="artifact-reader-head">
              <div className="artifact-reader-title">
                <div className="artifact-meta-row">
                  <span className={`artifact-pill artifact-type-${TYPE_TONES[detail.artifact_type] || "slate"}`}>{labelFor(TYPE_LABELS, detail.artifact_type)}</span>
                  <span className="artifact-pill artifact-scope-pill">{labelFor(SCOPE_LABELS, detail.scope_type)}{detail.scope_id ? ` #${detail.scope_id}` : ""}</span>
                  <span className={`artifact-pill artifact-status-${safeToken(detail.status)}`}>{labelFor(STATUS_LABELS, detail.status, "未知状态")}</span>
                </div>
                <h2>{detail.title}</h2>
                <p className="muted">更新于 {fmtDate(detail.updated_at)}</p>
              </div>
              <div className="detail-actions artifact-reader-actions">
                <button className="primary" disabled={busy || !obsidianCapability.available} onClick={exportObsidian} title={!obsidianCapability.available ? obsidianCapability.disabledReason : undefined} type="button">
                  {busy ? "导出中" : "导出到 Obsidian"}
                </button>
              </div>
              {!obsidianCapability.available ? <p className="capability-hint">{obsidianCapability.disabledReason}</p> : null}
            </header>
            <div className="artifact-reader-body">
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
            </div>
          </article>
        ) : (
          <div className="empty-detail artifact-empty-detail">
            <h2>选择一个产物</h2>
            <p>Markdown 正文会显示在这里。</p>
          </div>
        )}
      </section>
    </section>
  );
}
