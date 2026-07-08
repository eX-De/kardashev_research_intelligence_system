import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import { getJobHistory, getJobSummary, normalizeJobLimit } from "../../server/jobs.js";

function createJobsPool({ historyRows = [], latestRow = null, runningCount = "0" } = {}) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({ sql: String(sql), params });
        const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        if (normalized.includes("FROM JOB_RUNS") && normalized.includes("META_JSON")) {
          return { rows: historyRows.slice(0, Number(params[0] || 0)) };
        }
        if (normalized.includes("FROM JOB_RUNS") && normalized.includes("ORDER BY ID DESC") && normalized.includes("LIMIT 1")) {
          return { rows: latestRow ? [latestRow] : [] };
        }
        if (normalized.includes("COUNT(*) AS COUNT FROM JOB_RUNS WHERE STATUS = 'RUNNING'")) {
          return { rows: [{ count: runningCount }] };
        }
        throw new Error(`Unexpected SQL in jobs test: ${sql}`);
      }
    }
  };
}

test("getJobHistory returns Python-compatible items shape", async () => {
  const fake = createJobsPool({
    historyRows: [
      {
        id: "2",
        job_type: "run-daily",
        status: "running",
        started_at: "2026-07-06T10:00:00+00:00",
        finished_at: null,
        message: "Daily run 1/3",
        pid: 123,
        heartbeat_at: "2026-07-06T10:00:10+00:00",
        meta_json: "{\"daily_progress\":{\"current\":1}}"
      },
      {
        id: "1",
        job_type: "sync-obsidian",
        status: "failed",
        started_at: "2026-07-06T09:00:00+00:00",
        finished_at: "2026-07-06T09:01:00+00:00",
        message: "failed",
        pid: null,
        heartbeat_at: null,
        meta_json: "{bad"
      }
    ]
  });
  setPoolForTesting(fake.pool);
  try {
    assert.deepEqual(await getJobHistory("2"), {
      items: [
        {
          id: 2,
          job_type: "run-daily",
          status: "running",
          started_at: "2026-07-06T10:00:00+00:00",
          finished_at: null,
          message: "Daily run 1/3",
          pid: 123,
          heartbeat_at: "2026-07-06T10:00:10+00:00",
          meta: { daily_progress: { current: 1 } }
        },
        {
          id: 1,
          job_type: "sync-obsidian",
          status: "failed",
          started_at: "2026-07-06T09:00:00+00:00",
          finished_at: "2026-07-06T09:01:00+00:00",
          message: "failed",
          pid: null,
          heartbeat_at: null,
          meta: {}
        }
      ]
    });
    assert.deepEqual(fake.calls[0].params, [2]);
  } finally {
    setPoolForTesting(null);
  }
});

test("getJobSummary returns running count and latest job shape", async () => {
  const fake = createJobsPool({
    runningCount: "3",
    latestRow: {
      id: "10",
      job_type: "generate-paper-reports",
      status: "completed",
      started_at: "2026-07-06T10:00:00+00:00",
      finished_at: "2026-07-06T10:02:00+00:00",
      message: "done",
      heartbeat_at: "2026-07-06T10:01:00+00:00"
    }
  });
  setPoolForTesting(fake.pool);
  try {
    assert.deepEqual(await getJobSummary(), {
      running_count: 3,
      latest_job: {
        id: 10,
        job_type: "generate-paper-reports",
        status: "completed",
        started_at: "2026-07-06T10:00:00+00:00",
        finished_at: "2026-07-06T10:02:00+00:00",
        message: "done",
        heartbeat_at: "2026-07-06T10:01:00+00:00"
      }
    });
  } finally {
    setPoolForTesting(null);
  }
});

test("getJobSummary returns null latest job for an empty job_runs table", async () => {
  const fake = createJobsPool();
  setPoolForTesting(fake.pool);
  try {
    assert.deepEqual(await getJobSummary(), {
      running_count: 0,
      latest_job: null
    });
  } finally {
    setPoolForTesting(null);
  }
});

test("normalizeJobLimit validates route limits", () => {
  assert.equal(normalizeJobLimit(null, 20), 20);
  assert.equal(normalizeJobLimit("", 20), 20);
  assert.equal(normalizeJobLimit("0", 20), 0);
  assert.equal(normalizeJobLimit("12", 20), 12);
  assert.throws(() => normalizeJobLimit("abc", 20), ValidationError);
  assert.throws(() => normalizeJobLimit("-1", 20), ValidationError);
});
