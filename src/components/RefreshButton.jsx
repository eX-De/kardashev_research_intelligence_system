export function RefreshButton({ busy = false, className = "", disabled = false, label = "刷新", onClick, title }) {
  const accessibleLabel = busy ? `${label}中` : label;
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
