import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import {
  getArtifactDetail,
  getArtifacts,
  normalizeArtifactLimit,
  normalizeArtifactOffset,
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

function createArtifactsPool(rows = [artifactRow()], relatedRows = []) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({ sql, params });
        const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        function filteredRows() {
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
            if (statusIndex >= 0) filtered = filtered.filter((row) => row.status === params[statusIndex]);
          }
          return filtered;
        }
        if (normalized.startsWith("SELECT * FROM ARTIFACTS WHERE ID = $1")) {
          return { rows: rows.filter((row) => Number(row.id) === Number(params[0])) };
        }
        if (normalized.includes("FROM ARXIV_PAPERS P") && normalized.includes("P.ARXIV_ID = ANY($1::TEXT[])")) {
          return { rows: relatedRows.filter((row) => params[0].includes(row.arxiv_id)) };
        }
        if (normalized.startsWith("SELECT COUNT(*)::INT AS TOTAL FROM ARTIFACTS")) {
          return { rows: [{ total: filteredRows().length }] };
        }
        if (normalized.startsWith("SELECT * FROM ARTIFACTS")) {
          const limit = Number(params[params.length - 2]);
          const offset = Number(params[params.length - 1]);
          return { rows: filteredRows().slice(offset, offset + limit) };
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
    assert.equal(data.total, 2);
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
    assert.deepEqual(fake.calls[0].params, ["project", 7, "project_index", "ready"]);
    assert.deepEqual(fake.calls[1].params, ["project", 7, "project_index", "ready", 10, 0]);
    assert.throws(() => normalizeArtifactsFilter({ scope_id: "x" }), ValidationError);
    assert.throws(() => normalizeArtifactLimit("0"), ValidationError);
    assert.throws(() => normalizeArtifactOffset("-1"), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});

test("getArtifacts returns total independently from the requested page", async () => {
  const fake = createArtifactsPool([
    artifactRow({ id: "1", title: "First" }),
    artifactRow({ id: "2", title: "Second" }),
    artifactRow({ id: "3", title: "Third" })
  ]);
  setPoolForTesting(fake.pool);
  try {
    const data = await getArtifacts({ limit: "1", offset: "1" });
    assert.equal(data.total, 3);
    assert.deepEqual(data.items.map((item) => item.title), ["Second"]);
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
    assert.deepEqual(data.artifact.related_papers, []);
    await assert.rejects(() => getArtifactDetail(9), /Artifact not found/);
  } finally {
    setPoolForTesting(null);
  }
});

test("getArtifactDetail resolves a daily report snapshot to pending and assigned papers", async () => {
  const dailyReport = artifactRow({
    id: "8",
    scope_type: "system",
    scope_id: null,
    artifact_type: "daily_report",
    title: "Daily",
    source_json: JSON.stringify({
      project_candidates: [
        { arxiv_id: "2607.00001", project: "Alpha" },
        { arxiv_id: "2607.00002", project: "Beta" },
        { arxiv_id: "2607.00001", project: "Gamma" }
      ]
    })
  });
  const fake = createArtifactsPool([dailyReport], [
    {
      id: "101",
      arxiv_id: "2607.00001",
      title: "Pending Paper",
      link: "https://arxiv.org/abs/2607.00001",
      published_at: "2026-07-18T00:00:00Z",
      library_paper_id: null,
      project_id: "7",
      project_name: "Alpha",
      state: "pending",
      relation_type: "direct",
      reason: "Useful for Alpha",
      updated_at: "2026-07-19T00:00:00Z"
    },
    {
      id: "101",
      arxiv_id: "2607.00001",
      title: "Pending Paper",
      link: "https://arxiv.org/abs/2607.00001",
      published_at: "2026-07-18T00:00:00Z",
      library_paper_id: null,
      project_id: "9",
      project_name: "Gamma",
      state: "pending",
      relation_type: "indirect",
      reason: "Useful for Gamma",
      updated_at: "2026-07-18T00:00:00Z"
    },
    {
      id: "102",
      arxiv_id: "2607.00002",
      title: "Assigned Paper",
      link: "https://arxiv.org/abs/2607.00002",
      published_at: "2026-07-17T00:00:00Z",
      library_paper_id: "202",
      project_id: "8",
      project_name: "Beta",
      state: "accepted",
      relation_type: "direct",
      reason: "Assigned to Beta",
      updated_at: "2026-07-19T00:00:00Z"
    }
  ]);
  setPoolForTesting(fake.pool);
  try {
    const data = await getArtifactDetail(8);
    assert.deepEqual(data.artifact.related_papers, [
      {
        id: 101,
        arxiv_id: "2607.00001",
        title: "Pending Paper",
        link: "https://arxiv.org/abs/2607.00001",
        published_at: "2026-07-18T00:00:00Z",
        library_paper_id: null,
        state: "pending",
        relation_type: "direct",
        reason: "Useful for Alpha",
        projects: [
          { project_id: 7, project_name: "Alpha", state: "pending" },
          { project_id: 9, project_name: "Gamma", state: "pending" }
        ]
      },
      {
        id: 102,
        arxiv_id: "2607.00002",
        title: "Assigned Paper",
        link: "https://arxiv.org/abs/2607.00002",
        published_at: "2026-07-17T00:00:00Z",
        library_paper_id: 202,
        state: "assigned",
        relation_type: "direct",
        reason: "Assigned to Beta",
        projects: [
          { project_id: 8, project_name: "Beta", state: "assigned" }
        ]
      }
    ]);
    assert.deepEqual(fake.calls[1].params, [["2607.00001", "2607.00002"]]);
    assert.match(fake.calls[1].sql, /r\.state IN \('pending', 'accepted'\)/);
    assert.match(fake.calls[1].sql, /arxiv_paper_tombstones/);
  } finally {
    setPoolForTesting(null);
  }
});
