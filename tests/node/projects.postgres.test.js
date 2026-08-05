import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import pg from "pg";

import { setPoolForTesting } from "../../server/db.js";
import { saveProject } from "../../server/projects.js";

const { Client, Pool } = pg;
const databaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

test("project context persistence, dedupe, retry, and rollback are transactional on PostgreSQL", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; skipping PostgreSQL project context integration test"
}, async () => {
  const schema = `ris_project_context_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  const initialized = spawnSync(
    process.env.PYTHON_BIN || "python",
    ["-m", "worker.cli", "init-db"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl, PGOPTIONS: `-c search_path=${schema}` },
      encoding: "utf8",
      windowsHide: true
    }
  );
  if (initialized.status !== 0) {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
    assert.fail(`schema initialization failed: ${initialized.stderr || initialized.stdout}`);
  }
  await client.query(`SET search_path TO "${schema}"`);
  const testPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  setPoolForTesting(testPool);
  try {
    const first = await saveProject({ name: "Offline-safe context", raw_context: "Initial context body for indexing" });
    assert.equal(first.context_document.index_status, "pending");
    assert.equal(first.context_job.worker_job.job_type, "knowledge-document-index");
    assert.equal(first.context_job.worker_job.job_run_id, null);
    assert.deepEqual(Object.keys(first.context_job.worker_job.payload).sort(), ["content_hash", "document_id", "project_id"]);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_instances")).rows[0].count), 0);

    const documentId = first.context_document.document_id;
    await client.query(
      "INSERT INTO research_chunks(document_id, chunk_index, heading, text, token_count, source, created_at) VALUES ($1, 0, '', 'stale chunk', 2, 'manual_project', NOW())",
      [documentId]
    );
    const second = await saveProject({ id: first.project.id, name: first.project.name, raw_context: "New context body for indexing" });
    assert.equal(second.context_document.document_id, documentId);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM research_chunks WHERE document_id = $1", [documentId])).rows[0].count), 0);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE job_type = 'knowledge-document-index'")).rows[0].count), 2);

    const duplicate = await saveProject({ id: first.project.id, name: first.project.name, raw_context: "New context body for indexing" });
    assert.equal(duplicate.context_job.deduplicated, true);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE job_type = 'knowledge-document-index'")).rows[0].count), 2);

    await client.query("UPDATE worker_jobs SET status = 'failed' WHERE id = $1", [duplicate.context_job.worker_job_id]);
    await client.query("UPDATE knowledge_documents SET index_status = 'failed', index_error = 'retry me' WHERE id = $1", [documentId]);
    const retry = await saveProject({ id: first.project.id, name: first.project.name, raw_context: "New context body for indexing" });
    assert.equal(retry.context_document.index_status, "pending");
    assert.equal(retry.context_job.deduplicated, false);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE job_type = 'knowledge-document-index'")).rows[0].count), 3);

    const before = {
      projects: Number((await client.query("SELECT COUNT(*) AS count FROM research_projects")).rows[0].count),
      documents: Number((await client.query("SELECT COUNT(*) AS count FROM knowledge_documents")).rows[0].count),
      jobs: Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs")).rows[0].count)
    };
    await client.query(`
      CREATE FUNCTION reject_context_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'task.started' THEN RAISE EXCEPTION 'outbox rejected'; END IF;
        RETURN NEW;
      END $$
    `);
    await client.query("CREATE TRIGGER reject_context_outbox BEFORE INSERT ON app_events FOR EACH ROW EXECUTE FUNCTION reject_context_outbox() ");
    await assert.rejects(() => saveProject({ name: "Must roll back", raw_context: "This must not persist" }));
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM research_projects")).rows[0].count), before.projects);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM knowledge_documents")).rows[0].count), before.documents);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs")).rows[0].count), before.jobs);
  } finally {
    setPoolForTesting(null);
    await testPool.end();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
