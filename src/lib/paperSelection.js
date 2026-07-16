function normalizedPaperId(value) {
  const paperId = Number(value || 0);
  return Number.isFinite(paperId) && paperId > 0 ? paperId : null;
}

export function resolvePaperListSelection({ activeId, items = [], routePaperId, selectFirst = false }) {
  const itemIds = items.map((item) => normalizedPaperId(item?.id)).filter(Boolean);
  if (!itemIds.length) return null;
  if (selectFirst) return itemIds[0];

  const normalizedRouteId = normalizedPaperId(routePaperId);
  if (normalizedRouteId && itemIds.includes(normalizedRouteId)) return normalizedRouteId;

  const normalizedActiveId = normalizedPaperId(activeId);
  if (normalizedActiveId && itemIds.includes(normalizedActiveId)) return normalizedActiveId;

  return itemIds[0];
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
