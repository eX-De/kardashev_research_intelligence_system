import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import {
  countActiveWorkerJobs,
  enqueueWorkerJob,
  getWorkerJob,
  listWorkerJobs,
  requestWorkerJobCancellation,
  workerJobStatus
} from "../../server/workerQueue.js";

function createWorkerQueuePool() {
  const txCalls = [];
  const jobRuns = [];
  const workerJobs = [];
  const appEvents = [];

  function workerJobRow(row) {
    return {
      result_json: "{}",
      error_message: "",
      attempts: "0",
      max_attempts: "1",
      run_after: null,
      locked_by: "",
      locked_at: null,
      cancel_requested_at: null,
      cancel_reason: "",
      started_at: null,
      finished_at: null,
      ...row
    };
  }

  async function runQuery(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
      txCalls.push(normalized);
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO JOB_RUNS")) {
      const row = {
        id: String(jobRuns.length + 1),
        job_type: params[0],
        status: "queued",
        started_at: params[1],
        finished_at: null,
        message: params[2],
        pid: null,
        heartbeat_at: params[1],
        meta_json: params[3]
      };
      jobRuns.push(row);
      return { rows: [row] };
    }
    if (normalized.startsWith("INSERT INTO WORKER_JOBS")) {
      const row = workerJobRow({
        id: String(workerJobs.length + 1),
        job_run_id: String(params[0]),
        job_type: params[1],
        status: "queued",
        priority: String(params[2]),
        payload_json: params[3],
        max_attempts: String(params[4]),
        run_after: params[5],
        created_at: params[6],
        updated_at: params[6]
      });
      workerJobs.push(row);
      return { rows: [row] };
    }
    if (normalized.startsWith("INSERT INTO APP_EVENTS")) {
      const row = {
        id: String(appEvents.length + 1),
        event_type: params[0],
        payload_json: params[1],
        created_at: params[2],
        published_at: null
      };
      appEvents.push(row);
      return { rows: [row] };
    }
    if (normalized.includes("COUNT(*) AS COUNT") && normalized.includes("FROM WORKER_JOBS")) {
      const jobType = params[0] || "";
      return {
        rows: [{
          count: String(workerJobs.filter((item) => (
            ["queued", "running"].includes(item.status)
            && (!jobType || item.job_type === jobType)
          )).length)
        }]
      };
    }
    if (normalized.includes("FROM WORKER_JOBS") && normalized.includes("FOR UPDATE")) {
      const row = workerJobs.find((item) => Number(item.id) === Number(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (normalized.startsWith("SELECT ID, JOB_RUN_ID") && normalized.includes("FROM WORKER_JOBS")) {
      if (normalized.includes("WHERE ID = $1")) {
        const row = workerJobs.find((item) => Number(item.id) === Number(params[0]));
        return { rows: row ? [row] : [] };
      }
      const statusMatch = normalized.includes("STATUS = $1") ? params[0] : "";
      const jobTypeIndex = normalized.includes("JOB_TYPE = $2") ? 1 : normalized.includes("JOB_TYPE = $1") ? 0 : -1;
      const jobType = jobTypeIndex >= 0 ? params[jobTypeIndex] : "";
      const limit = Number(params.at(-1));
      return {
        rows: workerJobs
          .filter((item) => (!statusMatch || item.status === statusMatch) && (!jobType || item.job_type === jobType))
          .sort((left, right) => Number(right.id) - Number(left.id))
          .slice(0, limit)
      };
    }
    if (normalized.startsWith("UPDATE WORKER_JOBS SET STATUS = 'CANCELLED'")) {
      const row = workerJobs.find((item) => Number(item.id) === Number(params[2]) && item.status === "queued");
      if (!row) return { rows: [] };
      Object.assign(row, {
        status: "cancelled",
        cancel_requested_at: params[0],
        cancel_reason: params[1],
        locked_by: "",
        locked_at: null,
        finished_at: params[0],
        updated_at: params[0]
      });
      return { rows: [row] };
    }
    if (normalized.startsWith("UPDATE WORKER_JOBS SET CANCEL_REQUESTED_AT")) {
      const row = workerJobs.find((item) => Number(item.id) === Number(params[2]) && item.status === "running");
      if (!row) return { rows: [] };
      row.cancel_requested_at ||= params[0];
      row.cancel_reason ||= params[1];
      row.updated_at = params[0];
      return { rows: [row] };
    }
    if (normalized.startsWith("UPDATE JOB_RUNS SET STATUS = $1")) {
      const row = jobRuns.find((item) => Number(item.id) === Number(params[3]));
      Object.assign(row, {
        status: params[0],
        finished_at: ["completed", "failed", "cancelled"].includes(params[0]) ? params[1] : row.finished_at,
        message: params[2],
        heartbeat_at: params[1]
      });
      return { rows: [row] };
    }
    throw new Error(`Unexpected SQL in workerQueue test: ${sql}`);
  }

  return {
    appEvents,
    jobRuns,
    workerJobs,
    txCalls,
    pool: {
      async query(sql, params) {
        return runQuery(sql, params);
      },
      async connect() {
        return {
          query: runQuery,
          release() {
            txCalls.push("RELEASE");
          }
        };
      }
    }
  };
}

async function withWorkerQueuePool(fn) {
  const fake = createWorkerQueuePool();
  setPoolForTesting(fake.pool);
  try {
    return await fn(fake);
  } finally {
    setPoolForTesting(null);
  }
}

test("enqueueWorkerJob creates task state and queued outbox event transactionally", async () => {
  await withWorkerQueuePool(async (fake) => {
    const result = await enqueueWorkerJob({
      jobType: "generate-reports",
      payload: { scope: "daily" },
      priority: 3,
      maxAttempts: 2,
      now: "2026-07-06T10:00:00.000Z"
    });
    assert.deepEqual(fake.txCalls, ["BEGIN", "COMMIT", "RELEASE"]);
    assert.equal(result.job_run.id, 1);
    assert.equal(result.worker_job.job_run_id, 1);
    assert.equal(result.worker_job.priority, 3);
    assert.deepEqual(result.worker_job.payload, { scope: "daily" });
    assert.equal(result.worker_job.max_attempts, 2);
    assert.equal(fake.appEvents.length, 1);
    assert.equal(fake.appEvents[0].event_type, "task.started");
    const payload = JSON.parse(fake.appEvents[0].payload_json);
    assert.equal(payload.task.worker_job_id, result.worker_job.id);
    assert.equal(payload.task.status, "queued");
  });
});

test("get/list/count expose queue state including cancellation fields", async () => {
  await withWorkerQueuePool(async (fake) => {
    const first = await enqueueWorkerJob({ jobType: "generate-paper-reports", now: "2026-07-06T10:00:00.000Z" });
    await enqueueWorkerJob({ jobType: "generate-reports", now: "2026-07-06T10:00:01.000Z" });
    fake.workerJobs[1].status = "running";
    fake.workerJobs[1].cancel_requested_at = "2026-07-06T10:01:00.000Z";
    fake.workerJobs[1].cancel_reason = "User requested";

    assert.equal(await countActiveWorkerJobs("generate-paper-reports"), 1);
    assert.equal(await countActiveWorkerJobs(), 2);
    const loaded = await getWorkerJob(first.worker_job.id);
    assert.equal(loaded.cancel_requested_at, null);
    const running = await listWorkerJobs({ status: "running", limit: 10 });
    assert.equal(running.length, 1);
    assert.equal(running[0].cancel_reason, "User requested");
  });
});

test("queued cancellation becomes terminal with task.cancelled in one transaction", async () => {
  await withWorkerQueuePool(async (fake) => {
    const queued = await enqueueWorkerJob({ jobType: "sync-obsidian", now: "2026-07-06T10:00:00.000Z" });
    fake.txCalls.length = 0;
    fake.appEvents.length = 0;
    const result = await requestWorkerJobCancellation(queued.worker_job.id, {
      reason: "User cancelled",
      now: "2026-07-06T10:01:00.000Z"
    });

    assert.deepEqual(fake.txCalls, ["BEGIN", "COMMIT", "RELEASE"]);
    assert.equal(result.cancelled, true);
    assert.equal(result.worker_job.status, "cancelled");
    assert.equal(result.job_run.status, "cancelled");
    assert.equal(fake.appEvents[0].event_type, "task.cancelled");
    assert.equal(JSON.parse(fake.appEvents[0].payload_json).task.status, "cancelled");
  });
});

test("running cancellation records a request without taking lifecycle ownership", async () => {
  await withWorkerQueuePool(async (fake) => {
    const queued = await enqueueWorkerJob({ jobType: "generate-reports", now: "2026-07-06T10:00:00.000Z" });
    fake.workerJobs[0].status = "running";
    fake.workerJobs[0].locked_by = "worker-a";
    fake.jobRuns[0].status = "running";
    fake.appEvents.length = 0;

    const result = await requestWorkerJobCancellation(queued.worker_job.id, {
      reason: "Stop after current step",
      now: "2026-07-06T10:01:00.000Z"
    });

    assert.equal(result.cancelled, false);
    assert.equal(result.cancellation_requested, true);
    assert.equal(result.worker_job.status, "running");
    assert.equal(result.worker_job.cancel_requested_at, "2026-07-06T10:01:00.000Z");
    assert.equal(result.job_run.status, "running");
    assert.equal(fake.appEvents[0].event_type, "task.cancel_requested");
    assert.equal(JSON.parse(fake.appEvents[0].payload_json).task.status, "cancel_requested");
  });
});

test("worker queue validation rejects invalid request fields", async () => {
  assert.throws(() => workerJobStatus("unknown"), ValidationError);
  await assert.rejects(() => enqueueWorkerJob({ jobType: "" }), ValidationError);
  await assert.rejects(() => getWorkerJob(0), ValidationError);
  await assert.rejects(() => listWorkerJobs({ limit: 0 }), ValidationError);
  await assert.rejects(() => requestWorkerJobCancellation(0), ValidationError);
});
