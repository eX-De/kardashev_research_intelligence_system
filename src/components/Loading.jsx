import "../styles/Loading.css";

const DEFAULT_SKELETON_WIDTHS = ["92%", "78%", "86%", "64%"];

function classes(...items) {
  return items.filter(Boolean).join(" ");
}

export function InlineLoader({ className = "", compact = false, label = "加载中" }) {
  return (
    <span className={classes("inline-loader", compact && "compact", className)} role="status" aria-live="polite">
      <span className="loader-dot" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

export function SkeletonBlock({ className = "", lines = 3, widths = DEFAULT_SKELETON_WIDTHS }) {
  const count = Math.max(1, Number(lines) || 1);
  const lineWidths = widths.length ? widths : DEFAULT_SKELETON_WIDTHS;
  return (
    <div className={classes("skeleton-block", className)} aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <span key={index} style={{ "--skeleton-width": lineWidths[index % lineWidths.length] }} />
      ))}
    </div>
  );
}

export function LoadingPanel({
  className = "",
  compact = false,
  description = "",
  rows = 4,
  title = "加载中"
}) {
  return (
    <div className={classes("loading-panel", compact && "compact", className)} role="status" aria-live="polite">
      <div className="loading-panel-head">
        <InlineLoader label={title} />
        {description ? <p>{description}</p> : null}
      </div>
      <SkeletonBlock lines={rows} />
    </div>
  );
}

export function PageLoader({ className = "", description = "正在读取数据。", title = "加载中" }) {
  return (
    <section className={classes("view page-loader", className)}>
      <LoadingPanel description={description} rows={5} title={title} />
    </section>
  );
}

export function MarkdownReportLoader() {
  return (
    <LoadingPanel
      className="paper-report markdown-report markdown-report-loading"
      description="正在载入报告渲染模块。"
      rows={3}
      title="报告渲染中"
    />
  );
}
