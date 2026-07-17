import { useEffect, useState } from "react";

import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, fmtScore, postJson } from "../lib/dashboard.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import "../styles/InboxView.css";

const REPORT_STATUS_LABELS = {
  queued: "报告排队中",
  processing: "报告生成中",
  done: "全文报告已生成",
  failed: "报告失败"
};

function reportStatusLabel(status) {
  return REPORT_STATUS_LABELS[status] || "未生成报告";
}

function relationLabel(relation) {
  if (relation === "direct") return "直接相关";
  if (relation === "indirect") return "间接相关";
  return relation || "可能相关";
}

function PaperList({ papers, activePaperId, onSelect }) {
  if (!papers.length) {
    return (
      <div className="inbox-empty-state">
        <span aria-hidden="true">✓</span>
        <h2>待判断队列已清空</h2>
        <p>新的候选论文会在每日流程完成后出现在这里。</p>
      </div>
    );
  }
  return papers.map((paper) => {
    const projectNames = Array.from(new Set(
      (Array.isArray(paper.project_names) ? paper.project_names : [paper.project_name]).filter(Boolean)
    ));

    function handleSelect() {
      onSelect(paper.id);
    }

    function handleSelectKeyDown(event) {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleSelect();
      }
    }

    return (
      <article
        className={`inbox-paper-row ${paper.id === activePaperId ? "active" : ""}`}
        key={paper.id}
        onClick={handleSelect}
        onKeyDown={handleSelectKeyDown}
        role="button"
        tabIndex={0}
      >
        <div className="inbox-paper-row-head">
          <span className="inbox-score">匹配 {fmtScore(paper.score)}</span>
          <span className={`inbox-report-status ${paper.report_status || "missing"}`}>{reportStatusLabel(paper.report_status)}</span>
        </div>
        <h2>{paper.title}</h2>
        {projectNames.length ? (
          <div className="inbox-project-match">
            <strong>可能有关</strong>
            <div>{projectNames.map((projectName) => <span key={projectName}>{projectName}</span>)}</div>
          </div>
        ) : null}
        <div className="inbox-paper-meta">
          {paper.relation_type ? <span>{paper.relation_type}</span> : null}
          <span>{(paper.categories || []).slice(0, 2).join(" · ") || "arXiv"}</span>
          {paper.feedback_status ? <span>{paper.feedback_status}</span> : null}
        </div>
      </article>
    );
  });
}

function PaperDetail({ detail, onOpenReportQueue, onRecommendation, onGenerateReport }) {
  const [selectedProjectIds, setSelectedProjectIds] = useState([]);
  const [importance, setImportance] = useState("");

  useEffect(() => {
    const recommendations = detail?.project_recommendations || [];
    setSelectedProjectIds(
      recommendations
        .filter((recommendation) => recommendation.state === "pending")
        .map((recommendation) => recommendation.project_id)
    );
    setImportance("");
  }, [detail?.paper?.id, detail?.project_recommendations]);

  if (!detail?.paper) {
    return (
      <div className="inbox-detail-empty">
        <span aria-hidden="true">↗</span>
        <h2>选择一篇论文</h2>
        <p>论文摘要、项目关联和决策操作会显示在这里。</p>
      </div>
    );
  }
  const paper = detail.paper;
  const recommendations = detail.project_recommendations || [];
  const pendingRecommendations = recommendations.filter((recommendation) => recommendation.state === "pending");
  const judgments = detail.project_judgments || [];
  const evidence = detail.evidence || [];
  const report = detail.paper_report || {};
  const reportReady = report.status === "done" && Boolean(String(report.report_markdown || "").trim());
  const reportBusy = report.status === "processing";
  const importanceOptions = [
    ["high", "高", "重点跟进"],
    ["medium", "中", "常规阅读"],
    ["low", "低", "留作参考"]
  ];
  const canAccept = Boolean(importance) && selectedProjectIds.length > 0 && pendingRecommendations.length > 0;

  function toggleProject(projectId) {
    setSelectedProjectIds((current) => (
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId]
    ));
  }

  return (
    <article className="inbox-detail-card">
      <div className="detail-main">
        <header className="detail-title inbox-detail-title">
          <span className="inbox-detail-eyebrow">候选论文 · {paper.arxiv_id || "arXiv"}</span>
          <h2>{paper.title}</h2>
          <p className="inbox-detail-authors">{(paper.authors || []).slice(0, 6).join(", ") || "作者信息暂无"}</p>
          <div className="inbox-detail-meta">
            <a href={paper.link} target="_blank" rel="noreferrer">打开 arXiv ↗</a>
            <span>{(paper.categories || []).join(" · ") || "未分类"}</span>
            <span>全文 {paper.text_status || "pending"}</span>
          </div>
        </header>

        {pendingRecommendations.length ? (
          <section className="recommendation-control inbox-decision-card">
            <header className="inbox-section-heading">
              <div>
                <span>人工决策</span>
                <h3>保存到哪些研究项目？</h3>
              </div>
              <em>{pendingRecommendations.length} 个建议关联</em>
            </header>
            <p className="inbox-decision-hint">先选择重要性，再确认要保存到的项目。</p>
            <div className="importance-row" role="group" aria-label="重要性">
              <span>重要性</span>
              {importanceOptions.map(([value, label, hint]) => (
                <button className={importance === value ? "active" : ""} data-importance={value} key={value} onClick={() => setImportance(value)} type="button">
                  <i aria-hidden="true" />
                  <span><strong>{label}</strong><small>{hint}</small></span>
                </button>
              ))}
            </div>
            <div className="project-checkbox-list">
              {pendingRecommendations.map((recommendation) => {
                const selected = selectedProjectIds.includes(recommendation.project_id);
                return (
                <label className={`checkbox-line project-checkbox ${selected ? "selected" : ""}`} key={recommendation.project_id}>
                  <input
                    checked={selected}
                    onChange={() => toggleProject(recommendation.project_id)}
                    type="checkbox"
                  />
                  <span className="project-checkmark" aria-hidden="true"><span>✓</span></span>
                  <span className="project-checkbox-copy">
                    <strong>{recommendation.project_name}</strong>
                    <small>
                      <span>{relationLabel(recommendation.relation_type)}</span>
                      <span>匹配 {fmtScore(recommendation.usefulness_score)}</span>
                    </small>
                  </span>
                </label>
                );
              })}
            </div>
            <div className="detail-actions inbox-primary-actions">
              <button className="primary" disabled={!canAccept} onClick={() => onRecommendation({ action: "accept", importance, project_ids: selectedProjectIds })} type="button">保存到论文仓库</button>
              <button onClick={() => onOpenReportQueue?.(paper.id)} title={`打开报告队列：${reportStatusLabel(report.status)}`} type="button">打开报告队列</button>
              <button className="danger" onClick={() => onRecommendation({ action: "discard" })} type="button">遗弃</button>
            </div>
          </section>
        ) : null}

        <section className="section inbox-content-section">
          <header className="inbox-section-heading">
            <div>
              <span>深度阅读</span>
              <h3>全文报告</h3>
            </div>
          </header>
          <div className={`report-state ${report.status || "missing"}`}>
            <strong>{reportStatusLabel(report.status)}</strong>
            {report.error_message ? <p>{report.error_message}</p> : null}
            {report.model ? <p className="muted">{report.model_provider_id ? `${report.model_provider_id} · ` : ""}{report.model}</p> : null}
          </div>
          <div className="detail-actions">
            {report.status !== "done" && report.status !== "failed" ? (
              <button disabled={reportBusy} onClick={() => onGenerateReport(false)} type="button">生成全文报告</button>
            ) : null}
            {report.status === "done" || report.status === "failed" ? (
              <button disabled={reportBusy} onClick={() => onGenerateReport(true)} type="button">重新生成</button>
            ) : null}
          </div>
          {reportReady ? <LazyMarkdownReport markdown={report.report_markdown} /> : null}
        </section>

        <section className="section inbox-content-section">
          <header className="inbox-section-heading">
            <div>
              <span>推荐依据</span>
              <h3>项目关联</h3>
            </div>
          </header>
          <div className="evidence-list">
            {recommendations.length ? recommendations.map((recommendation) => (
              <article className="evidence" key={`${recommendation.project_id}-${recommendation.state}`}>
                <strong>{recommendation.project_name} · {recommendation.relation_type} · {recommendation.state}</strong>
                <p>{recommendation.reason || "暂无推荐理由。"}</p>
                {recommendation.obsidian_path ? <p className="muted">{recommendation.obsidian_path}</p> : null}
              </article>
            )) : <p className="summary">暂无项目级推荐。</p>}
          </div>
        </section>

        {judgments.length ? (
          <section className="section inbox-content-section">
            <header className="inbox-section-heading">
              <div><span>模型判断</span><h3>项目判定</h3></div>
            </header>
            <div className="evidence-list">
              {judgments.map((judgment) => (
                <article className="evidence" key={`${judgment.project_id}-${judgment.relation_type}`}>
                  <strong>{judgment.project_name} · {judgment.relation_type} · {fmtScore(judgment.usefulness_score)}</strong>
                  <p>{judgment.reason || "No judgment reason."}</p>
                  {judgment.missing_evidence ? <p className="muted">{judgment.missing_evidence}</p> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="section inbox-content-section">
          <header className="inbox-section-heading">
            <div><span>论文内容</span><h3>摘要</h3></div>
          </header>
          <p className="summary">{paper.summary}</p>
        </section>

        <details className="section inbox-content-section inbox-collapsible-section">
          <summary className="inbox-section-heading inbox-collapsible-summary">
            <div><span>检索线索</span><h3>匹配证据</h3></div>
            <span className="inbox-collapse-control"><span>展开</span><i aria-hidden="true" /></span>
          </summary>
          <div className="evidence-list inbox-retrieval-evidence">
            {evidence.length ? evidence.map((item, index) => (
              <article className="evidence" key={`${item.chunk_id || item.note_path}-${index}`}>
                <strong>{item.note_title || item.note_path} · {fmtScore(item.score)}</strong>
                {item.arxiv_text ? (
                  <>
                    <p className="muted">Paper chunk {item.arxiv_chunk_index ?? ""}{item.arxiv_page_start ? ` · pages ${item.arxiv_page_start}-${item.arxiv_page_end || item.arxiv_page_start}` : ""}</p>
                    <p>{String(item.arxiv_text).slice(0, 700)}</p>
                  </>
                ) : null}
                <p className="muted">Matched note chunk</p>
                <p>{item.text}</p>
                <p className="muted">{(item.searchers || []).join(", ")}</p>
              </article>
            )) : <p className="muted">No evidence chunks found.</p>}
          </div>
        </details>
      </div>
    </article>
  );
}

export function InboxView({ onOpenReportQueue, onSelectPaper, selectedPaperId, setStatusMessage }) {
  const cache = useApiCacheClient();
  const [activePaperId, setActivePaperId] = useState(null);

  const inboxQuery = useCachedApi(["inbox"], () => api("/api/inbox"), { staleTime: 30000 });
  const papers = inboxQuery.data?.items || [];
  const detailQuery = useCachedApi(
    ["paper", "detail", String(activePaperId || "")],
    () => api(`/api/papers/${activePaperId}`),
    { enabled: Boolean(activePaperId), staleTime: 60000 }
  );
  const detail = detailQuery.data || null;
  const inboxLoading = !inboxQuery.hasData;
  const detailMatchesActivePaper = Boolean(detail?.paper?.id) && Number(detail.paper.id) === Number(activePaperId);
  const detailLoading = Boolean(activePaperId) && (
    detailQuery.loading ||
    detailQuery.refreshing && !detailMatchesActivePaper ||
    detailQuery.hasData && !detailMatchesActivePaper
  );
  const detailPanelLoading = inboxLoading || detailLoading;
  const refreshBusy = inboxQuery.loading || inboxQuery.refreshing || detailQuery.refreshing;
  const reportReadyCount = papers.filter((paper) => paper.report_status === "done").length;
  const linkedProjectCount = new Set(papers.flatMap((paper) => (
    Array.isArray(paper.project_names) ? paper.project_names : [paper.project_name]
  )).filter(Boolean)).size;

  useEffect(() => {
    if (!inboxQuery.hasData) return;
    const routePaperId = Number(selectedPaperId || 0);
    const routePaperInInbox = routePaperId && papers.some((paper) => Number(paper.id) === routePaperId);
    const activeStillExists = activePaperId && papers.some((paper) => Number(paper.id) === Number(activePaperId));
    const nextId = routePaperInInbox ? routePaperId : activeStillExists ? activePaperId : papers[0]?.id;
    if (nextId) {
      setActivePaperId(Number(nextId));
      if (Number(nextId) !== routePaperId) onSelectPaper?.(nextId, { replace: true });
      return;
    }
    setActivePaperId(null);
  }, [activePaperId, inboxQuery.hasData, onSelectPaper, papers, selectedPaperId]);

  useEffect(() => {
    const error = inboxQuery.error || detailQuery.error;
    if (error) setStatusMessage(error.message);
  }, [detailQuery.error, inboxQuery.error, setStatusMessage]);

  async function refresh() {
    await Promise.all([
      inboxQuery.refresh({ force: true }),
      activePaperId ? detailQuery.refresh({ force: true }) : Promise.resolve()
    ]);
  }

  async function updateRecommendation(payload) {
    if (!activePaperId) return;
    try {
      const paperId = Number(activePaperId);
      await postJson(`/api/papers/${activePaperId}/recommendation`, payload);
      inboxQuery.patch((current) => ({
        ...(current || {}),
        items: (current?.items || []).filter((paper) => Number(paper.id) !== paperId)
      }));
      cache.markStale(["library", "list"]);
      cache.markStale(["projects"]);
      setStatusMessage(payload.action === "discard" ? "已遗弃推荐" : "已保存到论文仓库");
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function generateReport(force = false) {
    if (!activePaperId) return;
    try {
      const data = await postJson(`/api/papers/${activePaperId}/report`, { force });
      if (data?.queued) {
        inboxQuery.patch((current) => ({
          ...(current || {}),
          items: (current?.items || []).map((paper) => (
            Number(paper.id) === Number(activePaperId)
              ? { ...paper, report_status: "queued" }
              : paper
          ))
        }));
        cache.markStale(["jobs", "summary"]);
        cache.markStale(["jobs", "history"]);
        cache.markStale(["paper-reports", "summary"]);
        cache.markStale(cacheNamespace("reader", "papers"));
        setStatusMessage("全文报告已加入生成队列");
        return;
      }
      cache.setCache(["paper", "detail", String(activePaperId)], data);
      inboxQuery.patch((current) => ({
        ...(current || {}),
        items: (current?.items || []).map((paper) => (
          Number(paper.id) === Number(activePaperId)
            ? { ...paper, report_status: data.paper_report?.status || paper.report_status }
            : paper
        ))
      }));
      cache.markStale(["paper-reports", "summary"]);
      cache.markStale(cacheNamespace("reader", "papers"));
      const nextReport = data.paper_report || {};
      setStatusMessage(nextReport.status === "done" ? "全文报告已生成" : reportStatusLabel(nextReport.status));
    } catch (error) {
      setStatusMessage(error.message);
      await detailQuery.refresh({ force: true }).catch(() => {});
    }
  }

  return (
    <section className="view inbox-view vision-inbox">
      <header className="vision-topbar inbox-topbar">
        <div className="vision-brand">
          <span>论文工作区</span>
          <h1>待判断</h1>
        </div>
        <div className="vision-top-actions">
          <span className={`vision-live-state ${papers.length ? "queued" : "ready"}`}>
            <i aria-hidden="true" />
            {inboxLoading ? "读取队列" : papers.length ? `${papers.length} 篇待处理` : "队列已清空"}
          </span>
          <RefreshButton className="vision-refresh" busy={refreshBusy} onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
        </div>
      </header>

      <section className="inbox-summary-strip" aria-label="待判断概览">
        <div><span>候选论文</span><strong>{inboxLoading ? "—" : papers.length}</strong><p>等待人工判断</p></div>
        <div><span>报告就绪</span><strong>{inboxLoading ? "—" : reportReadyCount}</strong><p>可直接深度阅读</p></div>
        <div><span>关联项目</span><strong>{inboxLoading ? "—" : linkedProjectCount}</strong><p>本轮覆盖范围</p></div>
      </section>

      <main className="inbox-workspace-grid">
        <section className="inbox-panel" aria-label="论文 inbox">
          <header className="inbox-list-heading">
          <div>
              <span>决策队列</span>
              <h2>候选论文</h2>
              <p>{inboxLoading ? "正在读取待判断论文" : "按匹配情况逐篇完成取舍"}</p>
          </div>
            <em>{inboxLoading ? "…" : papers.length}</em>
          </header>
          <div className="paper-list inbox-paper-list">
          {inboxLoading ? (
            <WorkspacePaneLoader rows={6} title="读取待判断论文" variant="list" />
          ) : (
            <PaperList
              papers={papers}
              activePaperId={activePaperId}
              onSelect={(id) => {
                if (onSelectPaper) {
                  onSelectPaper(id);
                  return;
                }
                setActivePaperId(Number(id));
              }}
            />
          )}
          </div>
        </section>

        <section className="detail-panel inbox-detail-panel" aria-label="论文详情">
        {detailPanelLoading ? (
          <WorkspacePaneLoader
            description={detailLoading ? "正在读取所选论文的摘要、项目判定和全文报告。" : "正在读取待判断论文列表和首篇论文详情。"}
            title={detailLoading ? "打开论文详情" : "读取论文详情"}
            variant="detail"
          />
        ) : (
          <div className="inbox-detail-transition" key={detail?.paper?.id || "empty"}>
            <PaperDetail detail={detail} onGenerateReport={generateReport} onOpenReportQueue={onOpenReportQueue} onRecommendation={updateRecommendation} />
          </div>
        )}
        </section>
      </main>
    </section>
  );
}
