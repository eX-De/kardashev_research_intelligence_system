import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSearchRequest, quickSearch } from "../../server/search.js";

test("normalizeSearchRequest applies explicit modes, filters, and bounds", () => {
  const request = normalizeSearchRequest({
    query: "retrieval",
    mode: "deep",
    types: ["paper", "invalid"],
    artifact_types: ["daily_report"],
    project_id: "7",
    limit: 999
  });
  assert.equal(request.mode, "deep");
  assert.deepEqual(request.types, ["paper"]);
  assert.equal(request.filters.project_id, 7);
  assert.deepEqual(request.filters.artifact_types, ["daily_report"]);
  assert.equal(request.limit, 100);
  assert.throws(() => normalizeSearchRequest({ query: "", mode: "quick" }), /query is required/);
});

test("quickSearch merges paper, artifact, and project SQL results without model work", async () => {
  const statements = [];
  const db = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("FROM paper_reader_messages")) return { rows: [] };
      if (sql.includes("FROM paper_chunks")) return { rows: [] };
      if (sql.includes("FROM papers p")) return { rows: [{ entity_type: "paper", entity_id: 1, title: "Paper", snippet: "body", source_type: "library_paper", identity_namespace: "library", project_id: null, updated_at: "2026-01-01", href: "/papers/library/1", match_rank: 1, match_kind: "title" }] };
      if (sql.includes("FROM knowledge_documents")) return { rows: [] };
      if (sql.includes("FROM research_projects")) return { rows: [{ entity_type: "project", entity_id: 3, title: "Project", snippet: "body", source_type: "project", project_id: 3, updated_at: "2026-01-03", href: "/projects/3", match_rank: 3, match_kind: "keyword" }] };
      if (sql.includes("FROM artifacts")) return { rows: [{ entity_type: "artifact", entity_id: 2, title: "Daily", snippet: "body", source_type: "daily_report", project_id: null, updated_at: "2026-01-02", href: "/artifacts/2", match_rank: 2, match_kind: "title" }] };
      throw new Error("unexpected SQL");
    }
  };
  const result = await quickSearch({ q: "retrieval", types: "paper,artifact,project" }, db);
  assert.equal(result.mode, "quick");
  assert.deepEqual(result.results.map((item) => item.entity_type), ["paper", "artifact", "project"]);
  assert.equal(result.stats.query_embedding_model, "");
  assert.equal(statements.some((sql) => sql.includes("arxiv_papers") || sql.includes("arxiv_text_chunks")), false);
  assert.equal(statements.filter((sql) => sql.includes("FROM papers p")).every((sql) => sql.includes("library_status NOT IN")), true);
});

test("quickSearch covers local paper metadata/fulltext and non-Obsidian project context", async () => {
  const statements = [];
  const db = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("FROM paper_reader_messages")) return { rows: [] };
      if (sql.includes("FROM paper_chunks")) return { rows: [{ entity_type: "paper", entity_id: 9, title: "Local paper", snippet: "human memory evidence", source_type: "library_paper_chunk", identity_namespace: "library", project_id: null, updated_at: "2026-01-05", href: "/papers/library/9", match_rank: 4, match_kind: "keyword" }] };
      if (sql.includes("FROM papers p")) return { rows: [{ entity_type: "paper", entity_id: 9, title: "Local paper", snippet: "human memory", source_type: "library_paper", identity_namespace: "library", project_id: null, updated_at: "2026-01-04", href: "/papers/library/9", match_rank: 3, match_kind: "keyword" }] };
      if (sql.includes("FROM research_projects")) return { rows: [] };
      if (sql.includes("FROM knowledge_documents")) return { rows: [{ entity_type: "project", entity_id: 7, title: "Memory project", snippet: "manual context", source_type: "manual_project", project_id: 7, updated_at: "2026-01-06", href: "/projects/7", match_rank: 4, match_kind: "keyword" }] };
      throw new Error("unexpected SQL");
    }
  };

  const result = await quickSearch({ q: "human memory", types: "paper,project" }, db);
  assert.deepEqual(result.results.map((item) => [item.entity_type, item.entity_id]), [["paper", 9], ["project", 7]]);
  assert.equal(result.results[0].href, "/papers/library/9");
  assert.equal(statements.some((sql) => sql.includes("arxiv_papers") || sql.includes("arxiv_text_chunks")), false);
});
