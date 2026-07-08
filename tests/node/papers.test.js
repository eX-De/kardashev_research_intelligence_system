import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting } from "../../server/db.js";
import { DEFAULT_PAPER_READER_PROMPT } from "../../server/settings.js";
import {
  ensurePaperReportsForRecommendations,
  savePaperFeedback,
  syncProjectPaperRecommendations,
  updatePaperRecommendation
} from "../../server/papers.js";

const T0 = "2026-07-07T00:00:00Z";

function createPapersFake() {
  const txCalls = [];
  const arxivPapers = [
    {
      id: "101",
      arxiv_id: "2607.00001",
      title: "Migrated Paper",
      authors_json: "[\"Ada\", \"Ben\"]",
      summary: "Paper abstract",
      categories_json: "[\"cs.AI\"]",
      published_at: "2026-07-01T00:00:00Z",
      updated_at: T0,
      link: "https://arxiv.org/abs/2607.00001",
      pdf_link: "https://arxiv.org/pdf/2607.00001",
      pdf_path: "data/paper.pdf",
      text_path: "data/paper.txt",
      text_status: "complete",
      text_error: "",
      text_char_count: "1234",
      fetched_batch_id: "batch-1"
    }
  ];
  const papers = [];
  const sources = [];
  const assets = [];
  const feedback = [];
  const artifacts = [];
  const judgments = [
    {
      project_id: "7",
      paper_id: "101",
      relation_type: "direct",
      reason: "Updated accepted reason",
      input_hash: "hash-accepted",
      suggested_action: "read",
      confidence: "0.91",
      usefulness_score: "0.88"
    },
    {
      project_id: "8",
      paper_id: "101",
      relation_type: "indirect",
      reason: "New reason",
      input_hash: "hash-new",
      suggested_action: "read",
      confidence: "0.75",
      usefulness_score: "0.7"
    }
  ];
  const recommendations = [
    {
      project_id: "7",
      paper_id: "101",
      state: "accepted",
      importance: "high",
      relation_type: "direct",
      reason: "Old reason",
      source_judgment_hash: "old-hash",
      created_at: T0,
      updated_at: T0
    }
  ];
  const projectPapers = [];
  const calls = [];

  function nextId(items, offset) {
    return String(offset + items.length + 1);
  }

  function longTermPaperByArxiv(arxivId, canonicalKey = "") {
    return papers.find((paper) => paper.arxiv_id === arxivId || paper.canonical_key === canonicalKey);
  }

  async function runQuery(sql, params = []) {
    calls.push({ sql, params });
    const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
      txCalls.push(normalized);
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT * FROM ARXIV_PAPERS WHERE ID = $1")) {
      return { rows: arxivPapers.filter((paper) => Number(paper.id) === Number(params[0])) };
    }
    if (normalized.startsWith("INSERT INTO USER_FEEDBACK")) {
      const existing = feedback.find((row) => Number(row.paper_id) === Number(params[0]) && row.status === params[1]);
      if (existing) {
        existing.note = params[2];
        existing.updated_at = params[3];
      } else {
        feedback.push({
          id: nextId(feedback, 500),
          paper_id: String(params[0]),
          status: params[1],
          note: params[2],
          created_at: params[3],
          updated_at: params[3]
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith("SELECT ID FROM PAPERS WHERE ARXIV_ID = $1 OR CANONICAL_KEY = $2")
      || normalized.startsWith("SELECT ID FROM PAPERS WHERE ($1 != '' AND ARXIV_ID = $1)")
    ) {
      const paper = longTermPaperByArxiv(params[0], params[1]);
      return { rows: paper ? [{ id: paper.id }] : [] };
    }
    if (normalized.startsWith("SELECT P.ID FROM PAPERS P JOIN PAPER_SOURCES")) {
      const source = sources.find((row) => row.source_type === "arxiv" && row.source_identifier === params[0]);
      return { rows: source ? [{ id: source.paper_id }] : [] };
    }
    if (normalized.startsWith("INSERT INTO PAPERS(")) {
      let paper = papers.find((row) => row.canonical_key === params[0]);
      if (!paper) {
        paper = {
          id: nextId(papers, 200),
          canonical_key: params[0],
          title: params[1],
          authors_json: params[2],
          abstract: params[3],
          published_at: params[4],
          year: params[5],
          arxiv_id: params[6],
          library_status: "candidate",
          reading_state: "unread",
          saved_at: null,
          last_read_at: null,
          created_at: params[7],
          updated_at: params[7]
        };
        papers.push(paper);
      } else {
        paper.title = params[1];
        paper.authors_json = params[2];
        paper.abstract = params[3];
        paper.published_at = params[4];
        paper.year = params[5] ?? paper.year;
        paper.arxiv_id = params[6];
        paper.updated_at = params[7];
      }
      return { rows: [{ id: paper.id }] };
    }
    if (normalized.startsWith("INSERT INTO PAPER_SOURCES(")) {
      let source = sources.find((row) => row.paper_id === String(params[0]) && row.source_type === params[1] && row.source_identifier === params[2]);
      if (!source) {
        source = {
          id: nextId(sources, 300),
          paper_id: String(params[0]),
          source_type: params[1],
          source_identifier: params[2],
          source_url: params[3],
          metadata_json: params[4],
          fetched_batch_id: params[5],
          created_at: params[6],
          updated_at: params[6]
        };
        sources.push(source);
      } else {
        source.source_url = params[3];
        source.metadata_json = params[4];
        source.fetched_batch_id = params[5];
        source.updated_at = params[6];
      }
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT ID FROM PAPER_ASSETS")) {
      const asset = assets.find((row) => row.paper_id === String(params[0]) && row.asset_type === params[1]);
      return { rows: asset ? [{ id: asset.id }] : [] };
    }
    if (normalized.startsWith("INSERT INTO PAPER_ASSETS(")) {
      const asset = {
        id: nextId(assets, 400),
        paper_id: String(params[0]),
        asset_type: params[1],
        path: params[2],
        url: params[3],
        status: params[4],
        error_message: params[5],
        metadata_json: params[6],
        created_at: params[7],
        updated_at: params[7]
      };
      assets.push(asset);
      return { rows: [{ id: asset.id }] };
    }
    if (normalized.startsWith("SELECT READING_STATE, SAVED_AT, LAST_READ_AT FROM PAPERS WHERE ID = $1")) {
      const paper = papers.find((row) => Number(row.id) === Number(params[0]));
      return { rows: paper ? [{ reading_state: paper.reading_state, saved_at: paper.saved_at, last_read_at: paper.last_read_at }] : [] };
    }
    if (normalized.startsWith("UPDATE PAPERS SET LIBRARY_STATUS = $1")) {
      const paper = papers.find((row) => Number(row.id) === Number(params[5]));
      paper.library_status = params[0];
      paper.reading_state = params[1];
      paper.saved_at = params[2];
      paper.last_read_at = params[3];
      paper.updated_at = params[4];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT J.PROJECT_ID, J.PAPER_ID")) {
      const selectedIds = Array.isArray(params[3]) ? params[3].map(Number) : null;
      return {
        rows: judgments
          .filter((row) => !selectedIds || selectedIds.includes(Number(row.paper_id)))
          .map((row) => ({
            ...row,
            existing_state: recommendations.find((rec) => rec.project_id === row.project_id && rec.paper_id === row.paper_id)?.state || ""
          }))
      };
    }
    if (normalized.startsWith("INSERT INTO PROJECT_PAPER_RECOMMENDATIONS")) {
      let rec = recommendations.find((row) => Number(row.project_id) === Number(params[0]) && Number(row.paper_id) === Number(params[1]));
      if (!rec) {
        rec = {
          project_id: String(params[0]),
          paper_id: String(params[1]),
          state: "pending",
          importance: "",
          created_at: params[5]
        };
        recommendations.push(rec);
      }
      rec.relation_type = params[2];
      rec.reason = params[3];
      rec.source_judgment_hash = params[4];
      rec.updated_at = params[5];
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT PROJECT_ID FROM PROJECT_PAPER_RECOMMENDATIONS")) {
      const selectedIds = Array.isArray(params[1]) ? params[1].map(Number) : null;
      return {
        rows: recommendations
          .filter((row) => Number(row.paper_id) === Number(params[0]))
          .filter((row) => row.state !== "discarded")
          .filter((row) => !selectedIds || selectedIds.includes(Number(row.project_id)))
          .map((row) => ({ project_id: row.project_id }))
      };
    }
    if (normalized.startsWith("UPDATE PROJECT_PAPER_RECOMMENDATIONS SET STATE = 'ACCEPTED'")) {
      const selectedIds = Array.isArray(params[3]) ? params[3].map(Number) : [];
      for (const row of recommendations) {
        if (Number(row.paper_id) === Number(params[2]) && selectedIds.includes(Number(row.project_id))) {
          row.state = "accepted";
          row.importance = params[0];
          row.updated_at = params[1];
        }
      }
      return { rows: [], rowCount: selectedIds.length };
    }
    if (normalized.startsWith("UPDATE PROJECT_PAPER_RECOMMENDATIONS SET STATE = 'DISCARDED'")) {
      const paperId = Number(params[1]);
      const selectedIds = Array.isArray(params[2]) ? params[2].map(Number) : null;
      let count = 0;
      for (const row of recommendations) {
        if (Number(row.paper_id) !== paperId || row.state !== "pending") continue;
        const selected = selectedIds ? selectedIds.includes(Number(row.project_id)) : true;
        const shouldDiscard = normalized.includes("NOT (PROJECT_ID = ANY") ? !selected : selected;
        if (!shouldDiscard) continue;
        row.state = "discarded";
        row.updated_at = params[0];
        count += 1;
      }
      return { rows: [], rowCount: count };
    }
    if (normalized.startsWith("INSERT INTO PROJECT_PAPERS")) {
      projectPapers.push({
        project_id: String(params[0]),
        paper_id: String(params[1]),
        relation: "reading",
        note: "accepted_from_recommendation",
        created_at: params[2],
        updated_at: params[2]
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("SELECT R.PAPER_ID, R.PROJECT_ID FROM PROJECT_PAPER_RECOMMENDATIONS R")) {
      const selectedIds = Array.isArray(params[0]) ? params[0].map(Number) : null;
      return {
        rows: recommendations
          .filter((row) => ["pending", "accepted"].includes(row.state))
          .filter((row) => !selectedIds || selectedIds.includes(Number(row.paper_id)))
          .map((row) => ({ paper_id: row.paper_id, project_id: row.project_id }))
      };
    }
    if (normalized.startsWith("SELECT * FROM ARTIFACTS")) {
      return {
        rows: artifacts.filter((artifact) => Number(artifact.scope_id) === Number(params[0]) && artifact.artifact_type === params[1])
      };
    }
    if (normalized.startsWith("INSERT INTO ARTIFACTS(")) {
      const artifact = {
        id: nextId(artifacts, 600),
        scope_type: "paper",
        scope_id: String(params[0]),
        artifact_type: params[1],
        title: params[2],
        content_markdown: params[3],
        content_json: params[4],
        status: params[5],
        source_json: params[6],
        model_provider_id: params[7],
        model: params[8],
        input_hash: params[9],
        created_at: params[10],
        updated_at: params[10]
      };
      artifacts.push(artifact);
      return { rows: [{ id: artifact.id }] };
    }
    throw new Error(`Unexpected SQL in papers test: ${sql}`);
  }

  return {
    arxivPapers,
    papers,
    sources,
    assets,
    feedback,
    artifacts,
    judgments,
    recommendations,
    projectPapers,
    calls,
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

test("savePaperFeedback mirrors legacy arXiv paper and updates library status", async () => {
  const fake = createPapersFake();
  setPoolForTesting(fake.pool);
  try {
    const result = await savePaperFeedback(101, "read_later", "Keep this");
    assert.equal(result.ok, true);
    assert.equal(result.paper_id, 101);
    assert.equal(result.status, "read_later");
    assert.equal(fake.feedback.length, 1);
    assert.equal(fake.feedback[0].note, "Keep this");
    assert.equal(fake.papers.length, 1);
    assert.equal(fake.papers[0].canonical_key, "arxiv:2607.00001");
    assert.equal(fake.papers[0].library_status, "saved");
    assert.equal(fake.sources[0].source_type, "arxiv");
    assert.equal(fake.assets.length, 2);
    assert.deepEqual(fake.txCalls.slice(0, 2), ["BEGIN", "COMMIT"]);
  } finally {
    setPoolForTesting(null);
  }
});

test("syncProjectPaperRecommendations preserves accepted state while refreshing fields", async () => {
  const fake = createPapersFake();
  setPoolForTesting(fake.pool);
  try {
    const result = await syncProjectPaperRecommendations([101]);
    assert.equal(result.paper_recommendation_candidates, 2);
    assert.equal(result.paper_recommendations_created, 1);
    assert.equal(result.paper_recommendations_preserved, 1);
    const accepted = fake.recommendations.find((row) => row.project_id === "7");
    const created = fake.recommendations.find((row) => row.project_id === "8");
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.reason, "Updated accepted reason");
    assert.equal(created.state, "pending");
    assert.equal(created.reason, "New reason");
  } finally {
    setPoolForTesting(null);
  }
});

test("ensurePaperReportsForRecommendations creates queued report artifacts", async () => {
  const fake = createPapersFake();
  fake.recommendations.splice(0, fake.recommendations.length, fake.recommendations[0]);
  fake.recommendations[0].state = "pending";
  setPoolForTesting(fake.pool);
  try {
    const result = await ensurePaperReportsForRecommendations([101]);
    assert.equal(result.paper_reports_candidates, 1);
    assert.equal(result.paper_reports_queued, 1);
    assert.equal(fake.artifacts.length, 1);
    const artifact = fake.artifacts[0];
    assert.equal(artifact.status, "queued");
    assert.equal(artifact.artifact_type, "paper_report");
    const content = JSON.parse(artifact.content_json);
    assert.equal(content.legacy_arxiv_paper_id, 101);
    assert.deepEqual(content.source_project_ids, [7]);
    assert.equal(content.prompt, DEFAULT_PAPER_READER_PROMPT);
    const source = JSON.parse(artifact.source_json);
    assert.equal(source.source_key, "paper_report:101");
  } finally {
    setPoolForTesting(null);
  }
});

test("updatePaperRecommendation discards pending recommendations and updates library status in Node", async () => {
  const fake = createPapersFake();
  setPoolForTesting(fake.pool);
  try {
    const result = await updatePaperRecommendation(101, { action: "discard" });
    assert.equal(result.ok, true);
    assert.equal(result.action, "discard");
    assert.equal(fake.papers[0].library_status, "discarded");
    assert.equal(fake.recommendations.find((row) => row.project_id === "8").state, "discarded");
    assert.equal(fake.txCalls.includes("BEGIN"), true);
  } finally {
    setPoolForTesting(null);
  }
});
