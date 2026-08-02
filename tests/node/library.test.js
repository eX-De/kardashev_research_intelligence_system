import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import {
  getPaperLibrary,
  getPaperLibraryDetail,
  getPaperLibraryImportStatus,
  locatePaperLibraryItem,
  updatePaperLibraryStatus
} from "../../server/library.js";

function paperRow(overrides = {}) {
  return {
    id: "1",
    canonical_key: "arxiv:2607.00001",
    title: "Library Paper",
    authors_json: "[\"A\", \"B\"]",
    abstract: "A paper abstract",
    published_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-06T00:00:00Z",
    year: "2026",
    venue: "",
    doi: "",
    arxiv_id: "2607.00001",
    importance: "high",
    library_status: "saved",
    reading_state: "unread",
    user_tags_json: "[]",
    user_note: "",
    saved_at: "2026-07-06T00:00:00Z",
    last_read_at: null,
    created_at: "2026-07-05T00:00:00Z",
    source: "daily",
    source_type: "arxiv",
    last_imported_at: null,
    activity_at: "2026-07-06T00:00:00Z",
    asset_count: "0",
    chunk_count: "0",
    artifact_count: "0",
    ...overrides
  };
}

function createLibraryPool() {
  const txCalls = [];
  const papers = [
    paperRow(),
    paperRow({
      id: "2",
      canonical_key: "manual:archived",
      title: "Archived Paper",
      authors_json: "[]",
      arxiv_id: "",
      library_status: "archived",
      saved_at: null
    })
  ];
  const sources = [
    {
      id: "10",
      paper_id: "1",
      source_type: "arxiv",
      source_identifier: "2607.00001",
      source_url: "https://arxiv.org/abs/2607.00001",
      metadata_json: "{\"pdf_link\":\"pdf\"}",
      fetched_batch_id: "batch",
      created_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z"
    }
  ];
  const assets = [
    {
      id: "20",
      paper_id: "1",
      asset_type: "pdf",
      path: "",
      url: "https://arxiv.org/pdf/2607.00001",
      status: "pending",
      error_message: "",
      metadata_json: "{}",
      created_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z"
    }
  ];
  const chunks = [
    {
      id: "30",
      paper_id: "1",
      asset_id: null,
      chunk_index: "0",
      source: "abstract",
      page_start: null,
      page_end: null,
      text: "Chunk text",
      token_count: "2",
      char_count: "10",
      created_at: "2026-07-06T00:00:00Z"
    }
  ];
  const arxivPapers = [{ id: "101", arxiv_id: "2607.00001" }];
  const projectPapers = [{ project_id: "5", paper_id: "1", relation: "reading", note: "", importance: "high", updated_at: "2026-07-06T00:00:00Z" }];
  const projects = [{ id: "5", name: "Project" }];
  const artifacts = [
    {
      id: "40",
      scope_type: "paper",
      scope_id: "1",
      artifact_type: "paper_report",
      title: "Report",
      content_markdown: "Report markdown",
      content_json: "{\"prompt\":\"p\",\"system_prompt\":\"s\",\"source_project_ids\":[5],\"started_at\":\"start\",\"finished_at\":\"finish\"}",
      status: "done",
      source_json: "{\"source_key\":\"paper_report:1\",\"source_text_hash\":\"hash\"}",
      model_provider_id: "provider",
      model: "model",
      input_hash: "hash",
      created_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z"
    }
  ];
  const calls = [];

  function visiblePapers(params = []) {
    if (params.includes("saved")) return papers.filter((paper) => paper.library_status === "saved");
    if (params.includes("archived") && params.includes("discarded")) {
      return papers.filter((paper) => !["archived", "discarded"].includes(paper.library_status));
    }
    return papers;
  }

  async function runQuery(sql, params = []) {
    calls.push({ sql, params });
    const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
      txCalls.push(normalized);
      return { rows: [] };
    }
    if (normalized.startsWith("WITH ACCEPTED_IMPORTANCE AS") && normalized.includes("ROW_NUMBER() OVER")) {
      const targetId = Number(params[params.length - 1]);
      const targetOffset = visiblePapers(params).findIndex((paper) => Number(paper.id) === targetId);
      return {
        rows: targetOffset >= 0 ? [{ id: String(targetId), target_offset: String(targetOffset) }] : []
      };
    }
    if (normalized.startsWith("WITH FILTERED AS") || normalized.startsWith("WITH ACCEPTED_IMPORTANCE AS")) {
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      const selected = visiblePapers(params)
        .slice(offset, offset + limit)
        .map((paper) => ({
          ...paper,
          asset_count: String(assets.filter((asset) => asset.paper_id === paper.id).length),
          chunk_count: String(chunks.filter((chunk) => chunk.paper_id === paper.id).length),
          artifact_count: String(artifacts.filter((artifact) => artifact.scope_type === "paper" && artifact.scope_id === paper.id).length),
          ...(() => {
            const report = artifacts
              .filter((artifact) => artifact.scope_type === "paper" && artifact.scope_id === paper.id && artifact.artifact_type === "paper_report" && artifact.status !== "removed")
              .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)) || Number(right.id) - Number(left.id))[0];
            return report ? {
              report_artifact_id: report.id,
              report_status: report.status,
              report_content_json: report.content_json,
              report_source_json: report.source_json,
              report_created_at: report.created_at,
              report_updated_at: report.updated_at,
              report_source: "daily"
            } : {};
          })()
        }));
      return { rows: selected };
    }
    if (normalized.startsWith("SELECT COUNT(*) AS COUNT FROM PAPERS")) {
      return { rows: [{ count: String(visiblePapers(params).length) }] };
    }
    if (normalized.startsWith("SELECT * FROM PAPERS WHERE ID = $1")) {
      return { rows: papers.filter((paper) => Number(paper.id) === Number(params[0])) };
    }
    if (normalized.startsWith("SELECT ID, SOURCE_TYPE")) {
      return { rows: sources.filter((source) => Number(source.paper_id) === Number(params[0])) };
    }
    if (normalized.startsWith("SELECT ID, ASSET_TYPE")) {
      return { rows: assets.filter((asset) => Number(asset.paper_id) === Number(params[0])) };
    }
    if (normalized.startsWith("SELECT ID, ASSET_ID")) {
      return { rows: chunks.filter((chunk) => Number(chunk.paper_id) === Number(params[0])) };
    }
    if (normalized.startsWith("SELECT ID FROM ARXIV_PAPERS")) {
      return { rows: arxivPapers.filter((paper) => paper.arxiv_id === params[0]) };
    }
    if (normalized.startsWith("SELECT PP.PROJECT_ID")) {
      return {
        rows: projectPapers
          .filter((link) => Number(link.paper_id) === Number(params[0]))
          .map((link) => ({
            ...link,
            project_name: projects.find((project) => project.id === link.project_id)?.name || ""
          }))
      };
    }
    if (normalized.startsWith("SELECT ID, ARTIFACT_TYPE")) {
      return {
        rows: artifacts
          .filter((artifact) => artifact.scope_type === "paper" && Number(artifact.scope_id) === Number(params[0]))
          .map(({ id, artifact_type, title, status, updated_at }) => ({ id, artifact_type, title, status, updated_at }))
      };
    }
    if (normalized.startsWith("SELECT * FROM ARTIFACTS")) {
      return { rows: artifacts.filter((artifact) => Number(artifact.scope_id) === Number(params[0]) && artifact.artifact_type === params[1]) };
    }
    if (normalized.startsWith("UPDATE PAPERS SET")) {
      const paperId = params[params.length - 1];
      const paper = papers.find((item) => Number(item.id) === Number(paperId));
      Object.assign(paper, {
        library_status: params[0],
        reading_state: params[1],
        saved_at: params[2],
        last_read_at: params[3],
        updated_at: params[4]
      });
      const noteIndex = normalized.includes("USER_NOTE") ? params.length - (normalized.includes("USER_TAGS_JSON") ? 3 : 2) : -1;
      if (noteIndex >= 0) paper.user_note = params[noteIndex];
      if (normalized.includes("USER_TAGS_JSON")) paper.user_tags_json = params[params.length - 2];
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in library test: ${sql}`);
  }

  return {
    artifacts,
    calls,
    papers,
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

test("getPaperLibrary hides archived by default and returns counts", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    const data = await getPaperLibrary({ limit: "25", offset: "0" });
    assert.equal(data.total, 1);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].asset_count, 1);
    assert.equal(data.items[0].chunk_count, 1);
    assert.equal(data.items[0].artifact_count, 1);
    assert.equal(data.items[0].source, "daily");
    assert.equal(data.items[0].source_type, "arxiv");
    assert.equal(data.items[0].last_imported_at, null);
    assert.equal(data.items[0].last_activity_at, "2026-07-06T00:00:00Z");
    assert.deepEqual(data.items[0].paper_report, {
      paper_id: 1,
      artifact_id: 40,
      status: "done",
      source: "daily",
      source_key: "paper_report:1",
      created_at: "2026-07-05T00:00:00Z",
      updated_at: "2026-07-06T00:00:00Z",
      started_at: "start",
      finished_at: "finish"
    });
    assert.equal(data.items[0].paper_report.report_markdown, undefined);
    assert.deepEqual(data.items[0].authors, ["A", "B"]);
    assert.deepEqual(fake.calls[0].params, ["archived", "discarded", 25, 0]);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary locates a deep-linked paper under the active filters and page size", async () => {
  const fake = createLibraryPool();
  for (let id = 3; id <= 27; id += 1) {
    fake.papers.push(paperRow({
      id: String(id),
      canonical_key: `manual:${id}`,
      title: `Library Paper ${id}`,
      arxiv_id: ""
    }));
  }
  setPoolForTesting(fake.pool);
  try {
    const data = await getPaperLibrary({ locate_id: "27", limit: "10", offset: "0" });
    assert.deepEqual(data.located, { paper_id: 27, offset: 25, page: 3 });
    assert.match(fake.calls[2].sql, /ROW_NUMBER\(\) OVER \(ORDER BY f\.activity_at DESC, f\.id DESC\)/i);
    assert.deepEqual(fake.calls[2].params, ["archived", "discarded", 27]);
    await assert.rejects(() => getPaperLibrary({ locate_id: "0" }), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});

test("locatePaperLibraryItem returns only location metadata", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    const data = await locatePaperLibraryItem({ locate_id: "1", limit: "10" });

    assert.deepEqual(data, { located: { paper_id: 1, offset: 0, page: 1 } });
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0].sql, /ROW_NUMBER\(\) OVER/);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary returns a stable missing report summary", async () => {
  const fake = createLibraryPool();
  fake.artifacts.length = 0;
  setPoolForTesting(fake.pool);
  try {
    const data = await getPaperLibrary({ limit: "25", offset: "0" });
    assert.deepEqual(data.items[0].paper_report, {
      paper_id: 1,
      artifact_id: null,
      status: "missing",
      source: "daily",
      source_key: "",
      created_at: null,
      updated_at: null,
      started_at: null,
      finished_at: null
    });
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary filters papers by report presence", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    await getPaperLibrary({ report_presence: "with", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /EXISTS\s*\(\s*SELECT 1\s*FROM artifacts report_filter/i);
    assert.match(fake.calls[0].sql, /report_filter\.artifact_type = 'paper_report'/i);
    assert.match(fake.calls[0].sql, /report_filter\.status <> 'removed'/i);

    fake.calls.length = 0;
    await getPaperLibrary({ report_presence: "without", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /NOT EXISTS\s*\(\s*SELECT 1\s*FROM artifacts report_filter/i);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary rejects invalid report presence", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    await assert.rejects(() => getPaperLibrary({ report_presence: "maybe" }), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary filters by the latest report status", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    await getPaperLibrary({ report_status: "failed", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /COALESCE\(\(\s*SELECT report_status_filter\.status/i);
    assert.match(fake.calls[0].sql, /ORDER BY report_status_filter\.updated_at DESC, report_status_filter\.id DESC/i);
    assert.equal(fake.calls[0].params.includes("failed"), true);
    await assert.rejects(() => getPaperLibrary({ report_status: "unknown" }), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary uses the report queue daily and manual source contract", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    await getPaperLibrary({ source: "manual", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /COALESCE\(source_filter\.fetched_batch_id, ''\) = 'reader-import'/i);
    assert.match(fake.calls[0].sql, /source_filter\.source_type IN \('url', 'upload', 'web', 'manual'\)/i);

    fake.calls.length = 0;
    await getPaperLibrary({ source: "daily", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /NOT EXISTS\s*\(\s*SELECT 1\s*FROM paper_sources source_filter/i);

    await assert.rejects(() => getPaperLibrary({ source: "arxiv" }), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary exposes, filters, and sorts accepted recommendation importance", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    const data = await getPaperLibrary({ importance: "high", sort: "importance", limit: "25", offset: "0" });
    assert.equal(data.items[0].importance, "high");
    assert.match(fake.calls[0].sql, /importance_recommendation\.importance\s*=\s*\$\d+/i);
    assert.match(fake.calls[0].sql, /ORDER BY f\.importance_rank, f\.activity_at DESC, f\.id DESC/i);
    await assert.rejects(() => getPaperLibrary({ importance: "critical" }), ValidationError);
    await assert.rejects(() => getPaperLibrary({ sort: "score" }), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibrary offers explicit stable activity, import, and workflow sort modes", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    await getPaperLibrary({ sort: "updated", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /ORDER BY f\.activity_at DESC, f\.id DESC/i);

    fake.calls.length = 0;
    await getPaperLibrary({ sort: "imported", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /ORDER BY f\.last_imported_at DESC NULLS LAST, f\.activity_at DESC, f\.id DESC/i);

    fake.calls.length = 0;
    await getPaperLibrary({ sort: "workflow", limit: "25", offset: "0" });
    assert.match(fake.calls[0].sql, /ORDER BY CASE f\.library_status[\s\S]*f\.activity_at DESC, f\.id DESC/i);
  } finally {
    setPoolForTesting(null);
  }
});

test("getPaperLibraryImportStatus projects active imports without exposing staged paths", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (String(sql).includes("FROM worker_instances")) {
        return { rows: [] };
      }
      if (String(sql).includes("oldest_queued_at")) {
        return { rows: [{ queued: "1", running: "1", oldest_queued_at: "2026-08-01T14:59:00Z", oldest_queued_seconds: "60" }] };
      }
      if (String(sql).includes("COUNT(*) FILTER")) {
        return { rows: [{ queued: "1", running: "1", completed: "2", failed: "1" }] };
      }
      return {
        rows: [
          {
            id: "51",
            job_run_id: "118",
            job_type: "reader-import-upload",
            status: "running",
            payload_json: JSON.stringify({ body: { files: [{ filename: "paper.pdf", staged_path: "D:/private/staging.upload" }] } }),
            result_json: "{}",
            error_message: "",
            created_at: "2026-08-01T15:00:00Z",
            updated_at: "2026-08-01T15:01:00Z",
            started_at: "2026-08-01T15:01:00Z",
            finished_at: null
          },
          {
            id: "50",
            job_run_id: "117",
            job_type: "reader-import-url",
            status: "queued",
            payload_json: JSON.stringify({ body: { urls: "https://arxiv.org/abs/2301.05217\nhttps://example.test/paper.pdf" } }),
            result_json: "{}",
            error_message: "",
            created_at: "2026-08-01T14:59:00Z",
            updated_at: "2026-08-01T14:59:00Z",
            started_at: null,
            finished_at: null
          },
          {
            id: "49",
            job_run_id: "116",
            job_type: "reader-import-web",
            status: "completed",
            payload_json: JSON.stringify({ body: { urls: "https://example.test/article" } }),
            result_json: JSON.stringify({ ok: true, imported: [{ paper_id: 7, title: "Imported paper" }], errors: [] }),
            error_message: "",
            created_at: "2026-08-01T14:50:00Z",
            updated_at: "2026-08-01T14:51:00Z",
            started_at: "2026-08-01T14:50:01Z",
            finished_at: "2026-08-01T14:51:00Z"
          }
        ]
      };
    }
  };

  const data = await getPaperLibraryImportStatus({ limit: "20" }, db);
  assert.equal(data.stats.active, 2);
  assert.equal(data.active_items.length, 2);
  assert.deepEqual(data.active_items[0].targets, ["paper.pdf"]);
  assert.deepEqual(data.active_items[1].targets, ["https://arxiv.org/abs/2301.05217", "https://example.test/paper.pdf"]);
  assert.equal(data.latest.imported_count, 1);
  assert.equal(data.active_items[1].display_status, "waiting_for_worker");
  assert.equal(data.worker.available, false);
  assert.equal(data.latest.imported[0].paper_id, 7);
  assert.equal(JSON.stringify(data).includes("private/staging"), false);
  assert.match(calls.find((call) => !String(call.sql).includes("COUNT(*) FILTER")).sql, /status IN \('queued', 'running'\)/i);
  assert.deepEqual(calls[0].params.slice(0, 2), [["reader-import-url", "reader-import-web", "reader-import-upload"], "30 minutes"]);
});

test("getPaperLibraryDetail returns nested paper library shape with paper report", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    const detail = await getPaperLibraryDetail(1);
    assert.equal(detail.paper.id, 1);
    assert.equal(detail.sources[0].source_type, "arxiv");
    assert.equal(detail.assets[0].asset_type, "pdf");
    assert.equal(detail.chunks[0].text, "Chunk text");
    assert.equal(detail.linked_projects[0].project_id, 5);
    assert.equal(detail.artifacts[0].artifact_type, "paper_report");
    assert.equal(detail.paper_report.status, "done");
    assert.equal(detail.paper_report.artifact_id, 40);
    assert.equal(detail.paper_report.paper_id, 1);
    assert.equal(detail.paper.importance, "high");
    assert.equal(detail.linked_projects[0].importance, "high");
  } finally {
    setPoolForTesting(null);
  }
});

test("updatePaperLibraryStatus updates status fields and returns detail plus result", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    const detail = await updatePaperLibraryStatus(1, {
      status: "read",
      user_note: "done",
      user_tags: ["important"]
    });
    assert.equal(detail.ok, true);
    assert.equal(detail.paper_id, 1);
    assert.equal(detail.library_status, "read");
    assert.equal(detail.reading_state, "read");
    assert.equal(detail.paper.library_status, "read");
    assert.equal(detail.paper.user_note, "done");
    assert.deepEqual(detail.paper.user_tags, ["important"]);
    assert.ok(detail.paper.last_read_at);
    assert.deepEqual(fake.txCalls.slice(0, 2), ["BEGIN", "COMMIT"]);
  } finally {
    setPoolForTesting(null);
  }
});

test("updatePaperLibraryStatus rejects invalid status", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    await assert.rejects(() => updatePaperLibraryStatus(1, { status: "bad" }), ValidationError);
  } finally {
    setPoolForTesting(null);
  }
});
