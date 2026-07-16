import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import {
  getPaperLibrary,
  getPaperLibraryDetail,
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
    library_status: "saved",
    reading_state: "unread",
    user_tags_json: "[]",
    user_note: "",
    saved_at: "2026-07-06T00:00:00Z",
    last_read_at: null,
    created_at: "2026-07-05T00:00:00Z",
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
  const projectPapers = [{ project_id: "5", paper_id: "101", relation: "reading", note: "", updated_at: "2026-07-06T00:00:00Z" }];
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
      source_json: "{\"source_key\":\"paper_report:101\",\"source_text_hash\":\"hash\"}",
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
    if (normalized.startsWith("WITH FILTERED AS")) {
      const selected = visiblePapers(params)
        .slice(0, Number(params[params.length - 2]))
        .map((paper) => ({
          ...paper,
          asset_count: String(assets.filter((asset) => asset.paper_id === paper.id).length),
          chunk_count: String(chunks.filter((chunk) => chunk.paper_id === paper.id).length),
          artifact_count: String(artifacts.filter((artifact) => artifact.scope_type === "paper" && artifact.scope_id === paper.id).length)
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
    assert.deepEqual(data.items[0].authors, ["A", "B"]);
    assert.deepEqual(fake.calls[0].params, ["archived", "discarded", 25, 0]);
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

test("getPaperLibraryDetail returns nested paper library shape with paper report", async () => {
  const fake = createLibraryPool();
  setPoolForTesting(fake.pool);
  try {
    const detail = await getPaperLibraryDetail(1);
    assert.equal(detail.paper.id, 1);
    assert.equal(detail.legacy_arxiv_paper_id, 101);
    assert.equal(detail.sources[0].source_type, "arxiv");
    assert.equal(detail.assets[0].asset_type, "pdf");
    assert.equal(detail.chunks[0].text, "Chunk text");
    assert.equal(detail.linked_projects[0].project_id, 5);
    assert.equal(detail.artifacts[0].artifact_type, "paper_report");
    assert.equal(detail.paper_report.status, "done");
    assert.equal(detail.paper_report.artifact_id, 40);
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
