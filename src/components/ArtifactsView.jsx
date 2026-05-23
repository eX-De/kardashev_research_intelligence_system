import { useCallback, useEffect, useState } from "react";

import { api, fmtDate } from "../lib/dashboard.js";
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

export function ArtifactsView({ onSelectArtifact, selectedArtifactId, setStatusMessage }) {
  const [items, setItems] = useState([]);
  const [detail, setDetail] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [artifactType, setArtifactType] = useState("");
  const [scopeType, setScopeType] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedRouteId = Number.isFinite(Number(selectedArtifactId)) ? Number(selectedArtifactId) : null;
  const handleCapabilityError = useCallback((error) => setStatusMessage(error.message), [setStatusMessage]);
  const obsidianCapability = useObsidianCapability({ onError: handleCapabilityError });

  const loadDetail = useCallback(async (id) => {
    const data = await api(`/api/artifacts/${encodeURIComponent(String(id))}`);
    setDetail(data.artifact);
    setActiveId(Number(data.artifact?.id || id));
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "100" });
    if (artifactType) params.set("artifact_type", artifactType);
    if (scopeType) params.set("scope_type", scopeType);
    const data = await api(`/api/artifacts?${params.toString()}`);
    const next = data.items || [];
    setItems(next);
    const nextId = selectedRouteId || (activeId && next.some((item) => item.id === activeId) ? activeId : next[0]?.id);
    if (nextId) await loadDetail(nextId);
    if (!nextId) {
      setDetail(null);
      setActiveId(null);
    }
  }, [activeId, artifactType, loadDetail, scopeType, selectedRouteId]);

  useEffect(() => {
    load().catch((error) => setStatusMessage(error.message));
  }, [load, setStatusMessage]);

  const selectArtifact = useCallback((id) => {
    if (onSelectArtifact) {
      onSelectArtifact(id);
      return;
    }
    loadDetail(id).catch((error) => setStatusMessage(error.message));
  }, [loadDetail, onSelectArtifact, setStatusMessage]);

  async function exportObsidian() {
    if (!detail?.id) return;
    if (!obsidianCapability.available) {
      setStatusMessage(obsidianCapability.disabledReason);
      return;
    }
    setBusy(true);
    try {
      const data = await postObsidianJson(`/api/artifacts/${detail.id}/export-obsidian`, {});
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
          <button onClick={() => load().catch((error) => setStatusMessage(error.message))} type="button">刷新</button>
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
