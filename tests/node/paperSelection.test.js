import assert from "node:assert/strict";
import test from "node:test";

import { commitPaperListSelection, resolvePaperListSelection } from "../../src/lib/paperSelection.js";

const pageOne = [{ id: 1 }, { id: 2 }];
const pageTwo = [{ id: 11 }, { id: 12 }];

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
