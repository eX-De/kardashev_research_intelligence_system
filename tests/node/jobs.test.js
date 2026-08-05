import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import { getJobHistory, getJobSummary, normalizeJobLimit } from "../../server/jobs.js";
import { dailyRecoveryFromHistory, fallbackHistoryFromSummary } from "../../src/lib/taskHistory.js";

function createJobsPool({ historyRows = [], workerRunning = "0", dailyRunning = "0", legacyRunning = "0" } = {}) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({ sql: String(sql), params });
        const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        if (normalized.includes("WITH TASK_HISTORY AS")) {
          return { rows: historyRows.slice(0, Number(params[0] || 0)) };
        }
        if (normalized.includes("WORKER_RUNNING_COUNT") && normalized.includes("DAILY_RUNNING_COUNT")) {
          return { rows: [{
            worker_running_count: workerRunning,
            daily_running_count: dailyRunning,
            legacy_running_count: legacyRunning
          }] };
        }
        throw new Error(`Unexpected SQL in jobs test: ${sql}`);
      }
    }
  };
}

const mixedRows = [
  {
    id: "12",
    record_type: "worker_job",
    worker_job_id: "12",
    job_run_id: null,
    job_type: "reader-import-url",
    status: "completed",
    started_at: "2026-08-05T11:00:00+00:00",
    finished_at: "2026-08-05T11:01:00+00:00",
    message: "",
    error_message: "",
    pid: null,
    heartbeat_at: null,
    meta_json: "{\"message\":\"Imported\",\"imported\":1}"
  },
  {
    id: "7",
    record_type: "daily_run",
    worker_job_id: "13",
    job_run_id: "7",
    job_type: "run-daily",
    status: "running",
    started_at: "2026-08-05T10:00:00+00:00",
    finished_at: null,
    message: "Daily run 1/3",
    error_message: "",
    pid: 123,
    heartbeat_at: "2026-08-05T10:00:10+00:00",
    meta_json: "{\"daily_progress\":{\"current\":1}}"
  },
  {
    id: "3",
    record_type: "worker_job",
    worker_job_id: null,
    job_run_id: "3",
    job_type: "sync-obsidian",
    status: "failed",
    started_at: "2026-08-04T09:00:00+00:00",
    finished_at: "2026-08-04T09:01:00+00:00",
    message: "legacy failed",
    error_message: "",
    pid: null,
    heartbeat_at: null,
    meta_json: "{bad"
  }
];

test("getJobHistory projects worker jobs, daily runs, and unlinked legacy history uniformly", async () => {
  const fake = createJobsPool({ historyRows: mixedRows });
  setPoolForTesting(fake.pool);
  try {
    const result = await getJobHistory("3");
    assert.deepEqual(result.items.map((item) => [item.record_type, item.worker_job_id, item.job_run_id]), [
      ["worker_job", 12, null],
      ["daily_run", 13, 7],
      ["worker_job", null, 3]
    ]);
    assert.equal(result.items[0].message, "Imported");
    assert.deepEqual(result.items[1].meta, { daily_progress: { current: 1 } });
    assert.deepEqual(result.items[2].meta, {});
    assert.match(fake.calls[0].sql, /NOT EXISTS[\s\S]*worker_jobs/);
    assert.deepEqual(fake.calls[0].params, [3]);
  } finally {
    setPoolForTesting(null);
  }
});

test("getJobSummary uses the unified projection and separates worker from daily running counts", async () => {
  const fake = createJobsPool({ historyRows: mixedRows, workerRunning: "2", dailyRunning: "1", legacyRunning: "1" });
  setPoolForTesting(fake.pool);
  try {
    const result = await getJobSummary();
    assert.equal(result.running_count, 4);
    assert.equal(result.worker_running_count, 3);
    assert.equal(result.daily_running_count, 1);
    assert.equal(result.latest_job.record_type, "worker_job");
    assert.equal(result.latest_job.worker_job_id, 12);
  } finally {
    setPoolForTesting(null);
  }
});

test("getJobSummary returns null latest job for empty history", async () => {
  const fake = createJobsPool();
  setPoolForTesting(fake.pool);
  try {
    assert.deepEqual(await getJobSummary(), {
      running_count: 0,
      worker_running_count: 0,
      daily_running_count: 0,
      latest_job: null
    });
  } finally {
    setPoolForTesting(null);
  }
});

test("summary fallback preserves daily metadata for the recovery card before history loads", () => {
  const dailyProgress = {
    completed: 2,
    total: 3,
    current_key: "generate_reports",
    current_label: "生成报告",
    steps: [{ key: "generate_reports", label: "生成报告", status: "failed" }]
  };
  const summary = {
    latest_job: {
      id: 17,
      job_run_id: 17,
      record_type: "daily_run",
      job_type: "run-daily",
      status: "failed",
      meta: { daily_progress: dailyProgress }
    }
  };

  const fallback = fallbackHistoryFromSummary(summary);
  assert.strictEqual(fallback[0].meta, summary.latest_job.meta);
  assert.deepEqual(dailyRecoveryFromHistory(fallback), {
    job_id: 17,
    failed_step: "generate_reports",
    failed_label: "生成报告",
    completed: 2,
    total: 3
  });
});

test("normalizeJobLimit validates route limits", () => {
  assert.equal(normalizeJobLimit(null, 20), 20);
  assert.equal(normalizeJobLimit("", 20), 20);
  assert.equal(normalizeJobLimit("0", 20), 0);
  assert.equal(normalizeJobLimit("12", 20), 12);
  assert.throws(() => normalizeJobLimit("abc", 20), ValidationError);
  assert.throws(() => normalizeJobLimit("-1", 20), ValidationError);
});
