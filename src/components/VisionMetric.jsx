import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "../styles/VisionMetric.css";

export function formatMetricCount(value, locale = "zh-CN") {
  const count = Number(value);
  return Number.isFinite(count) ? new Intl.NumberFormat(locale).format(count) : "0";
}

export function VisionMetric({ hint, label, tone, to, value }) {
  const { i18n } = useTranslation();
  const content = (
    <>
      <span>{label}</span>
      <strong>{formatMetricCount(value, i18n.resolvedLanguage)}</strong>
      <p>{hint}</p>
    </>
  );
  const className = ["vision-stat", tone].filter(Boolean).join(" ");

  if (to) return <Link className={className} to={to}>{content}</Link>;
  return <article className={className}>{content}</article>;
}
