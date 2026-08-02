import assert from "node:assert/strict";
import test from "node:test";

import {
  commitPaperListSelection,
  resolveListDetailId,
  resolveLocatedListPage,
  resolvePaperListSelection,
  resolveReaderQueueSelection,
  shouldLocateListRoute,
  shouldResetListFiltersForMissingRoute
} from "../../src/lib/paperSelection.js";

const pageOne = [{ id: 1 }, { id: 2 }];
const pageTwo = [{ id: 11 }, { id: 12 }];

test("a newly loaded page derives its first item as the detail target immediately", () => {
  assert.equal(resolveListDetailId({
    activeId: 1,
    items: pageTwo,
    routeEntityId: null
  }), 11);
});

test("an explicit route remains the detail target while its list page is locating", () => {
  assert.equal(resolveListDetailId({
    activeId: 1,
    items: pageOne,
    routeEntityId: 42
  }), 42);
});

test("page change selects the first paper from the newly loaded page", () => {
  assert.equal(resolvePaperListSelection({
    activeId: 1,
    items: pageTwo,
    routePaperId: 1,
    selectFirst: true
  }), 11);
});

test("a route paper from the previous page cannot override the current page selection", () => {
  assert.equal(resolvePaperListSelection({
    activeId: 11,
    items: pageTwo,
    routePaperId: 1
  }), 11);
});

test("an explicit library deep link remains selected outside the current list page", () => {
  assert.equal(resolvePaperListSelection({
    activeId: null,
    allowRouteOutsideItems: true,
    items: pageOne,
    routePaperId: 42
  }), 42);
});

test("a located library deep link moves the list to the matching page", () => {
  assert.equal(resolveLocatedListPage({
    currentPage: 1,
    locatedEntityId: 42,
    locatedPage: 3,
    routeEntityId: 42
  }), 3);
});

test("explicit page navigation wins over stale deep-link location metadata", () => {
  assert.equal(resolveLocatedListPage({
    currentPage: 2,
    locatedEntityId: 42,
    locatedPage: 3,
    routeEntityId: 42,
    selectFirst: true
  }), 2);
});

test("an artifact deep link uses the same located-list page contract", () => {
  assert.equal(resolveLocatedListPage({
    currentPage: 1,
    locatedEntityId: 18,
    locatedPage: 2,
    routeEntityId: 18
  }), 2);
});

test("external routes locate only when the target is outside the loaded page", () => {
  assert.equal(shouldLocateListRoute({ items: pageOne, routeEntityId: 42 }), true);
  assert.equal(shouldLocateListRoute({ items: pageOne, routeEntityId: 2 }), false);
});

test("normal pagination does not start a competing route-location request", () => {
  assert.equal(shouldLocateListRoute({
    items: [],
    routeEntityId: 2,
    selectFirst: true
  }), false);
});

test("a deep link clears restrictive filters only after filtered location misses", () => {
  assert.equal(shouldResetListFiltersForMissingRoute({
    hasLocationData: true,
    hasRestrictiveFilters: true,
    locatedEntityId: null,
    routeEntityId: 42,
    shouldLocateRoute: true
  }), true);
  assert.equal(shouldResetListFiltersForMissingRoute({
    hasLocationData: true,
    hasRestrictiveFilters: true,
    locatedEntityId: 42,
    routeEntityId: 42,
    shouldLocateRoute: true
  }), false);
});

test("clicking the first paper on the current page follows its unique id", () => {
  assert.equal(resolvePaperListSelection({
    activeId: 1,
    items: pageTwo,
    routePaperId: 11
  }), 11);
});

test("a valid route paper on the current page remains selectable", () => {
  assert.equal(resolvePaperListSelection({
    activeId: 1,
    items: pageOne,
    routePaperId: 2
  }), 2);
});

test("route-backed clicks do not write a competing local selection", () => {
  const routedIds = [];
  const localIds = [];

  commitPaperListSelection({
    onRouteSelect: (paperId) => routedIds.push(paperId),
    onSelectLocal: (paperId) => localIds.push(paperId),
    paperId: 12
  });

  assert.deepEqual(routedIds, [12]);
  assert.deepEqual(localIds, []);
});

test("local selection remains available when the view has no route callback", () => {
  const localIds = [];

  commitPaperListSelection({
    onSelectLocal: (paperId) => localIds.push(paperId),
    paperId: 12
  });

  assert.deepEqual(localIds, [12]);
});

test("a pending report-queue click wins over the previous route paper", () => {
  assert.equal(resolveReaderQueueSelection({
    activeId: 13,
    items: [{ paper_id: 11 }, { paper_id: 12 }, { paper_id: 13 }],
    pendingRouteId: 13,
    routePaperId: 12
  }), 13);
});

test("report-queue page navigation still selects the new page first item", () => {
  assert.equal(resolveReaderQueueSelection({
    activeId: 12,
    items: [{ paper_id: 21 }, { paper_id: 22 }],
    pendingRouteId: 12,
    routePaperId: 12,
    selectFirst: true
  }), 21);
});
