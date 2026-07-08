import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import {
  claimNextWorkerJob,
  cleanupStaleWorkerJobs,
  completeWorkerJob,
  countActiveWorkerJobs,
  enqueueWorkerJob,
  failWorkerJob,
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
    if (
      normalized.includes("FROM WORKER_JOBS")
      && normalized.includes("STATUS = 'RUNNING'")
      && normalized.includes("FOR UPDATE SKIP LOCKED")
    ) {
      const cutoff = params[0];
      return {
        rows: workerJobs
          .filter((item) => item.status === "running" && (!item.locked_at || item.locked_at < cutoff))
          .slice(0, Number(params[1] || 100))
      };
    }
    if (normalized.includes("FROM WORKER_JOBS") && normalized.includes("FOR UPDATE SKIP LOCKED")) {
      const now = params[0];
      const row = workerJobs
        .filter((item) => (
          item.status === "queued"
          && Number(item.attempts) < Number(item.max_attempts)
          && (!item.run_after || item.run_after <= now)
        ))
        .sort((left, right) => (
          Number(right.priority) - Number(left.priority)
          || Number(left.id) - Number(right.id)
        ))[0];
      return { rows: row ? [row] : [] };
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
    if (normalized.startsWith("UPDATE WORKER_JOBS SET STATUS = 'RUNNING'")) {
      const row = workerJobs.find((item) => Number(item.id) === Number(params[2]));
      Object.assign(row, {
        status: "running",
        attempts: String(Number(row.attempts) + 1),
        locked_by: params[0],
        locked_at: params[1],
        started_at: row.started_at || params[1],
        updated_at: params[1]
      });
      return { rows: [row] };
    }
    if (normalized.startsWith("UPDATE WORKER_JOBS SET STATUS = 'COMPLETED'")) {
      const row = workerJobs.find((item) => Number(item.id) === Number(params[2]));
      Object.assign(row, {
        status: "completed",
        result_json: params[0],
        error_message: "",
        finished_at: params[1],
        updated_at: params[1]
      });
      return { rows: [row] };
    }
    if (normalized.startsWith("UPDATE WORKER_JOBS SET STATUS = 'QUEUED'")) {
      const row = workerJobs.find((item) => Number(item.id) === Number(params[1]));
      Object.assign(row, {
        status: "queued",
        error_message: "",
        locked_by: "",
        locked_at: null,
        updated_at: params[0]
      });
      return { rows: [row] };
    }
    if (normalized.startsWith("UPDATE WORKER_JOBS SET STATUS = 'FAILED'")) {
      const row = workerJobs.find((item) => Number(item.id) === Number(params[2]));
      Object.assign(row, {
        status: "failed",
        error_message: params[0],
        finished_at: params[1],
        updated_at: params[1]
      });
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

test("enqueueWorkerJob creates linked job_runs and worker_jobs rows transactionally", async () => {
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
    assert.equal(result.job_run.status, "queued");
    assert.equal(result.worker_job.job_run_id, 1);
    assert.equal(result.worker_job.job_type, "generate-reports");
    assert.equal(result.worker_job.priority, 3);
    assert.deepEqual(result.worker_job.payload, { scope: "daily" });
    assert.equal(result.worker_job.max_attempts, 2);
  });
});

test("claimNextWorkerJob locks the highest priority queued job and marks job_run running", async () => {
  await withWorkerQueuePool(async () => {
    await enqueueWorkerJob({
      jobType: "generate-reports",
      payload: { low: true },
      priority: 1,
      now: "2026-07-06T10:00:00.000Z"
    });
    await enqueueWorkerJob({
      jobType: "generate-paper-reports",
      payload: { limit: 1 },
      priority: 5,
      now: "2026-07-06T10:00:01.000Z"
    });
    const claimed = await claimNextWorkerJob({
      workerId: "worker-a",
      now: "2026-07-06T10:01:00.000Z"
    });
    assert.equal(claimed.worker_job.job_type, "generate-paper-reports");
    assert.equal(claimed.worker_job.status, "running");
    assert.equal(claimed.worker_job.locked_by, "worker-a");
    assert.equal(claimed.worker_job.attempts, 1);
    assert.equal(claimed.job_run.status, "running");
    assert.equal(claimed.job_run.message, "Claimed by worker worker-a");
  });
});

test("completeWorkerJob and failWorkerJob synchronize visible job_run status", async () => {
  await withWorkerQueuePool(async () => {
    const queued = await enqueueWorkerJob({
      jobType: "generate-reports",
      payload: {},
      now: "2026-07-06T10:00:00.000Z"
    });
    const completed = await completeWorkerJob(
      queued.worker_job.id,
      { report_path: "daily.md" },
      { message: "Daily report completed", now: "2026-07-06T10:02:00.000Z" }
    );
    assert.equal(completed.worker_job.status, "completed");
    assert.deepEqual(completed.worker_job.result, { report_path: "daily.md" });
    assert.equal(completed.job_run.status, "completed");
    assert.equal(completed.job_run.message, "Daily report completed");

    const failedQueued = await enqueueWorkerJob({
      jobType: "sync-obsidian",
      payload: {},
      now: "2026-07-06T10:03:00.000Z"
    });
    const failed = await failWorkerJob(
      failedQueued.worker_job.id,
      "Obsidian not configured",
      { now: "2026-07-06T10:04:00.000Z" }
    );
    assert.equal(failed.worker_job.status, "failed");
    assert.equal(failed.worker_job.error_message, "Obsidian not configured");
    assert.equal(failed.job_run.status, "failed");
    assert.equal(failed.job_run.message, "Obsidian not configured");
  });
});

test("countActiveWorkerJobs counts queued and running jobs by type", async () => {
  await withWorkerQueuePool(async () => {
    await enqueueWorkerJob({
      jobType: "generate-paper-reports",
      payload: {},
      now: "2026-07-06T10:00:00.000Z"
    });
    await enqueueWorkerJob({
      jobType: "generate-reports",
      payload: {},
      now: "2026-07-06T10:00:01.000Z"
    });
    await claimNextWorkerJob({
      workerId: "worker-a",
      now: "2026-07-06T10:01:00.000Z"
    });
    assert.equal(await countActiveWorkerJobs("generate-paper-reports"), 1);
    assert.equal(await countActiveWorkerJobs(), 2);
  });
});

test("cleanupStaleWorkerJobs requeues stale running jobs with attempts remaining", async () => {
  await withWorkerQueuePool(async (fake) => {
    const queued = await enqueueWorkerJob({
      jobType: "generate-reports",
      payload: { command: "generate-reports", source: "manual", args: [] },
      maxAttempts: 2,
      now: "2026-07-06T10:00:00.000Z"
    });
    await claimNextWorkerJob({
      workerId: "worker-a",
      now: "2026-07-06T10:01:00.000Z"
    });
    const result = await cleanupStaleWorkerJobs({
      staleAfterSeconds: 60,
      now: "2026-07-06T10:03:00.000Z"
    });

    assert.equal(result.stale_worker_jobs_requeued, 1);
    assert.equal(result.stale_worker_jobs_failed, 0);
    assert.equal(fake.workerJobs[0].status, "queued");
    assert.equal(fake.workerJobs[0].locked_by, "");
    assert.equal(fake.jobRuns[0].status, "queued");
    assert.equal(fake.jobRuns[0].message.includes("Requeued stale worker job"), true);
    assert.equal(fake.appEvents[0].event_type, "task.started");
    assert.equal(JSON.parse(fake.appEvents[0].payload_json).task.id, queued.job_run.id);
    assert.equal(JSON.parse(fake.appEvents[0].payload_json).task.status, "queued");
  });
});

test("cleanupStaleWorkerJobs fails stale running jobs after attempts are exhausted", async () => {
  await withWorkerQueuePool(async (fake) => {
    await enqueueWorkerJob({
      jobType: "sync-obsidian",
      payload: { command: "sync-obsidian", source: "manual", args: [] },
      maxAttempts: 1,
      now: "2026-07-06T10:00:00.000Z"
    });
    await claimNextWorkerJob({
      workerId: "worker-a",
      now: "2026-07-06T10:01:00.000Z"
    });
    const result = await cleanupStaleWorkerJobs({
      staleAfterSeconds: 60,
      now: "2026-07-06T10:03:00.000Z"
    });

    assert.equal(result.stale_worker_jobs_requeued, 0);
    assert.equal(result.stale_worker_jobs_failed, 1);
    assert.equal(fake.workerJobs[0].status, "failed");
    assert.equal(fake.jobRuns[0].status, "failed");
    assert.equal(fake.appEvents[0].event_type, "task.failed");
    assert.equal(JSON.parse(fake.appEvents[0].payload_json).task.status, "failed");
  });
});

test("worker queue validation rejects invalid protocol fields", async () => {
  assert.throws(() => workerJobStatus("unknown"), ValidationError);
  await assert.rejects(() => enqueueWorkerJob({ jobType: "" }), ValidationError);
  await assert.rejects(() => claimNextWorkerJob({ workerId: "" }), ValidationError);
  await assert.rejects(() => completeWorkerJob(0), ValidationError);
});
