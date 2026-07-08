import assert from "node:assert/strict";
import test from "node:test";

import { SERVER_EVENTS, applyServerEvent, markGlobalStale } from "../../src/lib/serverEventRules.js";

function createCacheRecorder() {
  const stale = [];
  const cache = [];
  return {
    stale,
    cache,
    markStale(target) {
      stale.push(target);
    },
    setCache(key, value) {
      cache.push({ key, value });
    }
  };
}

test("settings.changed marks settings, health, and jobs status", () => {
  const cache = createCacheRecorder();
  const scheduler = { enabled: true };
  applyServerEvent(cache, {
    type: SERVER_EVENTS.SETTINGS_CHANGED,
    data: { scheduler }
  });

  assert.deepEqual(cache.stale, [["settings"], ["health"], ["health", "summary"]]);
  assert.deepEqual(cache.cache, [{ key: ["jobs", "status"], value: { scheduler } }]);
});

test("project.updated marks project, projects, notifications, and health", () => {
  const cache = createCacheRecorder();
  applyServerEvent(cache, {
    type: SERVER_EVENTS.PROJECT_UPDATED,
    data: { project_id: 7 }
  });

  assert.deepEqual(cache.stale, [
    ["projects"],
    ["project", "7"],
    ["health"],
    ["health", "summary"],
    ["notifications"]
  ]);
});

test("paper library status events mark library, reader, reports, notifications, and projects", () => {
  const cache = createCacheRecorder();
  applyServerEvent(cache, {
    type: SERVER_EVENTS.PAPER_LIBRARY_STATUS_UPDATED,
    data: { paper_id: 101, project_ids: [7] }
  });

  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "library"));
  assert.ok(cache.stale.some((target) => target?.namespace === "reader|papers"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "paper-reports/summary"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "notifications"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "project/7"));
});

test("papers.changed marks paper list namespaces without a single paper id", () => {
  const cache = createCacheRecorder();
  applyServerEvent(cache, {
    type: SERVER_EVENTS.PAPERS_CHANGED,
    data: { result: { arxiv_papers_inserted: 5 } }
  });

  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "inbox"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "library"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "paper-reports"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "notifications"));
});

test("paper report aggregate events also mark artifacts", () => {
  const cache = createCacheRecorder();
  applyServerEvent(cache, {
    type: SERVER_EVENTS.PAPER_REPORT_UPDATED,
    data: { artifact_id: null, result: { paper_reports_queued: 2 } }
  });

  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "paper-reports"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "artifacts"));
});

test("task events mark job, report, reader, health, and notification namespaces", () => {
  const cache = createCacheRecorder();
  applyServerEvent(cache, {
    type: SERVER_EVENTS.TASK_STARTED,
    data: { task: { id: 1, status: "queued" } }
  });

  assert.deepEqual(cache.stale, [
    ["jobs", "status"],
    ["jobs", "summary"],
    ["jobs", "history"],
    ["paper-reports", "summary"],
    ["paper-reports"],
    { namespace: "reader|papers" },
    { namespace: "reader|paper" },
    ["health"],
    ["health", "summary"],
    ["notifications"]
  ]);
});

test("global stale marks major namespaces after reconnect or error", () => {
  const cache = createCacheRecorder();
  markGlobalStale(cache);

  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "settings"));
  assert.ok(cache.stale.some((target) => Array.isArray(target) && target.join("/") === "jobs/history"));
  assert.ok(cache.stale.some((target) => target?.namespace === "project"));
  assert.ok(cache.stale.some((target) => target?.namespace === "artifact"));
  assert.ok(cache.stale.some((target) => target?.namespace === "reader|paper"));
});
