import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerStatus, requireAvailableWorker } from "../../server/workerHealth.js";

function workerHealthDb({ instances = [], queued = "0", running = "0", breakdown = [] } = {}) {
  return {
    async query(sql) {
      if (String(sql).includes("FROM worker_instances")) return { rows: instances };
      if (String(sql).includes("FROM worker_jobs")) {
        if (String(sql).includes("GROUP BY job_type, status")) return { rows: breakdown };
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
    running: "1",
    breakdown: [
      { job_type: "run-daily", status: "running", count: "1", oldest_queued_at: null, oldest_queued_seconds: null },
      { job_type: "reader-import-url", status: "queued", count: "2", oldest_queued_at: "queued", oldest_queued_seconds: "20" }
    ]
  }));
  assert.equal(status.available, true);
  assert.equal(status.online_workers, 1);
  assert.equal(status.queue.active, 3);
  assert.equal(status.queue.by_type["reader-import-url"].queued, 2);
  assert.equal(status.queue.by_type["reader-import-url"].concurrency_group, "reader-import");
  assert.equal(status.queue.by_group.daily.running, 1);
  assert.equal(status.queue.by_group["reader-import"].queued, 2);
  assert.equal(status.stalled, false);
});

test("queue baseline distinguishes manual work waiting behind a running daily job", async () => {
  const status = await getWorkerStatus({}, workerHealthDb({
    queued: "3",
    running: "1",
    breakdown: [
      { job_type: "run-daily", status: "running", count: "1", oldest_queued_at: null, oldest_queued_seconds: null },
      { job_type: "reader-import-url", status: "queued", count: "1", oldest_queued_at: "reader", oldest_queued_seconds: "31" },
      { job_type: "paper-report", status: "queued", count: "1", oldest_queued_at: "report", oldest_queued_seconds: "22" },
      { job_type: "artifact-index", status: "queued", count: "1", oldest_queued_at: "artifact", oldest_queued_seconds: "13" }
    ]
  }));

  assert.equal(status.queue.by_type["reader-import-url"].oldest_queued_seconds, 31);
  assert.equal(status.queue.by_type["paper-report"].oldest_queued_seconds, 22);
  assert.equal(status.queue.by_type["artifact-index"].oldest_queued_seconds, 13);
  assert.equal(status.queue.by_group.llm.queued, 1);
  assert.equal(status.queue.by_group.embedding.queued, 1);
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
