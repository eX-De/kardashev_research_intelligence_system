import { Link } from "react-router-dom";

export function formatMetricCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? new Intl.NumberFormat("zh-CN").format(count) : "0";
}

export function VisionMetric({ hint, label, tone, to, value }) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{formatMetricCount(value)}</strong>
      <p>{hint}</p>
    </>
  );
  const className = ["vision-stat", tone].filter(Boolean).join(" ");

  if (to) return <Link className={className} to={to}>{content}</Link>;
  return <article className={className}>{content}</article>;
}
