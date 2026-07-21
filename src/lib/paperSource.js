export const PAPER_SOURCE_FILTER_OPTIONS = [
  ["all", "全部来源"],
  ["daily", "每日任务"],
  ["manual", "手动导入"]
];

export const RECENT_MANUAL_IMPORT_WINDOW_MS = 30 * 60 * 1000;

export function paperSourceFilterLabel(source) {
  return PAPER_SOURCE_FILTER_OPTIONS.find(([value]) => value === source)?.[1] || "全部来源";
}

export function isRecentManualPaperImport(item, now = Date.now()) {
  if (item?.source !== "manual") return false;
  const createdAt = Date.parse(String(item?.created_at || ""));
  const currentTime = Number(now);
  if (!Number.isFinite(createdAt) || !Number.isFinite(currentTime)) return false;
  const age = currentTime - createdAt;
  return age >= 0 && age <= RECENT_MANUAL_IMPORT_WINDOW_MS;
}
