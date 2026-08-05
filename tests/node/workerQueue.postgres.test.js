import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import pg from "pg";

import { setPoolForTesting } from "../../server/db.js";
import { getJobHistory } from "../../server/jobs.js";
import { enqueueWorkerJob } from "../../server/workerQueue.js";

const { Client, Pool } = pg;
const databaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

test("ordinary enqueue does not create job_runs while daily enqueue remains linked", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; skipping PostgreSQL worker enqueue integration test"
}, async () => {
  const schema = `ris_worker_fact_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  const initialized = spawnSync(process.env.PYTHON_BIN || "python", ["-m", "worker.cli", "init-db"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, PGOPTIONS: `-c search_path=${schema}` },
    encoding: "utf8",
    windowsHide: true
  });
  if (initialized.status !== 0) {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
    assert.fail(`schema initialization failed: ${initialized.stderr || initialized.stdout}`);
  }
  await client.query(`SET search_path TO "${schema}"`);
  const testPool = {
    query(sql, params) { return client.query(sql, params); },
    async connect() {
      return { query(sql, params) { return client.query(sql, params); }, release() {} };
    }
  };
  setPoolForTesting(testPool);
  try {
    for (const jobType of ["reader-import-url", "artifact-index", "artifact-export-obsidian", "paper-report"]) {
      const queued = await enqueueWorkerJob({ jobType, payload: { command: jobType } });
      assert.equal(queued.job_run, null, jobType);
      assert.equal(queued.worker_job.job_run_id, null, jobType);
    }
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM job_runs")).rows[0].count), 0);
    const daily = await enqueueWorkerJob({ jobType: "run-daily", payload: { command: "run-daily" } });
    assert.ok(daily.job_run.id > 0);
    assert.equal(daily.worker_job.job_run_id, daily.job_run.id);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM job_runs")).rows[0].count), 1);
    const mirror = (await client.query(`
      INSERT INTO job_runs(job_type, status, started_at, message, heartbeat_at, meta_json)
      VALUES ('sync-obsidian', 'completed', NOW(), 'legacy mirror', NOW(), '{"worker_job":true}') RETURNING id
    `)).rows[0];
    const linkedWorker = (await client.query(`
      INSERT INTO worker_jobs(job_run_id, job_type, status, payload_json, created_at, updated_at)
      VALUES ($1, 'sync-obsidian', 'completed', '{}', NOW(), NOW()) RETURNING id
    `, [mirror.id])).rows[0];
    const orphan = (await client.query(`
      INSERT INTO job_runs(job_type, status, started_at, message, heartbeat_at, meta_json)
      VALUES ('fetch-arxiv', 'failed', NOW(), 'orphan legacy history', NOW(), '{"worker_job":true}') RETURNING id
    `)).rows[0];
    const history = (await getJobHistory(20)).items;
    assert.equal(history.filter((item) => item.record_type === "daily_run").length, 1);
    assert.equal(history.filter((item) => item.worker_job_id === Number(linkedWorker.id)).length, 1);
    assert.equal(history.filter((item) => item.job_run_id === Number(mirror.id)).length, 1);
    assert.equal(history.filter((item) => item.job_run_id === Number(orphan.id)).length, 1);
    assert.equal(history.find((item) => item.job_run_id === Number(orphan.id)).worker_job_id, null);
  } finally {
    setPoolForTesting(null);
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});

test("concurrent Reader URL enqueue reuses one active canonical-set job", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; skipping PostgreSQL queue integration test"
}, async () => {
  const schema = `ris_worker_queue_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const initialized = spawnSync(process.env.PYTHON_BIN || "python", ["-m", "worker.cli", "init-db"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, PGOPTIONS: `-c search_path=${schema}` },
    encoding: "utf8",
    windowsHide: true
  });
  if (initialized.status !== 0) {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    assert.fail(`schema initialization failed: ${initialized.stderr || initialized.stdout}`);
  }
  await admin.query(`SET search_path TO "${schema}"`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  setPoolForTesting(pool);
  try {
    const requests = await Promise.all([
      enqueueWorkerJob({
        jobType: "reader-import-url",
        payload: { body: { urls: ["HTTPS://Example.test:443/paper?b=2&a=1#part", "https://b.test/x"] } }
      }),
      enqueueWorkerJob({
        jobType: "reader-import-url",
        payload: { body: { urls: ["https://b.test/x", "https://example.test/paper?a=1&b=2"] } }
      })
    ]);
    assert.equal(new Set(requests.map((item) => item.worker_job.id)).size, 1);
    assert.deepEqual(requests.map((item) => item.deduplicated).sort(), [false, true]);
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS count FROM worker_jobs")).rows[0].count), 1);
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS count FROM app_events WHERE event_type = 'task.started'")).rows[0].count), 1);
  } finally {
    setPoolForTesting(null);
    await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
