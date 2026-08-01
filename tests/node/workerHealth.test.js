import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerStatus, requireAvailableWorker } from "../../server/workerHealth.js";

function workerHealthDb({ instances = [], queued = "0", running = "0" } = {}) {
  return {
    async query(sql) {
      if (String(sql).includes("FROM worker_instances")) return { rows: instances };
      if (String(sql).includes("FROM worker_jobs")) {
        return {
          rows: [{
            queued,
            running,
            oldest_queued_at: Number(queued) ? "2026-08-01T10:00:00Z" : null,
            oldest_queued_seconds: Number(queued) ? "20" : null
          }]
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

test("getWorkerStatus reports a live worker and queue capacity separately", async () => {
  const status = await getWorkerStatus({ heartbeatTtlSeconds: 15 }, workerHealthDb({
    instances: [{
      worker_id: "worker-a",
      status: "running",
      started_at: "start",
      heartbeat_at: "heartbeat",
      current_job_id: "7",
      pid: "123",
      is_live: true
    }],
    queued: "2",
    running: "1"
  }));
  assert.equal(status.available, true);
  assert.equal(status.online_workers, 1);
  assert.equal(status.queue.active, 3);
  assert.equal(status.stalled, false);
});

test("getWorkerStatus identifies a stalled queue without a live worker", async () => {
  const status = await getWorkerStatus({}, workerHealthDb({ queued: "2" }));
  assert.equal(status.state, "offline");
  assert.equal(status.available, false);
  assert.equal(status.stalled, true);
  assert.equal(status.queue.oldest_queued_seconds, 20);
});

test("requireAvailableWorker returns a structured retryable service error", async () => {
  await assert.rejects(
    () => requireAvailableWorker({}, workerHealthDb()),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "worker_unavailable");
      assert.equal(error.workerStatus.available, false);
      return true;
    }
  );
});
