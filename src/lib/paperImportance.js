export const PAPER_IMPORTANCE_CODES = ["", "high", "medium", "low"];

export function paperImportanceOptions(t) {
  return PAPER_IMPORTANCE_CODES.map((value) => [value, t(`importance.${value || "all"}`)]);
}

export function paperImportanceLabel(importance, t) {
  if (!importance) return t("importance.unlabeled");
  return ["high", "medium", "low"].includes(importance)
    ? t(`importance.${importance}`)
    : importance;
}
