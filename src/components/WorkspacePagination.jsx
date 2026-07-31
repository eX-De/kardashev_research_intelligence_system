import { useTranslation } from "react-i18next";
import "../styles/WorkspacePagination.css";

export const WORKSPACE_PAGE_SIZE_VALUES = ["10", "25", "50", "100"];

export function useWorkspacePageSizeOptions() {
  const { t } = useTranslation("common");
  return WORKSPACE_PAGE_SIZE_VALUES.map((value) => [value, t("pagination.perPage", { count: value })]);
}

export function WorkspacePagination({
  className = "",
  compact = false,
  currentPage,
  loading = false,
  onNext,
  onPrevious,
  pageCount
}) {
  const { t } = useTranslation("common");
  return (
    <div className={`pagination-row paper-pagination-row workspace-pagination ${compact ? "is-compact" : ""} ${className}`.trim()}>
      <button aria-label={t("actions.previousPage")} disabled={currentPage <= 1 || loading} onClick={onPrevious} type="button">{t("actions.previousPage")}</button>
      <span>{t(compact ? "pagination.compact" : "pagination.summary", { current: currentPage, count: pageCount })}</span>
      <button aria-label={t("actions.nextPage")} disabled={currentPage >= pageCount || loading} onClick={onNext} type="button">{t("actions.nextPage")}</button>
    </div>
  );
}
