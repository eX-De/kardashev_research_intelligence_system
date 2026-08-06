import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import pg from "pg";

import { setPoolForTesting } from "../../server/db.js";
import {
  cancelPaperReport,
  enqueuePaperReport,
  materializeRecommendedPaperReports,
  paperReportConcurrencyKey
} from "../../server/paperReports.js";

const { Client, Pool } = pg;
const databaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

test("paper reports materialize, deduplicate, cancel, and roll back atomically", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; skipping PostgreSQL paper-report integration test"
}, async () => {
  const schema = `ris_paper_report_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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
    const now = new Date().toISOString();
    const project = await admin.query(
      `INSERT INTO research_projects(name, status, summary, goals, keywords_json, created_at, updated_at)
       VALUES ('Report Project', 'active', '', '', '[]', $1, $1) RETURNING id`,
      [now]
    );
    async function insertPaper(title) {
      const result = await admin.query(
        `INSERT INTO papers(canonical_key, title, authors_json, abstract, library_status, reading_state,
                            user_tags_json, created_at, updated_at)
         VALUES ($1, $2, '[]', '', 'candidate', 'unread', '[]', $3, $3) RETURNING id`,
        [`manual:${title}:${Math.random()}`, title, now]
      );
      return Number(result.rows[0].id);
    }
    async function recommend(paperId) {
      await admin.query(
        `INSERT INTO project_paper_recommendations(
           project_id, paper_id, state, importance, relation_type, reason,
           source_judgment_hash, created_at, updated_at
         ) VALUES ($1, $2, 'pending', '', 'direct', '', '', $3, $3)`,
        [project.rows[0].id, paperId, now]
      );
    }

    const paperId = await insertPaper("Concurrent report");
    await recommend(paperId);
    const concurrent = await Promise.all([
      enqueuePaperReport(paperId, {}),
      enqueuePaperReport(paperId, {})
    ]);
    assert.deepEqual(concurrent.map((item) => item.created).sort(), [false, true]);
    assert.equal(concurrent[0].worker_job_id, concurrent[1].worker_job_id);
    assert.equal(concurrent[0].job_run_id, null);
    assert.equal(concurrent[0].job_id, concurrent[0].worker_job_id);
    assert.equal(concurrent[0].command, "paper-report");
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS count FROM artifacts WHERE scope_id = $1 AND artifact_type = 'paper_report'", [paperId])).rows[0].count), 1);
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE job_type = 'paper-report' AND status IN ('queued', 'running')", [])).rows[0].count), 1);
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS count FROM job_runs")).rows[0].count), 0);
    const firstJob = (await admin.query("SELECT payload_json, concurrency_key FROM worker_jobs WHERE id = $1", [concurrent[0].worker_job_id])).rows[0];
    assert.equal(firstJob.concurrency_key, paperReportConcurrencyKey(paperId));
    assert.equal(Object.hasOwn(JSON.parse(firstJob.payload_json), "dedupe_key"), false);

    const beforeBulk = (await admin.query("SELECT updated_at, content_json FROM artifacts WHERE scope_id = $1 AND artifact_type = 'paper_report'", [paperId])).rows[0];
    const bulk = await materializeRecommendedPaperReports();
    const afterBulk = (await admin.query("SELECT updated_at, content_json FROM artifacts WHERE scope_id = $1 AND artifact_type = 'paper_report'", [paperId])).rows[0];
    assert.equal(bulk.created, 0);
    assert.equal(bulk.deduplicated, 1);
    assert.deepEqual(afterBulk, beforeBulk);

    const secondProject = await admin.query(
      `INSERT INTO research_projects(name, status, summary, goals, keywords_json, created_at, updated_at)
       VALUES ('Second Report Project', 'active', '', '', '[]', $1, $1) RETURNING id`,
      [now]
    );
    await admin.query(
      `INSERT INTO project_paper_recommendations(
         project_id, paper_id, state, importance, relation_type, reason,
         source_judgment_hash, created_at, updated_at
       ) VALUES ($1, $2, 'pending', '', 'direct', '', '', $3, $3)`,
      [secondProject.rows[0].id, paperId, now]
    );
    await admin.query(
      "UPDATE artifacts SET updated_at = '2000-01-01T00:00:00Z' WHERE scope_id = $1 AND artifact_type = 'paper_report'",
      [paperId]
    );
    const refreshedBulk = await materializeRecommendedPaperReports({ paperIds: [paperId] });
    assert.equal(refreshedBulk.deduplicated, 1);
    const refreshedArtifact = (await admin.query(
      "SELECT updated_at, content_json FROM artifacts WHERE scope_id = $1 AND artifact_type = 'paper_report'",
      [paperId]
    )).rows[0];
    assert.deepEqual(JSON.parse(refreshedArtifact.content_json).source_project_ids, [
      Number(project.rows[0].id), Number(secondProject.rows[0].id)
    ]);
    assert.notEqual(refreshedArtifact.updated_at, "2000-01-01T00:00:00Z");

    const legacyArtifactPaper = await insertPaper("Legacy artifact");
    await recommend(legacyArtifactPaper);
    await admin.query(
      `INSERT INTO artifacts(scope_type, scope_id, artifact_type, title, content_markdown, content_json,
                             status, source_json, model_provider_id, model, input_hash, created_at, updated_at)
       VALUES ('paper', $1, 'paper_report', 'Legacy artifact', '', '{"prompt":"legacy"}', 'queued', '{}', '', '', '', $2, $2)`,
      [legacyArtifactPaper, now]
    );
    await enqueuePaperReport(legacyArtifactPaper);
    const queuedCancellation = await cancelPaperReport(legacyArtifactPaper);
    assert.equal(queuedCancellation.paper_report.status, "cancelled");
    assert.equal((await admin.query("SELECT status FROM worker_jobs WHERE (payload_json::jsonb ->> 'paper_id') = $1", [String(legacyArtifactPaper)])).rows[0].status, "cancelled");
    const cancellationTask = await admin.query(
      `SELECT payload_json FROM app_events WHERE event_type = 'task.cancelled' ORDER BY id DESC LIMIT 1`
    );
    const cancellationPayload = JSON.parse(cancellationTask.rows[0].payload_json);
    assert.equal(cancellationPayload.task.worker_job_id > 0, true);
    assert.equal(cancellationPayload.task.job_run_id, null);
    assert.equal(cancellationPayload.task.command, "paper-report");

    await admin.query("UPDATE worker_jobs SET status = 'running', locked_by = 'test', attempts = 1 WHERE id = $1", [concurrent[0].worker_job_id]);
    const runningCancellation = await cancelPaperReport(paperId);
    assert.equal(runningCancellation.paper_report.status, "cancelled");
    const runningJob = (await admin.query("SELECT status, cancel_requested_at FROM worker_jobs WHERE id = $1", [concurrent[0].worker_job_id])).rows[0];
    assert.equal(runningJob.status, "running");
    assert.ok(runningJob.cancel_requested_at);

    const rollbackPaper = await insertPaper("Rollback report");
    await admin.query(`
      CREATE FUNCTION reject_paper_report_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'task.started' THEN RAISE EXCEPTION 'outbox rejected'; END IF;
        RETURN NEW;
      END $$
    `);
    await admin.query("CREATE TRIGGER reject_paper_report_outbox BEFORE INSERT ON app_events FOR EACH ROW EXECUTE FUNCTION reject_paper_report_outbox() ");
    await assert.rejects(() => enqueuePaperReport(rollbackPaper, {}));
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS count FROM artifacts WHERE scope_id = $1 AND artifact_type = 'paper_report'", [rollbackPaper])).rows[0].count), 0);
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE (payload_json::jsonb ->> 'paper_id') = $1", [String(rollbackPaper)])).rows[0].count), 0);
  } finally {
    setPoolForTesting(null);
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
