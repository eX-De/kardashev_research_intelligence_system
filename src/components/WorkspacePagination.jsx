import "../styles/WorkspacePagination.css";

export const WORKSPACE_PAGE_SIZE_OPTIONS = [
  ["10", "10/页"],
  ["25", "25/页"],
  ["50", "50/页"],
  ["100", "100/页"]
];

export function WorkspacePagination({
  className = "",
  compact = false,
  currentPage,
  loading = false,
  onNext,
  onPrevious,
  pageCount
}) {
  return (
    <div className={`pagination-row paper-pagination-row workspace-pagination ${compact ? "is-compact" : ""} ${className}`.trim()}>
      <button aria-label="上一页" disabled={currentPage <= 1 || loading} onClick={onPrevious} type="button">上一页</button>
      <span>{compact ? `${currentPage} / ${pageCount}` : `第 ${currentPage} 页，共 ${pageCount} 页`}</span>
      <button aria-label="下一页" disabled={currentPage >= pageCount || loading} onClick={onNext} type="button">下一页</button>
    </div>
  );
}
