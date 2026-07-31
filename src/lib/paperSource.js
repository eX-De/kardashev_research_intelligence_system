export const PAPER_SOURCE_FILTER_CODES = ["all", "daily", "manual"];

export function paperSourceFilterOptions(t) {
  return PAPER_SOURCE_FILTER_CODES.map((value) => [value, t(`sourceFilter.${value}`)]);
}

export const RECENT_MANUAL_IMPORT_WINDOW_MS = 30 * 60 * 1000;

export function paperSourceFilterLabel(source, t) {
  const value = PAPER_SOURCE_FILTER_CODES.includes(source) ? source : "all";
  return t(`sourceFilter.${value}`);
}

export function isRecentManualPaperImport(item, now = Date.now()) {
  if (item?.source !== "manual") return false;
  const createdAt = Date.parse(String(item?.created_at || ""));
  const currentTime = Number(now);
  if (!Number.isFinite(createdAt) || !Number.isFinite(currentTime)) return false;
  const age = currentTime - createdAt;
  return age >= 0 && age <= RECENT_MANUAL_IMPORT_WINDOW_MS;
}
