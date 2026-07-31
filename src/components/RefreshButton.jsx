import { useTranslation } from "react-i18next";
import "../styles/RefreshButton.css";

export function RefreshButton({ busy = false, className = "", disabled = false, label, onClick, title }) {
  const { t } = useTranslation("common");
  const resolvedLabel = label === undefined ? t("actions.refresh") : label;
  const accessibleLabel = busy ? t("actions.inProgress", { action: resolvedLabel, defaultValue: `${resolvedLabel}…` }) : resolvedLabel;
  const classes = ["icon-button", className].filter(Boolean).join(" ");

  return (
    <button
      aria-label={accessibleLabel}
      className={classes}
      disabled={disabled || busy}
      onClick={onClick}
      title={title || accessibleLabel}
      type="button"
    >
      <span aria-hidden="true">↻</span>
    </button>
  );
}
