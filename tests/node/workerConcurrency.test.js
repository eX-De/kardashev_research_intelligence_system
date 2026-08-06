import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
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

test("Daily Tasks renders the worker concurrency card with its controller props", () => {
  const source = readFileSync(
    new URL("../../src/components/DailyTasksSettingsView.jsx", import.meta.url),
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
});