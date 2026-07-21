import { many, query, ValidationError } from "./db.js";

const VALID_TYPES = new Set(["paper", "artifact", "project"]);
const MAX_LIMIT = 100;

function searchableLibraryPaperClause(alias = "p") {
  return `${alias}.library_status NOT IN ('archived', 'discarded')`;
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizeTypes(value) {
  const raw = Array.isArray(value) ? value : text(value).split(",");
  const values = [...new Set(raw.map(text).filter((item) => VALID_TYPES.has(item)))];
  return values.length ? values : [...VALID_TYPES];
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value || 30), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ValidationError("limit must be a positive integer");
  return Math.min(parsed, MAX_LIMIT);
}

function optionalPositiveInt(value, name) {
  if (!text(value)) return null;
  const parsed = Number.parseInt(text(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ValidationError(`${name} must be a positive integer`);
  return parsed;
}

function snippet(value, limit = 360) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trim()}…`;
}

function quickScore(row) {
  const rank = Number(row.match_rank || 0);
  return Math.max(0, Math.min(1, 1 - rank * 0.12));
}

function quickResult(row) {
  return {
    _identity: `${row.identity_namespace || row.entity_type}:${row.entity_id}`,
    entity_type: row.entity_type,
    entity_id: Number(row.entity_id),
    title: row.title || "Untitled",
    snippet: snippet(row.snippet),
    score: quickScore(row),
    matched_by: [row.match_kind || "keyword"],
    source_type: row.source_type,
    project_id: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
    updated_at: row.updated_at,
    href: row.href
  };
}

async function searchLibraryPapers(searchQuery, filters, limit, db) {
  if (filters.project_id) return [];
  const values = [searchQuery, `${searchQuery}%`, `%${searchQuery}%`];
  const clauses = [
    searchableLibraryPaperClause("p"),
    `(p.title ILIKE $3 OR p.abstract ILIKE $3 OR p.authors_json ILIKE $3 OR p.venue ILIKE $3 OR
      p.user_tags_json ILIKE $3 OR p.user_note ILIKE $3)`
  ];
  if (filters.date_from) {
    values.push(filters.date_from);
    clauses.push(`LEFT(p.updated_at, 10) >= $${values.length}`);
  }
  if (filters.date_to) {
    values.push(filters.date_to);
    clauses.push(`LEFT(p.updated_at, 10) <= $${values.length}`);
  }
  values.push(limit);
  return many(await db.query(
    `SELECT 'paper' AS entity_type, p.id AS entity_id, p.title,
            CONCAT_WS(' ', p.abstract, p.authors_json, p.venue, p.user_tags_json, p.user_note) AS snippet,
            'library_paper' AS source_type, 'library' AS identity_namespace,
            NULL::integer AS project_id, p.updated_at, '/papers/library/' || p.id AS href,
            CASE WHEN LOWER(p.title) = LOWER($1) THEN 0 WHEN p.title ILIKE $2 THEN 1
                 WHEN p.title ILIKE $3 THEN 2 ELSE 3 END AS match_rank,
            CASE WHEN p.title ILIKE $3 THEN 'title' ELSE 'keyword' END AS match_kind
       FROM papers p WHERE ${clauses.join(" AND ")}
      ORDER BY match_rank, p.updated_at DESC LIMIT $${values.length}`,
    values
  ));
}

async function searchLibraryPaperFulltext(searchQuery, filters, limit, db) {
  if (filters.project_id) return [];
  const values = [`%${searchQuery}%`];
  const clauses = [
    searchableLibraryPaperClause("p"),
    "c.text ILIKE $1"
  ];
  if (filters.date_from) {
    values.push(filters.date_from);
    clauses.push(`LEFT(p.updated_at, 10) >= $${values.length}`);
  }
  if (filters.date_to) {
    values.push(filters.date_to);
    clauses.push(`LEFT(p.updated_at, 10) <= $${values.length}`);
  }
  values.push(limit);
  return many(await db.query(
    `SELECT 'paper' AS entity_type, p.id AS entity_id, p.title, c.text AS snippet,
            'library_paper_chunk' AS source_type, 'library' AS identity_namespace,
            NULL::integer AS project_id, p.updated_at, '/papers/library/' || p.id AS href,
            4 AS match_rank, 'keyword' AS match_kind
       FROM paper_chunks c JOIN papers p ON p.id = c.paper_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY p.updated_at DESC, c.chunk_index LIMIT $${values.length}`,
    values
  ));
}

async function searchLibraryPaperReaderMessages(searchQuery, filters, limit, db) {
  if (filters.project_id) return [];
  const values = [`%${searchQuery}%`];
  const clauses = [searchableLibraryPaperClause("p"), "m.content ILIKE $1"];
  if (filters.date_from) {
    values.push(filters.date_from);
    clauses.push(`LEFT(m.created_at, 10) >= $${values.length}`);
  }
  if (filters.date_to) {
    values.push(filters.date_to);
    clauses.push(`LEFT(m.created_at, 10) <= $${values.length}`);
  }
  values.push(limit);
  return many(await db.query(
    `SELECT 'paper' AS entity_type, p.id AS entity_id, p.title, m.content AS snippet,
            'paper_reader_message' AS source_type, 'library' AS identity_namespace,
            NULL::integer AS project_id, m.created_at AS updated_at,
            '/papers/library/' || p.id AS href,
            4 AS match_rank, 'keyword' AS match_kind
       FROM paper_reader_messages m
       JOIN papers p ON p.id = m.library_paper_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.created_at DESC LIMIT $${values.length}`,
    values
  ));
}

async function searchArtifacts(searchQuery, filters, limit, db) {
  const pattern = `%${searchQuery}%`;
  const values = [searchQuery, `${searchQuery}%`, pattern];
  const clauses = [
    "((a.artifact_type = 'paper_report' AND a.status = 'done') OR (a.artifact_type <> 'paper_report' AND a.status = 'ready'))",
    "a.artifact_type <> 'project_chat_profile'",
    "(a.title ILIKE $3 OR a.content_markdown ILIKE $3)"
  ];
  if (filters.project_id) {
    values.push(filters.project_id);
    clauses.push(`a.scope_type = 'project' AND a.scope_id = $${values.length}`);
  }
  if (filters.artifact_types.length) {
    values.push(filters.artifact_types);
    clauses.push(`a.artifact_type = ANY($${values.length}::text[])`);
  }
  if (filters.date_from) {
    values.push(filters.date_from);
    clauses.push(`LEFT(a.updated_at, 10) >= $${values.length}`);
  }
  if (filters.date_to) {
    values.push(filters.date_to);
    clauses.push(`LEFT(a.updated_at, 10) <= $${values.length}`);
  }
  values.push(limit);
  return many(await db.query(
    `
      SELECT
        'artifact' AS entity_type,
        a.id AS entity_id,
        a.title,
        a.content_markdown AS snippet,
        a.artifact_type AS source_type,
        CASE WHEN a.scope_type = 'project' THEN a.scope_id ELSE NULL END AS project_id,
        a.updated_at,
        '/artifacts/' || a.id AS href,
        CASE
          WHEN LOWER(a.title) = LOWER($1) THEN 0
          WHEN a.title ILIKE $2 THEN 1
          WHEN a.title ILIKE $3 THEN 2
          ELSE 4
        END AS match_rank,
        CASE WHEN a.title ILIKE $3 THEN 'title' ELSE 'keyword' END AS match_kind
      FROM artifacts a
      WHERE ${clauses.join(" AND ")}
      ORDER BY match_rank, a.updated_at DESC
      LIMIT $${values.length}
    `,
    values
  ));
}

async function searchProjects(searchQuery, filters, limit, db) {
  const pattern = `%${searchQuery}%`;
  const values = [searchQuery, `${searchQuery}%`, pattern];
  const clauses = [`(
    rp.name ILIKE $3 OR rp.summary ILIKE $3 OR rp.goals ILIKE $3 OR rp.keywords_json ILIKE $3 OR
    EXISTS (
      SELECT 1 FROM artifacts profile
      WHERE profile.artifact_type = 'project_chat_profile'
        AND profile.scope_type = 'project' AND profile.scope_id = rp.id
        AND profile.status = 'ready'
        AND (profile.title ILIKE $3 OR profile.content_markdown ILIKE $3)
    )
  )`];
  if (filters.project_id) {
    values.push(filters.project_id);
    clauses.push(`rp.id = $${values.length}`);
  }
  if (filters.date_from) {
    values.push(filters.date_from);
    clauses.push(`LEFT(rp.updated_at, 10) >= $${values.length}`);
  }
  if (filters.date_to) {
    values.push(filters.date_to);
    clauses.push(`LEFT(rp.updated_at, 10) <= $${values.length}`);
  }
  values.push(limit);
  return many(await db.query(
    `
      SELECT
        'project' AS entity_type,
        rp.id AS entity_id,
        rp.name AS title,
        CONCAT_WS(' ', rp.summary, rp.goals, rp.keywords_json, (
          SELECT profile.content_markdown FROM artifacts profile
          WHERE profile.artifact_type = 'project_chat_profile'
            AND profile.scope_type = 'project' AND profile.scope_id = rp.id
            AND profile.status = 'ready'
          ORDER BY profile.updated_at DESC, profile.id DESC LIMIT 1
        )) AS snippet,
        'project' AS source_type,
        rp.id AS project_id,
        rp.updated_at,
        '/projects/' || rp.id AS href,
        CASE
          WHEN LOWER(rp.name) = LOWER($1) THEN 0
          WHEN rp.name ILIKE $2 THEN 1
          WHEN rp.name ILIKE $3 THEN 2
          WHEN rp.keywords_json ILIKE $3 THEN 3
          ELSE 4
        END AS match_rank,
        CASE WHEN rp.name ILIKE $3 THEN 'title' ELSE 'keyword' END AS match_kind
      FROM research_projects rp
      WHERE ${clauses.join(" AND ")}
      ORDER BY match_rank, rp.updated_at DESC
      LIMIT $${values.length}
    `,
    values
  ));
}

async function searchProjectKnowledge(searchQuery, filters, limit, db) {
  const values = [`%${searchQuery}%`];
  const clauses = [
    "kd.source_type <> 'obsidian'",
    "(kd.title ILIKE $1 OR kd.raw_content ILIKE $1)"
  ];
  if (filters.project_id) {
    values.push(filters.project_id);
    clauses.push(`pcd.project_id = $${values.length}`);
  }
  if (filters.date_from) {
    values.push(filters.date_from);
    clauses.push(`LEFT(kd.updated_at, 10) >= $${values.length}`);
  }
  if (filters.date_to) {
    values.push(filters.date_to);
    clauses.push(`LEFT(kd.updated_at, 10) <= $${values.length}`);
  }
  values.push(limit);
  return many(await db.query(
    `SELECT 'project' AS entity_type, rp.id AS entity_id, rp.name AS title,
            kd.raw_content AS snippet, kd.source_type, rp.id AS project_id,
            kd.updated_at, '/projects/' || rp.id AS href,
            4 AS match_rank, 'keyword' AS match_kind
       FROM knowledge_documents kd
       JOIN project_context_documents pcd ON pcd.document_id = kd.id
       JOIN research_projects rp ON rp.id = pcd.project_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY kd.updated_at DESC LIMIT $${values.length}`,
    values
  ));
}

export function normalizeSearchRequest(params = {}) {
  const searchQuery = text(params.q ?? params.query);
  if (!searchQuery) throw new ValidationError("search query is required");
  const mode = text(params.mode || "quick");
  if (!new Set(["quick", "deep"]).has(mode)) throw new ValidationError("mode must be quick or deep");
  return {
    query: searchQuery.slice(0, 2000),
    mode,
    types: normalizeTypes(params.types),
    limit: normalizeLimit(params.limit),
    filters: {
      project_id: optionalPositiveInt(params.project_id ?? params.filters?.project_id, "project_id"),
      artifact_types: (() => {
        const raw = params.artifact_types ?? params.filters?.artifact_types;
        return (Array.isArray(raw) ? raw : text(raw).split(",")).map(text).filter(Boolean);
      })(),
      date_from: text(params.date_from ?? params.filters?.date_from).slice(0, 10),
      date_to: text(params.date_to ?? params.filters?.date_to).slice(0, 10)
    }
  };
}

export async function quickSearch(params = {}, db = { query }) {
  const request = normalizeSearchRequest({ ...params, mode: "quick" });
  const started = performance.now();
  const calls = [];
  if (request.types.includes("paper")) {
    calls.push(searchLibraryPapers(request.query, request.filters, request.limit, db));
    calls.push(searchLibraryPaperFulltext(request.query, request.filters, request.limit, db));
    calls.push(searchLibraryPaperReaderMessages(request.query, request.filters, request.limit, db));
  }
  if (request.types.includes("artifact")) calls.push(searchArtifacts(request.query, request.filters, request.limit, db));
  if (request.types.includes("project")) {
    calls.push(searchProjects(request.query, request.filters, request.limit, db));
    calls.push(searchProjectKnowledge(request.query, request.filters, request.limit, db));
  }
  const merged = new Map();
  for (const item of (await Promise.all(calls)).flat().map(quickResult)) {
    const key = item._identity;
    const current = merged.get(key);
    if (!current || item.score > current.score) merged.set(key, item);
  }
  const rows = [...merged.values()].map(({ _identity, ...item }) => item);
  rows.sort((left, right) => right.score - left.score || String(right.updated_at || "").localeCompare(String(left.updated_at || "")));
  return {
    mode: "quick",
    query: request.query,
    results: rows.slice(0, request.limit),
    stats: {
      query_embedding_model: "",
      searched_sources: request.types,
      partial_failures: [],
      partial: false,
      elapsed_ms: Math.round(performance.now() - started)
    }
  };
}
