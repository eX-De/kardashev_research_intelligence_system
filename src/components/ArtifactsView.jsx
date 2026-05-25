import { useCallback, useEffect, useMemo, useState } from "react";

import { api, fmtDate } from "../lib/dashboard.js";
import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { friendlyObsidianMessage, postObsidianJson, useObsidianCapability } from "../lib/obsidianCapability.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";

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
    <section className="view artifacts-view">
      <section className="library-list-panel">
        <header className="panel-header">
          <div>
            <h1>产物</h1>
            <p>{items.length} 个系统内产物</p>
          </div>
          <button onClick={refresh} type="button">刷新</button>
        </header>
        <div className="filter-row">
          <select value={artifactType} onChange={(event) => setArtifactType(event.target.value)}>
            {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={scopeType} onChange={(event) => setScopeType(event.target.value)}>
            <option value="">全部范围</option>
            <option value="system">系统</option>
            <option value="project">项目</option>
            <option value="paper">论文</option>
          </select>
        </div>
        <div className="library-list">
          {items.length ? items.map((item) => (
            <button className={`library-row ${activeId === item.id ? "active" : ""}`} key={item.id} onClick={() => selectArtifact(item.id)} type="button">
              <strong>{item.title}</strong>
              <span>{item.artifact_type} · {item.scope_type}{item.scope_id ? ` #${item.scope_id}` : ""}</span>
              <small>{item.status} · {fmtDate(item.updated_at)}</small>
            </button>
          )) : <p className="muted">暂无产物。</p>}
        </div>
      </section>

      <section className="detail-panel artifact-detail-panel">
        {detail ? (
          <div className="detail-card">
            <div className="detail-title">
              <h2>{detail.title}</h2>
              <p className="muted">{detail.artifact_type} · {detail.scope_type}{detail.scope_id ? ` #${detail.scope_id}` : ""} · {fmtDate(detail.updated_at)}</p>
            </div>
            <div className="detail-actions">
              <button disabled={busy || !obsidianCapability.available} onClick={exportObsidian} title={!obsidianCapability.available ? obsidianCapability.disabledReason : undefined} type="button">导出到 Obsidian</button>
              {!obsidianCapability.available ? <p className="capability-hint">{obsidianCapability.disabledReason}</p> : null}
            </div>
            <div className="section">
              <h3>正文</h3>
              {detail.content_markdown ? <LazyMarkdownReport markdown={detail.content_markdown} /> : <p className="muted">暂无 Markdown 正文。</p>}
            </div>
            <div className="section">
              <h3>来源</h3>
              <pre className="json-block">{JSON.stringify(detail.source || {}, null, 2)}</pre>
            </div>
          </div>
        ) : (
          <div className="empty-detail">
            <h2>选择一个产物</h2>
            <p>Markdown 正文、关联对象和来源信息会显示在这里。</p>
          </div>
        )}
      </section>
    </section>
  );
}
