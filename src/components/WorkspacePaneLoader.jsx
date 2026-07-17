import { InlineLoader } from "./Loading.jsx";
import "../styles/WorkspacePaneLoader.css";

function ListSkeleton({ rows }) {
  return (
    <div className="workspace-pane-list-skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="workspace-pane-list-row" key={index}>
          <i />
          <span>
            <b />
            <small />
          </span>
          <em />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton({ report = false }) {
  return (
    <div className={`workspace-pane-detail-skeleton ${report ? "is-report" : ""}`} aria-hidden="true">
      <div className="workspace-pane-detail-hero">
        <span />
        <strong />
        <strong />
        <div><i /><i /><i /></div>
      </div>
      <div className="workspace-pane-detail-columns">
        <section><b /><span /><span /><span /></section>
        <section><b /><span /><span /></section>
      </div>
      {report ? <div className="workspace-pane-report-composer"><span /><i /></div> : null}
    </div>
  );
}

export function WorkspacePaneLoader({
  className = "",
  description = "",
  rows = 6,
  title = "读取工作区",
  variant = "detail"
}) {
  const classes = ["workspace-pane-loader", `is-${variant}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role="status" aria-live="polite">
      <header className="workspace-pane-loader-head">
        <InlineLoader label={title} />
        {description ? <p>{description}</p> : null}
      </header>
      {variant === "list" ? <ListSkeleton rows={rows} /> : <DetailSkeleton report={variant === "report"} />}
    </div>
  );
}
