import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import pg from "pg";

import { setPoolForTesting } from "../../server/db.js";
import { artifactIndexContentHash, ensureProjectIndex } from "../../server/projectIndex.js";

const { Client, Pool } = pg;
const databaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/projects`);
      if (response.ok) return;
    } catch {
      // Server startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not become ready");
}

test("project index artifact, jobs, dedupe, and outbox are one PostgreSQL transaction", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; skipping PostgreSQL project-index integration test"
}, async () => {
  const schema = `ris_project_index_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  setPoolForTesting(pool);
  try {
    const now = new Date().toISOString();
    const inserted = await client.query(
      `INSERT INTO research_projects(name, status, summary, goals, keywords_json, created_at, updated_at)
       VALUES ('Offline Project', 'active', 'First summary', 'Ship it', '["index"]', $1, $1) RETURNING id`,
      [now]
    );
    const projectId = Number(inserted.rows[0].id);
    const [first, concurrent] = await Promise.all([
      ensureProjectIndex(projectId),
      ensureProjectIndex(projectId)
    ]);
    assert.equal(first.artifact.id, concurrent.artifact.id);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM artifacts")).rows[0].count), 1);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_instances")).rows[0].count), 0);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE job_type = 'artifact-index' AND status = 'queued'")).rows[0].count), 1);

    await client.query("UPDATE research_projects SET summary = 'Latest summary', updated_at = $1 WHERE id = $2", [new Date().toISOString(), projectId]);
    const latest = await ensureProjectIndex(projectId, { exportToObsidian: true, relativePath: "Projects/Latest.md" });
    assert.equal(latest.index_job.reused, true);
    assert.equal(latest.export_job.queued, true);
    const indexRows = await client.query("SELECT payload_json FROM worker_jobs WHERE job_type = 'artifact-index' AND status = 'queued'");
    assert.equal(indexRows.rows.length, 1);
    assert.equal(
      JSON.parse(indexRows.rows[0].payload_json).content_hash,
      artifactIndexContentHash(latest.artifact.title, latest.artifact.content_markdown)
    );
    const duplicateExport = await ensureProjectIndex(projectId, { exportToObsidian: true, relativePath: "Projects/Latest.md" });
    assert.equal(duplicateExport.export_job.deduplicated, true);
    assert.equal(Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE job_type = 'artifact-export-obsidian' AND status = 'queued'")).rows[0].count), 1);
    await client.query(
      "UPDATE worker_jobs SET status = 'running' WHERE id = $1",
      [duplicateExport.export_job.worker_job_id]
    );
    const otherPath = await ensureProjectIndex(projectId, { exportToObsidian: true, relativePath: "Projects/Other.md" });
    assert.equal(otherPath.export_job.queued, true);
    assert.notEqual(otherPath.export_job.worker_job_id, duplicateExport.export_job.worker_job_id);
    const dedupeOlderRunning = await ensureProjectIndex(projectId, { exportToObsidian: true, relativePath: "Projects/Latest.md" });
    assert.equal(dedupeOlderRunning.export_job.worker_job_id, duplicateExport.export_job.worker_job_id);
    assert.equal(dedupeOlderRunning.export_job.deduplicated, true);
    const dedupeNewestQueued = await ensureProjectIndex(projectId, { exportToObsidian: true, relativePath: "Projects/Other.md" });
    assert.equal(dedupeNewestQueued.export_job.worker_job_id, otherPath.export_job.worker_job_id);
    assert.equal(dedupeNewestQueued.export_job.deduplicated, true);
    const port = 39000 + Math.floor(Math.random() * 1000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const api = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGOPTIONS: `-c search_path=${schema}`,
        PORT: String(port),
        PANEL_PASSWORD: "",
        KRIS_OUTBOX_POLLER_ENABLED: "false",
        KRIS_UPDATE_CHECK_ENABLED: "false"
      },
      stdio: "ignore",
      windowsHide: true
    });
    try {
      await waitForServer(baseUrl, api);
      const generatedResponse = await fetch(`${baseUrl}/api/projects/${projectId}/artifacts/project-index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(generatedResponse.status, 200);
      const generated = await generatedResponse.json();
      assert.equal(generated.generated_artifact.id, latest.artifact.id);
      assert.equal(generated.index_job.worker_job_id > 0, true);

      const exportResponse = await fetch(`${baseUrl}/api/projects/${projectId}/export-obsidian`, { method: "POST" });
      assert.equal(exportResponse.status, 202);
      const exported = await exportResponse.json();
      assert.equal(exported.ok, true);
      assert.equal(exported.queued, true);
      assert.equal(exported.command, "artifact-export-obsidian");
      assert.equal(exported.job_id, exported.worker_job_id);
      assert.equal(exported.job_run_id, null);
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await new Promise((resolve) => api.once("exit", resolve));
      }
    }
    const eventTypes = (await client.query("SELECT event_type FROM app_events ORDER BY id")).rows.map((row) => row.event_type);
    assert.ok(eventTypes.includes("artifact.created"));
    assert.ok(eventTypes.includes("artifact.updated"));

    await client.query("UPDATE worker_jobs SET status = 'running' WHERE job_type = 'artifact-index' AND status = 'queued'");
    const before = {
      artifact: (await client.query("SELECT content_markdown, input_hash, updated_at FROM artifacts WHERE id = $1", [latest.artifact.id])).rows[0],
      jobs: Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs")).rows[0].count),
      events: Number((await client.query("SELECT COUNT(*) AS count FROM app_events")).rows[0].count)
    };
    await client.query(`
      CREATE FUNCTION reject_project_index_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'task.started' THEN RAISE EXCEPTION 'outbox rejected'; END IF;
        RETURN NEW;
      END $$
    `);
    await client.query("CREATE TRIGGER reject_project_index_outbox BEFORE INSERT ON app_events FOR EACH ROW EXECUTE FUNCTION reject_project_index_outbox() ");
    await client.query("UPDATE research_projects SET summary = 'Must roll back', updated_at = $1 WHERE id = $2", [new Date().toISOString(), projectId]);
    await assert.rejects(() => ensureProjectIndex(projectId));
    const after = {
      artifact: (await client.query("SELECT content_markdown, input_hash, updated_at FROM artifacts WHERE id = $1", [latest.artifact.id])).rows[0],
      jobs: Number((await client.query("SELECT COUNT(*) AS count FROM worker_jobs")).rows[0].count),
      events: Number((await client.query("SELECT COUNT(*) AS count FROM app_events")).rows[0].count)
    };
    assert.deepEqual(after, before);
  } finally {
    setPoolForTesting(null);
    await pool.end();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
