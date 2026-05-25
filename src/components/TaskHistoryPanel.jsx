import { LoadingPanel } from "./Loading.jsx";
import { PanelTitle } from "./PanelTitle.jsx";
import { fmtDate, summarizeMeta } from "../lib/dashboard.js";

function HistoryTable({ history }) {
  if (!history.length) return <p className="muted">暂无任务记录。</p>;
  return (
    <div className="history-table">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>开始</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {history.map((item) => (
            <tr key={item.id}>
              <td>{item.job_type}</td>
              <td><span className={`pill ${item.status === "failed" ? "bad-pill" : ""}`}>{item.status}</span></td>
              <td>{fmtDate(item.started_at)}</td>
              <td>{item.message || summarizeMeta(item.meta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TaskHistoryPanel({ history = [], loading = false, refreshing = false }) {
  return (
    <section className="panel task-history-panel">
      <PanelTitle title="任务历史" subtitle="最近任务执行记录。" />
      {loading ? <LoadingPanel compact rows={6} title="读取任务历史" /> : <HistoryTable history={history} />}
      {refreshing ? <p className="muted">正在更新任务历史...</p> : null}
    </section>
  );
}
