export const PAPER_IMPORTANCE_OPTIONS = [
  ["", "全部重要性"],
  ["high", "高"],
  ["medium", "中"],
  ["low", "低"]
];

const PAPER_IMPORTANCE_LABELS = Object.fromEntries(PAPER_IMPORTANCE_OPTIONS.filter(([value]) => value));

export function paperImportanceLabel(importance) {
  return PAPER_IMPORTANCE_LABELS[importance] || importance || "未标注";
}
