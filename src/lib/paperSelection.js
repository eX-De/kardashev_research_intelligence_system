function normalizedPaperId(value) {
  const paperId = Number(value || 0);
  return Number.isFinite(paperId) && paperId > 0 ? paperId : null;
}

export function resolvePaperListSelection({
  activeId,
  allowRouteOutsideItems = false,
  items = [],
  routePaperId,
  selectFirst = false
}) {
  const itemIds = items.map((item) => normalizedPaperId(item?.id)).filter(Boolean);
  if (!itemIds.length) return null;
  if (selectFirst) return itemIds[0];

  const normalizedRouteId = normalizedPaperId(routePaperId);
  if (normalizedRouteId && (allowRouteOutsideItems || itemIds.includes(normalizedRouteId))) {
    return normalizedRouteId;
  }

  const normalizedActiveId = normalizedPaperId(activeId);
  if (normalizedActiveId && itemIds.includes(normalizedActiveId)) return normalizedActiveId;

  return itemIds[0];
}

export function resolveListDetailId({ activeId, items = [], routeEntityId }) {
  const normalizedRouteId = normalizedPaperId(routeEntityId);
  if (normalizedRouteId) return normalizedRouteId;

  const itemIds = items.map((item) => normalizedPaperId(item?.id)).filter(Boolean);
  const normalizedActiveId = normalizedPaperId(activeId);
  if (normalizedActiveId && itemIds.includes(normalizedActiveId)) return normalizedActiveId;
  return itemIds[0] || null;
}

export function resolveLocatedListPage({
  currentPage,
  locatedEntityId,
  locatedPage,
  routeEntityId,
  selectFirst = false
}) {
  const page = normalizedPaperId(currentPage) || 1;
  if (selectFirst) return page;

  const normalizedRouteId = normalizedPaperId(routeEntityId);
  const normalizedLocatedId = normalizedPaperId(locatedEntityId);
  const normalizedLocatedPage = normalizedPaperId(locatedPage);
  if (!normalizedRouteId || normalizedRouteId !== normalizedLocatedId || !normalizedLocatedPage) return page;
  return normalizedLocatedPage;
}

export function shouldLocateListRoute({ items = [], routeEntityId, selectFirst = false }) {
  if (selectFirst) return false;
  const normalizedRouteId = normalizedPaperId(routeEntityId);
  if (!normalizedRouteId) return false;
  return !items.some((item) => normalizedPaperId(item?.id) === normalizedRouteId);
}

export function shouldResetListFiltersForMissingRoute({
  hasLocationData = false,
  hasRestrictiveFilters = false,
  locatedEntityId,
  routeEntityId,
  shouldLocateRoute = false
}) {
  if (!hasLocationData || !hasRestrictiveFilters || !shouldLocateRoute) return false;
  const normalizedRouteId = normalizedPaperId(routeEntityId);
  const normalizedLocatedId = normalizedPaperId(locatedEntityId);
  return Boolean(normalizedRouteId && normalizedRouteId !== normalizedLocatedId);
}

export function commitPaperListSelection({ onRouteSelect, onSelectLocal, paperId }) {
  const normalizedId = normalizedPaperId(paperId);
  if (!normalizedId) return null;

  if (typeof onRouteSelect === "function") {
    onRouteSelect(normalizedId);
  } else {
    onSelectLocal?.(normalizedId);
  }
  return normalizedId;
}

export function resolveReaderQueueSelection({
  activeId,
  allowRouteOutsideItems = false,
  items = [],
  pendingRouteId,
  routePaperId,
  selectFirst = false
}) {
  const itemIds = items
    .map((item) => normalizedPaperId(item?.paper_id ?? item?.id))
    .filter(Boolean);
  if (selectFirst) return itemIds[0] || null;

  const normalizedPendingId = normalizedPaperId(pendingRouteId);
  if (normalizedPendingId && itemIds.includes(normalizedPendingId)) return normalizedPendingId;

  const normalizedRouteId = normalizedPaperId(routePaperId);
  if (normalizedRouteId && (allowRouteOutsideItems || itemIds.includes(normalizedRouteId))) {
    return normalizedRouteId;
  }

  const normalizedActiveId = normalizedPaperId(activeId);
  if (normalizedActiveId && itemIds.includes(normalizedActiveId)) return normalizedActiveId;
  return itemIds[0] || null;
}
