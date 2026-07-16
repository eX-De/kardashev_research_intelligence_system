import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, ValidationError } from "../../server/db.js";
import {
  getProjectDetail,
  getProjects,
  linkProjectPaper,
  saveProject,
  unlinkProjectPaper
} from "../../server/projects.js";

function createProjectsPool() {
  const txCalls = [];
  const projects = [{
    id: 1,
    name: "Existing",
    status: "active",
    summary: "",
    goals: "",
    keywords_json: "[\"rag\"]",
    obsidian_project_path: "",
    obsidian_output_dir: "",
    obsidian_note_id: null,
    obsidian_folder: "",
    obsidian_status_tag: "Status/进行中",
    discovery_source: "manual",
    source_tags_json: "[]",
    arxiv_categories_json: "[]",
    automation_json: "{}",
    created_at: "2026-07-06T00:00:00Z",
    updated_at: "2026-07-06T00:00:00Z"
  }];
  const projectPapers = [{
    project_id: 1,
    paper_id: 11,
    relation: "candidate",
    note: "auto_matched_by_project_context",
    updated_at: "2026-07-06T00:00:00Z"
  }];
  const projectNotes = [];
  const artifacts = [];
  const arxivPapers = [{
    id: 12,
    arxiv_id: "2607.00012",
    title: "Queued Worker Paper",
    authors_json: "[\"A\"]",
    summary: "Abstract",
    categories_json: "[\"cs.AI\"]",
    published_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    link: "https://arxiv.org/abs/2607.00012",
    pdf_link: "https://arxiv.org/pdf/2607.00012",
    fetched_batch_id: "batch-1"
  }];
  const libraryPapers = [];
  const paperSources = [];

  function projectListRows() {
    return projects.map((project) => ({
      ...project,
      paper_count: String(projectPapers.filter((item) => (
        item.project_id === project.id
        && !(item.relation === "candidate" && item.note === "auto_matched_by_project_context")
      )).length),
      note_count: String(projectNotes.filter((item) => item.project_id === project.id).length),
      artifact_count: String(artifacts.filter((item) => item.scope_type === "project" && item.scope_id === project.id).length),
      latest_artifact_at: ""
    }));
  }

  function detailRows(projectId) {
    return projectListRows().filter((project) => Number(project.id) === Number(projectId));
  }

  function linkedPaperRows(projectId) {
    return projectPapers
      .filter((item) => (
        Number(item.project_id) === Number(projectId)
        && !(item.relation === "candidate" && item.note === "auto_matched_by_project_context")
      ))
      .map((item) => {
        const paper = arxivPapers.find((row) => row.id === item.paper_id) || {};
        return {
          id: paper.id,
          arxiv_id: paper.arxiv_id,
          title: paper.title,
          link: paper.link,
          relation: item.relation,
          note: item.note,
          updated_at: item.updated_at,
          project_score: "0"
        };
      });
  }

  async function runQuery(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
      txCalls.push(normalized);
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT P.*") && normalized.includes("FROM RESEARCH_PROJECTS P") && !normalized.includes("WHERE P.ID")) {
      return { rows: projectListRows() };
    }
    if (normalized.startsWith("SELECT P.*") && normalized.includes("WHERE P.ID = $1")) {
      return { rows: detailRows(params[0]) };
    }
    if (normalized.startsWith("SELECT P.ID, P.ARXIV_ID")) {
      return { rows: linkedPaperRows(params[0]) };
    }
    if (normalized.startsWith("SELECT N.ID, N.PATH, N.TITLE, PN.RELATION")) {
      return { rows: [] };
    }
    if (normalized.includes("FROM PROJECT_PAPER_RECOMMENDATIONS R")) {
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT N.ID, N.PATH, N.TITLE, N.TAGS_JSON")) {
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT ID, ARTIFACT_TYPE")) {
      return { rows: [] };
    }
    if (normalized.includes("FROM PROJECT_PAPER_MATCHES PPM")) {
      return { rows: [] };
    }
    if (normalized.includes("FROM PROJECT_CONTEXT_DOCUMENTS PCD")) {
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO RESEARCH_PROJECTS")) {
      const now = params[13];
      const row = {
        id: projects.length + 1,
        name: params[0],
        status: params[1],
        summary: params[2],
        goals: params[3],
        keywords_json: params[4],
        obsidian_project_path: params[5],
        obsidian_output_dir: params[6],
        obsidian_note_id: null,
        obsidian_folder: params[7],
        obsidian_status_tag: params[8],
        discovery_source: params[9],
        source_tags_json: params[10],
        arxiv_categories_json: params[11],
        automation_json: params[12],
        created_at: now,
        updated_at: now
      };
      projects.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (normalized.startsWith("SELECT OBSIDIAN_PROJECT_PATH")) {
      return { rows: detailRows(params[0]) };
    }
    if (normalized.startsWith("INSERT INTO PROJECT_PAPERS")) {
      const existing = projectPapers.find((item) => item.project_id === Number(params[0]) && item.paper_id === Number(params[1]));
      if (existing) {
        existing.relation = params[2];
        existing.note = params[3];
        existing.updated_at = params[4];
      } else {
        projectPapers.push({
          project_id: Number(params[0]),
          paper_id: Number(params[1]),
          relation: params[2],
          note: params[3],
          updated_at: params[4]
        });
      }
      return { rows: [] };
    }
    if (normalized.startsWith("DELETE FROM PROJECT_PAPERS")) {
      const index = projectPapers.findIndex((item) => (
        Number(item.project_id) === Number(params[0]) && Number(item.paper_id) === Number(params[1])
      ));
      if (index >= 0) projectPapers.splice(index, 1);
      return { rows: [], rowCount: index >= 0 ? 1 : 0 };
    }
    if (normalized.startsWith("SELECT * FROM ARXIV_PAPERS")) {
      return { rows: arxivPapers.filter((paper) => Number(paper.id) === Number(params[0])) };
    }
    if (normalized.startsWith("SELECT ID FROM PAPERS")) {
      return { rows: libraryPapers.filter((paper) => paper.arxiv_id === params[0] || paper.canonical_key === params[1]) };
    }
    if (normalized.startsWith("SELECT P.ID FROM PAPERS P JOIN PAPER_SOURCES")) {
      const source = paperSources.find((item) => item.source_identifier === params[0]);
      return { rows: source ? [{ id: source.paper_id }] : [] };
    }
    if (normalized.startsWith("INSERT INTO PAPERS")) {
      const row = {
        id: libraryPapers.length + 100,
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
        last_read_at: null
      };
      libraryPapers.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (normalized.startsWith("INSERT INTO PAPER_SOURCES")) {
      paperSources.push({ paper_id: params[0], source_identifier: params[2] });
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT SAVED_AT")) {
      return { rows: libraryPapers.filter((paper) => Number(paper.id) === Number(params[0])) };
    }
    if (normalized.startsWith("UPDATE PAPERS SET LIBRARY_STATUS")) {
      const paper = libraryPapers.find((item) => Number(item.id) === Number(params[5]));
      Object.assign(paper, {
        library_status: params[0],
        reading_state: params[1],
        saved_at: params[2],
        last_read_at: params[3]
      });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in projects test: ${sql}`);
  }

  return {
    txCalls,
    projects,
    projectPapers,
    libraryPapers,
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

test("getProjects and getProjectDetail preserve v1 project payload shape", async () => {
  const fake = createProjectsPool();
  setPoolForTesting(fake.pool);
  try {
    const list = await getProjects();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].paper_count, 0);
    assert.deepEqual(list.items[0].keywords, ["rag"]);

    const detail = await getProjectDetail(1);
    assert.ok(detail.project);
    assert.deepEqual(Object.keys(detail).sort(), [
      "artifacts",
      "candidate_notes",
      "candidate_papers",
      "context_documents",
      "notes",
      "papers",
      "project",
      "recommended_papers",
      "retrieval_hits"
    ].sort());
    assert.equal(detail.papers.length, 0);
  } finally {
    setPoolForTesting(null);
  }
});

test("saveProject creates a project and returns project detail", async () => {
  const fake = createProjectsPool();
  setPoolForTesting(fake.pool);
  try {
    const detail = await saveProject({
      name: "New Project",
      status: "exploring",
      keywords: "agent, rag",
      automation: { generate_project_digest: false }
    });
    assert.equal(detail.project.name, "New Project");
    assert.deepEqual(detail.project.keywords, ["agent", "rag"]);
    assert.equal(detail.project.automation.generate_project_digest, false);
    assert.deepEqual(fake.txCalls.slice(0, 2), ["BEGIN", "COMMIT"]);
  } finally {
    setPoolForTesting(null);
  }
});

test("linkProjectPaper upserts visible link and mirrors library status", async () => {
  const fake = createProjectsPool();
  setPoolForTesting(fake.pool);
  try {
    const detail = await linkProjectPaper(1, { paper_id: 12, relation: "core", note: "important" });
    assert.equal(detail.papers.length, 1);
    assert.equal(detail.papers[0].relation, "core");
    assert.equal(fake.libraryPapers[0].library_status, "saved");
    assert.ok(fake.libraryPapers[0].saved_at);
  } finally {
    setPoolForTesting(null);
  }
});

test("linkProjectPaper rejects invalid relation", async () => {
  const fake = createProjectsPool();
  setPoolForTesting(fake.pool);
  try {
    await assert.rejects(
      () => linkProjectPaper(1, { paper_id: 12, relation: "bad" }),
      ValidationError
    );
  } finally {
    setPoolForTesting(null);
  }
});

test("unlinkProjectPaper removes an existing paper association", async () => {
  const fake = createProjectsPool();
  fake.projectPapers[0].note = "manual";
  fake.projectPapers[0].relation = "reading";
  setPoolForTesting(fake.pool);
  try {
    const detail = await unlinkProjectPaper(1, 11);
    assert.equal(detail.papers.length, 0);
    assert.equal(fake.projectPapers.length, 0);
    assert.deepEqual(fake.txCalls.slice(0, 2), ["BEGIN", "COMMIT"]);
  } finally {
    setPoolForTesting(null);
  }
});
