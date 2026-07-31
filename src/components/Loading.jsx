import { useTranslation } from "react-i18next";
import "../styles/Loading.css";

const DEFAULT_SKELETON_WIDTHS = ["92%", "78%", "86%", "64%"];

function classes(...items) {
  return items.filter(Boolean).join(" ");
}

export function InlineLoader({ className = "", compact = false, label }) {
  const { t } = useTranslation("common");
  const resolvedLabel = label === undefined ? t("loading.default") : label;
  return (
    <span className={classes("inline-loader", compact && "compact", className)} role="status" aria-live="polite">
      <span className="loader-dot" aria-hidden="true" />
      {resolvedLabel ? <span>{resolvedLabel}</span> : null}
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
  title
}) {
  const { t } = useTranslation("common");
  const resolvedTitle = title === undefined ? t("loading.default") : title;
  return (
    <div className={classes("loading-panel", compact && "compact", className)} role="status" aria-live="polite">
      <div className="loading-panel-head">
        <InlineLoader label={resolvedTitle} />
        {description ? <p>{description}</p> : null}
      </div>
      <SkeletonBlock lines={rows} />
    </div>
  );
}

export function PageLoader({ className = "", description, title }) {
  const { t } = useTranslation("common");
  return (
    <section className={classes("view page-loader", className)}>
      <LoadingPanel
        description={description === undefined ? t("loading.dataDescription") : description}
        rows={5}
        title={title === undefined ? t("loading.default") : title}
      />
    </section>
  );
}

export function MarkdownReportLoader() {
  const { t } = useTranslation("common");
  return (
    <LoadingPanel
      className="paper-report markdown-report markdown-report-loading"
      description={t("loading.reportDescription")}
      rows={3}
      title={t("loading.reportTitle")}
    />
  );
}
