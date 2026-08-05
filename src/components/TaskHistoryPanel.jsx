import { useTranslation } from "react-i18next";

import { LoadingPanel } from "./Loading.jsx";
import { PanelTitle } from "./PanelTitle.jsx";
import { fmtDate, jobTitle, summarizeMeta } from "../lib/dashboard.js";
import "../styles/TaskHistoryPanel.css";

function HistoryTable({ history }) {
  const { i18n, t } = useTranslation(["settings", "common"]);
  if (!history.length) return <p className="muted">{t("taskHistory.empty")}</p>;
  return (
    <div className="history-table">
      <table>
        <thead>
          <tr>
            <th>{t("taskHistory.columns.task")}</th>
            <th>{t("taskHistory.columns.status")}</th>
            <th>{t("taskHistory.columns.started")}</th>
            <th>{t("taskHistory.columns.result")}</th>
          </tr>
        </thead>
        <tbody>
          {history.map((item) => (
            <tr key={`${item.record_type || "worker_job"}:${item.worker_job_id || item.job_run_id || item.id}`}>
              <td>{jobTitle(item.job_type, t)}</td>
              <td><span className={`pill ${item.status === "failed" ? "bad-pill" : ""}`}>{t(`common:jobStatus.${item.status}`, { defaultValue: item.status })}</span></td>
              <td>{fmtDate(item.started_at, i18n.resolvedLanguage || i18n.language)}</td>
              <td>{item.message || summarizeMeta(item.meta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TaskHistoryPanel({ history = [], loading = false, refreshing = false }) {
  const { t } = useTranslation("settings");
  return (
    <section className="panel task-history-panel">
      <PanelTitle title={t("taskHistory.title")} subtitle={t("taskHistory.subtitle")} />
      {loading ? <LoadingPanel compact rows={6} title={t("taskHistory.loading")} /> : <HistoryTable history={history} />}
      {refreshing ? <p className="muted">{t("taskHistory.refreshing")}</p> : null}
    </section>
  );
}
