import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting } from "../../server/db.js";
import {
  cancelReaderReport,
  deleteReaderMessage,
  deleteReaderReport,
  getReaderPaperDetail,
  getReaderPapers,
  retryReaderReport
} from "../../server/reader.js";

const T0 = "2026-07-06T00:00:00Z";

function createReaderFake() {
  const txCalls = [];
  const arxivPapers = [
    {
      id: "101",
      arxiv_id: "2607.00001",
      title: "Reader Paper",
      authors_json: "[\"Ada\", \"Ben\"]",
      summary: "Reader abstract",
      categories_json: "[\"cs.AI\"]",
      published_at: "2026-07-01T00:00:00Z",
      updated_at: T0,
      link: "https://arxiv.org/abs/2607.00001",
      pdf_link: "https://arxiv.org/pdf/2607.00001",
      pdf_path: "data/paper.pdf",
      text_path: "data/paper.txt",
      text_extracted_at: T0,
      text_status: "complete",
      text_error: "",
      text_char_count: "1234",
      fetched_batch_id: "reader-import"
    }
  ];
  const papers = [{ id: "201", canonical_key: "arxiv:2607.00001", arxiv_id: "2607.00001" }];
  const artifacts = [
    {
      id: "301",
      scope_type: "paper",
      scope_id: "201",
      artifact_type: "paper_report",
      title: "Reader Paper",
      content_markdown: "Report markdown",
      content_json: JSON.stringify({
        paper_id: 201,
        legacy_arxiv_paper_id: 101,
        arxiv_id: "2607.00001",
        link: "https://arxiv.org/abs/2607.00001",
        prompt: "Analyze this paper",
        system_prompt: "system",
        source_project_ids: [7],
        error_message: "",
        started_at: "start",
        finished_at: "finish"
      }),
      status: "queued",
      source_json: JSON.stringify({
        source_key: "paper_report:101",
        generated_from: "paper_report_queue",
        legacy_arxiv_paper_id: 101,
        source_text_hash: "hash"
      }),
      model_provider_id: "provider",
      model: "model",
      input_hash: "hash",
      created_at: "2026-07-05T00:00:00Z",
      updated_at: T0
    }
  ];
  const messages = [
    {
      id: "401",
      paper_id: "101",
      role: "user",
      content: "Question",
      source: "chat",
      model_provider_id: "",
      model: "",
      created_at: T0
    }
  ];
  const projects = [
    { id: "7", name: "Linked Project", status: "active" },
    { id: "8", name: "Recommended Project", status: "active" }
  ];
  const projectPapers = [{ paper_id: "101", project_id: "7", relation: "reading", note: "", updated_at: T0 }];
  const recommendations = [
    {
      paper_id: "101",
      project_id: "8",
      state: "pending",
      importance: "high",
      relation_type: "direct",
      reason: "Useful",
      obsidian_path: "",
      attachment_path: "",
      source_judgment_hash: "",
      synced_at: null,
      updated_at: T0,
      relevance_score: "0.9",
      usefulness_score: "0.8",
      confidence: "0.7"
    }
  ];
  const calls = [];

  function legacyIdForArtifact(artifact) {
    return Number(JSON.parse(artifact.content_json).legacy_arxiv_paper_id || JSON.parse(artifact.source_json).legacy_arxiv_paper_id || 0);
  }

  function reportRows() {
    return artifacts.filter((artifact) => artifact.scope_type === "paper" && artifact.artifact_type === "paper_report" && artifact.status !== "removed");
  }

  async function runQuery(sql, params = []) {
    calls.push({ sql, params });
    const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
      txCalls.push(normalized);
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT KEY, VALUE_JSON FROM APP_SETTINGS")) {
      return { rows: [{ key: "paper_reader_default_prompt", value_json: "\"Stored prompt\"" }] };
    }
    if (normalized.startsWith("SELECT STATUS, COUNT(*) AS COUNT, MAX(UPDATED_AT)")) {
      const grouped = new Map();
      for (const artifact of reportRows()) {
        const current = grouped.get(artifact.status) || { status: artifact.status, count: 0, latest_updated_at: artifact.updated_at };
        current.count += 1;
        if (artifact.updated_at > current.latest_updated_at) current.latest_updated_at = artifact.updated_at;
        grouped.set(artifact.status, current);
      }
      return { rows: [...grouped.values()].map((row) => ({ ...row, count: String(row.count) })) };
    }
    if (normalized.startsWith("SELECT A.ID, A.SCOPE_ID")) {
      return {
        rows: reportRows().map((artifact) => ({
          ...artifact,
          legacy_arxiv_paper_id: String(legacyIdForArtifact(artifact))
        }))
      };
    }
    if (normalized.startsWith("WITH REPORT_ROWS AS")) {
      return {
        rows: reportRows().map((artifact) => {
          const paper = arxivPapers.find((item) => Number(item.id) === legacyIdForArtifact(artifact));
          return {
            ...artifact,
            artifact_title: artifact.title,
            report_excerpt: artifact.content_markdown.slice(0, 500),
            legacy_arxiv_paper_id: paper.id,
            arxiv_paper_id: paper.id,
            arxiv_id: paper.arxiv_id,
            title: paper.title,
            authors_json: paper.authors_json,
            categories_json: paper.categories_json,
            published_at: paper.published_at,
            link: paper.link,
            text_status: paper.text_status
          };
        })
      };
    }
    if (normalized.startsWith("SELECT PP.PAPER_ID, PP.PROJECT_ID")) {
      return {
        rows: projectPapers.map((link) => ({
          ...link,
          project_name: projects.find((project) => project.id === link.project_id)?.name || ""
        }))
      };
    }
    if (normalized.startsWith("SELECT R.PAPER_ID, R.PROJECT_ID")) {
      return {
        rows: recommendations.map((link) => ({
          paper_id: link.paper_id,
          project_id: link.project_id,
          project_name: projects.find((project) => project.id === link.project_id)?.name || ""
        }))
      };
    }
    if (normalized.startsWith("SELECT ID, NAME FROM RESEARCH_PROJECTS")) {
      return {
        rows: projects
          .filter((project) => params[0].map(Number).includes(Number(project.id)))
          .map(({ id, name }) => ({ id, name }))
      };
    }
    if (normalized.startsWith("SELECT * FROM ARXIV_PAPERS WHERE ID = $1")) {
      return { rows: arxivPapers.filter((paper) => Number(paper.id) === Number(params[0])) };
    }
    if (normalized.startsWith("SELECT ID FROM PAPERS WHERE")) {
      return { rows: papers.filter((paper) => paper.arxiv_id === params[0] || paper.canonical_key === params[1]) };
    }
    if (normalized.startsWith("SELECT P.ID FROM PAPERS P JOIN PAPER_SOURCES")) {
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT * FROM ARTIFACTS")) {
      return { rows: artifacts.filter((artifact) => Number(artifact.scope_id) === Number(params[0]) && artifact.artifact_type === params[1]) };
    }
    if (normalized.startsWith("SELECT M.CHUNK_ID")) return { rows: [] };
    if (normalized.startsWith("SELECT J.PROJECT_ID")) return { rows: [] };
    if (normalized.startsWith("SELECT R.PROJECT_ID")) {
      return {
        rows: recommendations.map((row) => ({
          ...row,
          project_name: projects.find((project) => project.id === row.project_id)?.name || "",
          obsidian_project_path: "",
          obsidian_folder: ""
        }))
      };
    }
    if (normalized.startsWith("SELECT PP.PROJECT_ID")) {
      return {
        rows: projectPapers.map((row) => ({
          ...row,
          project_name: projects.find((project) => project.id === row.project_id)?.name || "",
          obsidian_project_path: "",
          obsidian_folder: ""
        }))
      };
    }
    if (normalized.startsWith("SELECT STATUS, NOTE, UPDATED_AT FROM USER_FEEDBACK")) return { rows: [] };
    if (normalized.startsWith("SELECT ID, PAPER_ID, ROLE")) {
      return { rows: messages.filter((message) => Number(message.paper_id) === Number(params[0])) };
    }
    if (normalized.startsWith("DELETE FROM PAPER_READER_MESSAGES")) {
      const before = messages.length;
      const index = messages.findIndex((message) => Number(message.id) === Number(params[0]) && Number(message.paper_id) === Number(params[1]));
      if (index >= 0) messages.splice(index, 1);
      return { rows: [], rowCount: before - messages.length };
    }
    if (normalized.startsWith("UPDATE ARTIFACTS SET STATUS = 'CANCELLED'")) {
      const artifact = artifacts.find((item) => Number(item.id) === Number(params[2]));
      artifact.status = "cancelled";
      artifact.content_json = params[0];
      artifact.updated_at = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE ARTIFACTS SET STATUS = 'REMOVED'")) {
      const artifact = artifacts.find((item) => Number(item.id) === Number(params[2]));
      artifact.status = "removed";
      artifact.content_json = params[0];
      artifact.updated_at = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE ARTIFACTS SET TITLE =")) {
      const artifact = artifacts.find((item) => Number(item.id) === Number(params[5]));
      artifact.title = params[0];
      artifact.content_markdown = "";
      artifact.content_json = params[1];
      artifact.status = "queued";
      artifact.source_json = params[2];
      artifact.model_provider_id = "";
      artifact.model = "";
      artifact.input_hash = params[3];
      artifact.updated_at = params[4];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT R.PROJECT_ID FROM PROJECT_PAPER_RECOMMENDATIONS")) {
      return { rows: recommendations.map((row) => ({ project_id: row.project_id })) };
    }
    throw new Error(`Unexpected SQL in reader test: ${sql}`);
  }

  return {
    artifacts,
    calls,
    messages,
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

test("getReaderPapers returns reader list fields and stats without full report markdown", async () => {
  const fake = createReaderFake();
  const data = await getReaderPapers({ limit: "25" }, fake.pool);
  assert.equal(data.stats.total, 1);
  assert.equal(data.stats.queued, 1);
  assert.equal(data.items[0].paper_id, 101);
  assert.equal(data.items[0].artifact_id, 301);
  assert.deepEqual(data.items[0].authors, ["Ada", "Ben"]);
  assert.deepEqual(data.items[0].linked_project_names, ["Linked Project"]);
  assert.deepEqual(data.items[0].recommendation_project_names, ["Recommended Project"]);
  assert.equal(data.items[0].report_markdown, undefined);
  assert.equal(data.items[0].report_excerpt, "Report markdown");
});

test("getReaderPaperDetail prepends synthetic report messages before persisted chat", async () => {
  const fake = createReaderFake();
  const detail = await getReaderPaperDetail(101, fake.pool);
  assert.equal(detail.paper.id, 101);
  assert.equal(detail.paper_report.status, "queued");
  assert.equal(detail.linked_projects[0].project_name, "Linked Project");
  assert.equal(detail.project_recommendations[0].project_name, "Recommended Project");
  assert.equal(detail.reader_messages.length, 3);
  assert.equal(detail.reader_messages[0].source, "analysis_prompt");
  assert.equal(detail.reader_messages[1].source, "analysis_report");
  assert.equal(detail.reader_messages[2].content, "Question");
});

test("deleteReaderMessage removes persisted chat and returns updated detail", async () => {
  const fake = createReaderFake();
  setPoolForTesting(fake.pool);
  try {
    const detail = await deleteReaderMessage(101, 401);
    assert.equal(detail.ok, true);
    assert.equal(fake.messages.length, 0);
    assert.equal(detail.reader_messages.length, 2);
    assert.deepEqual(fake.txCalls.slice(0, 2), ["BEGIN", "COMMIT"]);
  } finally {
    setPoolForTesting(null);
  }
});

test("cancelReaderReport changes queued report to cancelled and returns detail", async () => {
  const fake = createReaderFake();
  setPoolForTesting(fake.pool);
  try {
    const detail = await cancelReaderReport(101);
    assert.equal(detail.ok, true);
    assert.equal(fake.artifacts[0].status, "cancelled");
    assert.equal(detail.paper_report.status, "cancelled");
  } finally {
    setPoolForTesting(null);
  }
});

test("retryReaderReport requeues existing report with stored prompt and clears markdown", async () => {
  const fake = createReaderFake();
  fake.artifacts[0].status = "failed";
  fake.artifacts[0].content_json = JSON.stringify({ ...JSON.parse(fake.artifacts[0].content_json), error_message: "LLM failed" });
  setPoolForTesting(fake.pool);
  try {
    const detail = await retryReaderReport(101);
    assert.equal(detail.ok, true);
    assert.equal(fake.artifacts[0].status, "queued");
    assert.equal(fake.artifacts[0].content_markdown, "");
    assert.equal(JSON.parse(fake.artifacts[0].content_json).prompt, "Stored prompt");
    assert.equal(JSON.parse(fake.artifacts[0].content_json).error_message, "");
  } finally {
    setPoolForTesting(null);
  }
});

test("deleteReaderReport marks non-processing report removed", async () => {
  const fake = createReaderFake();
  setPoolForTesting(fake.pool);
  try {
    const result = await deleteReaderReport(101);
    assert.equal(result.ok, true);
    assert.equal(result.paper_reports_removed, 1);
    assert.equal(result.artifact_id, 301);
    assert.equal(fake.artifacts[0].status, "removed");
  } finally {
    setPoolForTesting(null);
  }
});
