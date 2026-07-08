import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import {
  getArtifactDetail,
  getArtifacts,
  normalizeArtifactLimit,
  normalizeArtifactsFilter
} from "../../server/artifacts.js";

function artifactRow(overrides = {}) {
  return {
    id: "1",
    scope_type: "project",
    scope_id: "7",
    artifact_type: "project_index",
    title: "Project Index",
    content_markdown: "# Index",
    content_json: "{\"obsidian_export\":{\"path\":\"Projects/Index.md\"},\"project_id\":7}",
    status: "ready",
    source_json: "{\"source_key\":\"project_index:7\"}",
    model_provider_id: "",
    model: "",
    input_hash: "hash",
    created_at: "2026-07-06T00:00:00Z",
    updated_at: "2026-07-06T01:00:00Z",
    ...overrides
  };
}

function createArtifactsPool(rows = [artifactRow()]) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({ sql, params });
        const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        if (normalized.startsWith("SELECT * FROM ARTIFACTS WHERE ID = $1")) {
          return { rows: rows.filter((row) => Number(row.id) === Number(params[0])) };
        }
        if (normalized.startsWith("SELECT * FROM ARTIFACTS")) {
          let filtered = rows;
          if (normalized.includes("SCOPE_TYPE = $1")) {
            filtered = filtered.filter((row) => row.scope_type === params[0]);
          }
          if (normalized.includes("SCOPE_ID = $2")) {
            filtered = filtered.filter((row) => Number(row.scope_id) === Number(params[1]));
          }
          if (normalized.includes("ARTIFACT_TYPE =")) {
            const index = normalized.includes("ARTIFACT_TYPE = $3") ? 2 : 1;
            filtered = filtered.filter((row) => row.artifact_type === params[index]);
          }
          if (normalized.includes("STATUS =")) {
            const statusIndex = params.findIndex((item) => item === "ready" || item === "draft");
            if (statusIndex >= 0) {
              filtered = filtered.filter((row) => row.status === params[statusIndex]);
            }
          }
          return { rows: filtered.slice(0, Number(params[params.length - 1])) };
        }
        throw new Error(`Unexpected SQL in artifacts test: ${sql}`);
      }
    }
  };
}

test("getArtifacts returns Python-compatible artifact payloads with parsed JSON", async () => {
  const fake = createArtifactsPool([
    artifactRow(),
    artifactRow({
      id: "2",
      scope_type: "system",
      scope_id: null,
      artifact_type: "daily_report",
      title: "Daily",
      content_json: "{bad json",
      source_json: ""
    })
  ]);
  setPoolForTesting(fake.pool);
  try {
    const data = await getArtifacts({ limit: "50" });
    assert.equal(data.items.length, 2);
    assert.equal(data.items[0].id, 1);
    assert.equal(data.items[0].scope_id, 7);
    assert.deepEqual(data.items[0].content_json.obsidian_export, { path: "Projects/Index.md" });
    assert.deepEqual(data.items[0].source, { source_key: "project_index:7" });
    assert.deepEqual(data.items[1].content_json, {});
    assert.deepEqual(data.items[1].source, {});
  } finally {
    setPoolForTesting(null);
  }
});

test("getArtifacts applies filters and validates numeric values", async () => {
  const fake = createArtifactsPool([
    artifactRow(),
    artifactRow({ id: "2", scope_type: "paper", scope_id: "3", artifact_type: "paper_report", status: "draft" })
  ]);
  setPoolForTesting(fake.pool);
  try {
    const data = await getArtifacts({
      scope_type: "project",
      scope_id: "7",
      artifact_type: "project_index",
      status: "ready",
      limit: "10"
    });
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].title, "Project Index");
    assert.deepEqual(fake.calls[0].params, ["project", 7, "project_index", "ready", 10]);
    assert.throws(() => normalizeArtifactsFilter({ scope_id: "x" }), ValidationError);
    assert.throws(() => normalizeArtifactLimit("0"), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});

test("getArtifactDetail returns { artifact } and raises not found", async () => {
  const fake = createArtifactsPool([artifactRow({ id: "3" })]);
  setPoolForTesting(fake.pool);
  try {
    const data = await getArtifactDetail(3);
    assert.equal(data.artifact.id, 3);
    assert.equal(data.artifact.content_markdown, "# Index");
    await assert.rejects(() => getArtifactDetail(9), /Artifact not found/);
  } finally {
    setPoolForTesting(null);
  }
});
