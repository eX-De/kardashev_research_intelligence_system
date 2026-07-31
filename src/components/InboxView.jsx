import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cacheNamespace, useApiCacheClient, useCachedApi } from "../lib/apiCache.jsx";
import { api, fmtScore, postJson } from "../lib/dashboard.js";
import { LazyMarkdownReport } from "./LazyMarkdownReport.jsx";
import { RefreshButton } from "./RefreshButton.jsx";
import { WorkspacePaneLoader } from "./WorkspacePaneLoader.jsx";
import "../styles/InboxView.css";

function reportStatusLabel(status, t) {
  return t(`reportStatus.${status || "missing"}`, { defaultValue: status || t("reportStatus.missing") });
}

function relationLabel(relation, t) {
  return t(`relation.${relation || "possible"}`, { defaultValue: relation || t("relation.possible") });
}

function workflowStateLabel(state, t) {
  return t(`workflowState.${state || "unknown"}`, { defaultValue: state || t("workflowState.unknown") });
}

function PaperList({ papers, activePaperId, onSelect }) {
  const { t } = useTranslation("papers");
  if (!papers.length) {
    return (
      <div className="inbox-empty-state">
        <span aria-hidden="true">✓</span>
        <h2>{t("inbox.empty.title")}</h2>
        <p>{t("inbox.empty.description")}</p>
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
          <span className="inbox-score">{t("common.match", { score: fmtScore(paper.score) })}</span>
          <span className={`inbox-report-status ${paper.report_status || "missing"}`}>{reportStatusLabel(paper.report_status, t)}</span>
        </div>
        <h2>{paper.title}</h2>
        {projectNames.length ? (
          <div className="inbox-project-match">
            <strong>{t("relation.possible")}</strong>
            <div>{projectNames.map((projectName) => <span key={projectName}>{projectName}</span>)}</div>
          </div>
        ) : null}
        <div className="inbox-paper-meta">
          {paper.relation_type ? <span>{paper.relation_type}</span> : null}
          <span>{(paper.categories || []).slice(0, 2).join(" · ") || "arXiv"}</span>
          {paper.feedback_status ? <span>{workflowStateLabel(paper.feedback_status, t)}</span> : null}
        </div>
      </article>
    );
  });
}

function PaperDetail({ detail, onOpenReportQueue, onRecommendation, onGenerateReport }) {
  const { t } = useTranslation("papers");
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
        <h2>{t("inbox.detail.selectTitle")}</h2>
        <p>{t("inbox.detail.selectDescription")}</p>
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
    ["high", t("importance.high"), t("importance.hint.high")],
    ["medium", t("importance.medium"), t("importance.hint.medium")],
    ["low", t("importance.low"), t("importance.hint.low")]
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
          <span className="inbox-detail-eyebrow">{t("inbox.detail.candidate", { id: paper.arxiv_id || "arXiv" })}</span>
          <h2>{paper.title}</h2>
          <p className="inbox-detail-authors">{(paper.authors || []).slice(0, 6).join(", ") || t("common.noAuthors")}</p>
          <div className="inbox-detail-meta">
            <a href={paper.link} target="_blank" rel="noreferrer">{t("inbox.detail.openArxiv")} ↗</a>
            <span>{(paper.categories || []).join(" · ") || t("common.uncategorized")}</span>
            <span>{t("inbox.detail.fullTextStatus", { status: paper.text_status || "pending" })}</span>
          </div>
        </header>

        {pendingRecommendations.length ? (
          <section className="recommendation-control inbox-decision-card">
            <header className="inbox-section-heading">
              <div>
                <span>{t("inbox.decision.eyebrow")}</span>
                <h3>{t("inbox.decision.title")}</h3>
              </div>
              <em>{t("inbox.decision.suggestionCount", { count: pendingRecommendations.length })}</em>
            </header>
            <p className="inbox-decision-hint">{t("inbox.decision.hint")}</p>
            <div className="importance-row" role="group" aria-label={t("common.importance")}>
              <span>{t("common.importance")}</span>
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
                      <span>{relationLabel(recommendation.relation_type, t)}</span>
                      <span>{t("common.match", { score: fmtScore(recommendation.usefulness_score) })}</span>
                    </small>
                  </span>
                </label>
                );
              })}
            </div>
            <div className="detail-actions inbox-primary-actions">
              <button className="primary" disabled={!canAccept} onClick={() => onRecommendation({ action: "accept", importance, project_ids: selectedProjectIds })} type="button">{t("inbox.actions.save")}</button>
              <button onClick={() => onOpenReportQueue?.(paper.id)} title={t("inbox.actions.openReportTitle", { status: reportStatusLabel(report.status, t) })} type="button">{t("inbox.actions.openReport")}</button>
              <button className="danger" onClick={() => onRecommendation({ action: "discard" })} type="button">{t("inbox.actions.discard")}</button>
            </div>
          </section>
        ) : null}

        <section className="section inbox-content-section">
          <header className="inbox-section-heading">
            <div>
              <span>{t("inbox.sections.recommendationEvidence")}</span>
              <h3>{t("inbox.sections.projectLinks")}</h3>
            </div>
          </header>
          <div className="evidence-list">
            {recommendations.length ? recommendations.map((recommendation) => (
              <article className="evidence" key={`${recommendation.project_id}-${recommendation.state}`}>
                <strong>{recommendation.project_name} · {relationLabel(recommendation.relation_type, t)} · {workflowStateLabel(recommendation.state, t)}</strong>
                <p>{recommendation.reason || t("inbox.noRecommendationReason")}</p>
                {recommendation.obsidian_path ? <p className="muted">{recommendation.obsidian_path}</p> : null}
              </article>
            )) : <p className="summary">{t("inbox.noProjectRecommendations")}</p>}
          </div>
        </section>

        <section className="section inbox-content-section">
          <header className="inbox-section-heading">
            <div>
              <span>{t("inbox.sections.deepReading")}</span>
              <h3>{t("inbox.sections.fullReport")}</h3>
            </div>
          </header>
          <div className={`report-state ${report.status || "missing"}`}>
            <strong>{reportStatusLabel(report.status, t)}</strong>
            {report.error_message ? <p>{report.error_message}</p> : null}
            {report.model ? <p className="muted">{report.model_provider_id ? `${report.model_provider_id} · ` : ""}{report.model}</p> : null}
          </div>
          <div className="detail-actions">
            {report.status !== "done" && report.status !== "failed" ? (
              <button disabled={reportBusy} onClick={() => onGenerateReport(false)} type="button">{t("inbox.actions.generateReport")}</button>
            ) : null}
            {report.status === "done" || report.status === "failed" ? (
              <button disabled={reportBusy} onClick={() => onGenerateReport(true)} type="button">{t("inbox.actions.regenerate")}</button>
            ) : null}
          </div>
          {reportReady ? <LazyMarkdownReport markdown={report.report_markdown} /> : null}
        </section>

        {judgments.length ? (
          <section className="section inbox-content-section">
            <header className="inbox-section-heading">
              <div><span>{t("inbox.sections.modelJudgment")}</span><h3>{t("inbox.sections.projectJudgment")}</h3></div>
            </header>
            <div className="evidence-list">
              {judgments.map((judgment) => (
                <article className="evidence" key={`${judgment.project_id}-${judgment.relation_type}`}>
                  <strong>{judgment.project_name} · {relationLabel(judgment.relation_type, t)} · {fmtScore(judgment.usefulness_score)}</strong>
                  <p>{judgment.reason || t("inbox.noJudgmentReason")}</p>
                  {judgment.missing_evidence ? <p className="muted">{judgment.missing_evidence}</p> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="section inbox-content-section">
          <header className="inbox-section-heading">
            <div><span>{t("inbox.sections.paperContent")}</span><h3>{t("inbox.sections.abstract")}</h3></div>
          </header>
          <p className="summary">{paper.summary}</p>
        </section>

        <details className="section inbox-content-section inbox-collapsible-section">
          <summary className="inbox-section-heading inbox-collapsible-summary">
            <div><span>{t("inbox.sections.retrievalClues")}</span><h3>{t("inbox.sections.matchEvidence")}</h3></div>
            <span className="inbox-collapse-control">
              <span data-collapse-label={t("common.collapse")}>{t("common.expand")}</span>
              <i aria-hidden="true" />
            </span>
          </summary>
          <div className="evidence-list inbox-retrieval-evidence">
            {evidence.length ? evidence.map((item, index) => (
              <article className="evidence" key={`${item.chunk_id || item.note_path}-${index}`}>
                <strong>{item.note_title || item.note_path} · {fmtScore(item.score)}</strong>
                {item.arxiv_text ? (
                  <>
                    <p className="muted">{t("inbox.evidence.paperChunk", { index: item.arxiv_chunk_index ?? "", pages: item.arxiv_page_start ? `${item.arxiv_page_start}-${item.arxiv_page_end || item.arxiv_page_start}` : "" })}</p>
                    <p>{String(item.arxiv_text).slice(0, 700)}</p>
                  </>
                ) : null}
                <p className="muted">{t("inbox.evidence.matchedNoteChunk")}</p>
                <p>{item.text}</p>
                <p className="muted">{(item.searchers || []).join(", ")}</p>
              </article>
            )) : <p className="muted">{t("inbox.evidence.empty")}</p>}
          </div>
        </details>
      </div>
    </article>
  );
}

export function InboxView({ notify = () => {}, onOpenReportQueue, onSelectPaper, selectedPaperId, setStatusMessage }) {
  const { t } = useTranslation("papers");
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
      cache.markStale(cacheNamespace("artifact"));
      const successMessage = payload.action === "discard" ? t("inbox.status.discarded") : t("inbox.status.saved");
      setStatusMessage(successMessage);
      notify(successMessage, { type: "success" });
    } catch (error) {
      setStatusMessage(error.message);
    }
  }

  async function generateReport(force = false) {
    const reportPaperId = Number(detail?.paper?.id || 0);
    if (!activePaperId || !reportPaperId) return;
    try {
      const data = await postJson(`/api/papers/${reportPaperId}/report`, { force });
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
        setStatusMessage(t("inbox.status.reportQueued"));
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
      setStatusMessage(nextReport.status === "done" ? t("reportStatus.done") : reportStatusLabel(nextReport.status, t));
    } catch (error) {
      setStatusMessage(error.message);
      await detailQuery.refresh({ force: true }).catch(() => {});
    }
  }

  return (
    <section className="view inbox-view vision-inbox">
      <header className="vision-topbar inbox-topbar">
        <div className="vision-brand">
          <span>{t("common.workspace")}</span>
          <h1>{t("inbox.title")}</h1>
        </div>
        <div className="vision-top-actions">
          <span className={`vision-live-state ${papers.length ? "queued" : "ready"}`}>
            <i aria-hidden="true" />
            {inboxLoading ? t("inbox.live.loading") : papers.length ? t("inbox.live.pending", { count: papers.length }) : t("inbox.live.empty")}
          </span>
          <RefreshButton className="vision-refresh" busy={refreshBusy} onClick={() => refresh().catch((error) => setStatusMessage(error.message))} />
        </div>
      </header>

      <section className="inbox-summary-strip" aria-label={t("inbox.summary.aria")}>
        <div><span>{t("inbox.summary.candidates")}</span><strong>{inboxLoading ? "—" : papers.length}</strong><p>{t("inbox.summary.awaiting")}</p></div>
        <div><span>{t("inbox.summary.ready")}</span><strong>{inboxLoading ? "—" : reportReadyCount}</strong><p>{t("inbox.summary.deepRead")}</p></div>
        <div><span>{t("inbox.summary.projects")}</span><strong>{inboxLoading ? "—" : linkedProjectCount}</strong><p>{t("inbox.summary.coverage")}</p></div>
      </section>

      <main className="inbox-workspace-grid">
        <section className="inbox-panel" aria-label={t("inbox.aria.list")}>
          <header className="inbox-list-heading">
          <div>
              <span>{t("inbox.list.eyebrow")}</span>
              <h2>{t("inbox.list.title")}</h2>
              <p>{inboxLoading ? t("inbox.list.loading") : t("inbox.list.description")}</p>
          </div>
            <em>{inboxLoading ? "…" : papers.length}</em>
          </header>
          <div className="paper-list inbox-paper-list">
          {inboxLoading ? (
            <WorkspacePaneLoader rows={6} title={t("inbox.list.loader")} variant="list" />
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

        <section className="detail-panel inbox-detail-panel" aria-label={t("inbox.aria.detail")}>
        {detailPanelLoading ? (
          <WorkspacePaneLoader
            description={detailLoading ? t("inbox.detail.loadingSelected") : t("inbox.detail.loadingFirst")}
            title={detailLoading ? t("inbox.detail.opening") : t("inbox.detail.loading")}
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
