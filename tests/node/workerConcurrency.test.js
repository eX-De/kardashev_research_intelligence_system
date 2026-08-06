import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWorkerConcurrencySettingsPayload,
  workerCapacityApplyDecision,
  workerConcurrencyFlatValues
} from "../../src/lib/workerConcurrency.js";

test("worker capacity keeps polling transient degraded pool state and converges", () => {
  assert.equal(workerCapacityApplyDecision({
    state: "reconciling",
    pool: { actual_processes: 1, draining_processes: 0, degraded: true },
    desired: 2,
    attempts: 1
  }), "reconciling");
  assert.equal(workerCapacityApplyDecision({
    state: "reconciling",
    pool: { actual_processes: 2, draining_processes: 0, degraded: false },
    desired: 2,
    attempts: 2
  }), "applied");
  assert.equal(workerCapacityApplyDecision({
    state: "reconciling",
    pool: { actual_processes: 1, draining_processes: 0, degraded: true },
    desired: 2,
    attempts: 15
  }), "degraded");
});

test("worker capacity flat compatibility includes all six fields", () => {
  const values = workerConcurrencyFlatValues({ worker_process_count: 3 });
  assert.equal(values.worker_process_count, 3);
  assert.equal(Object.keys(values).length, 6);
});

test("settings save emits only the nested worker concurrency contract", () => {
  const snapshot = {
    revision: 7,
    worker_process_count: 3,
    global_llm_request_concurrency: 4,
    global_embedding_request_concurrency: 5,
    embedding_concurrency: 2,
    project_judgment_concurrency: 6,
    project_chat_profile_concurrency: 2,
    groups: {
      daily: { editable: false, max_running: 1 },
      "paper-report": { editable: true, max_running: 4 }
    }
  };
  const payload = buildWorkerConcurrencySettingsPayload({
    locale: "zh-CN",
    worker_concurrency: snapshot,
    ...workerConcurrencyFlatValues(snapshot)
  });

  assert.equal(payload.locale, "zh-CN");
  assert.equal(payload.worker_process_count, undefined);
  assert.deepEqual(payload.worker_concurrency, {
    expected_revision: 7,
    worker_process_count: 3,
    global_llm_request_concurrency: 4,
    global_embedding_request_concurrency: 5,
    embedding_concurrency: 2,
    project_judgment_concurrency: 6,
    project_chat_profile_concurrency: 2,
    group_limits: { "paper-report": 4 }
  });

  const appOnlyPayload = buildWorkerConcurrencySettingsPayload(
    { worker_concurrency: snapshot, ...workerConcurrencyFlatValues(snapshot) },
    { includeWorkerConcurrency: false }
  );
  assert.equal(appOnlyPayload.worker_concurrency, undefined);
  assert.equal(appOnlyPayload.worker_process_count, undefined);
});

test("Daily Tasks renders the worker concurrency card with its controller props", () => {
  const source = readFileSync(
    new URL("../../src/components/DailyTasksSettingsView.jsx", import.meta.url),
    "utf8"
  );
  const modelRoutingSource = readFileSync(
    new URL("../../src/components/ModelRoutingSettingsView.jsx", import.meta.url),
    "utf8"
  );
  const invocation = source.match(/<WorkerConcurrencyCard\b[\s\S]*?\/>/)?.[0];
  assert.ok(invocation, "WorkerConcurrencyCard must be rendered, not only defined");
  for (const binding of [
    "settings={settings}",
    "workerStatus={workerStatus}",
    "conflict={concurrencyConflict}",
    "applyState={capacityApplyState}",
    "onChange={onWorkerConcurrencyChange}",
    "onReload={onReloadWorkerConcurrency}",
    "t={t}"
  ]) {
    assert.ok(invocation.includes(binding), `missing WorkerConcurrencyCard binding: ${binding}`);
  }
  for (const className of [
    "worker-concurrency-workspace",
    "worker-pool-overview",
    "worker-capacity-panel",
    "worker-workflow-panel",
    "worker-group-grid",
    "dailyEditableGroups",
    "indexEditableGroups",
    "readerReportEditableGroups"
  ]) {
    assert.ok(source.includes(className), `missing redesigned concurrency surface: ${className}`);
  }
  assert.equal(source.includes("worker-group-table"), false, "capacity groups should not regress to an overflow table");
  assert.equal(source.includes("worker-guardrails"), false, "fixed rules should live inside their workflow category");
  assert.match(source, /DAILY_EDITABLE_GROUPS\s*=\s*new Set\(\)/, "Daily Tasks should not expose a standalone queue-group capacity");
  assert.match(source, /READER_REPORT_EDITABLE_GROUPS\s*=\s*new Set\(\["reader-import", "paper-report"\]\)/, "Reader import and paper report must share one workflow domain");
  assert.equal(source.includes("project_chat_profile_concurrency"), false, "project summaries do not belong to Daily Tasks");
  assert.equal(modelRoutingSource.includes("project_chat_profile_concurrency"), true, "project summaries remain configurable with their model route");
});
