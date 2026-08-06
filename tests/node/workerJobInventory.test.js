import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_JOB_INVENTORY,
  WORKER_JOB_TYPES,
  workerJobConcurrencyGroup,
  workerJobTitle
} from "../../server/workerJobInventory.js";

test("worker job inventory has unique types, notification labels, and observation groups", () => {
  assert.equal(WORKER_JOB_TYPES.length, 19);
  assert.equal(new Set(WORKER_JOB_TYPES).size, WORKER_JOB_TYPES.length);
  for (const entry of WORKER_JOB_INVENTORY) {
    assert.ok(entry.label.trim(), `${entry.type} label`);
    assert.notEqual(workerJobTitle(entry.type), entry.type, `${entry.type} notification label`);
    assert.ok(workerJobConcurrencyGroup(entry.type).trim(), `${entry.type} concurrency group`);
    assert.notEqual(workerJobConcurrencyGroup(entry.type), "unclassified", entry.type);
  }
});
