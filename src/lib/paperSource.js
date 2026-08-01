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
  const importedAt = Date.parse(String(item?.last_imported_at || item?.created_at || ""));
  const currentTime = Number(now);
  if (!Number.isFinite(importedAt) || !Number.isFinite(currentTime)) return false;
  const age = currentTime - importedAt;
  return age >= 0 && age <= RECENT_MANUAL_IMPORT_WINDOW_MS;
}
