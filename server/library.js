import {
  NotFoundError,
  ValidationError,
  maybeOne,
  parseJson,
  query,
  toJson,
  withTransaction
} from "./db.js";

export const VALID_LIBRARY_STATUSES = new Set(["candidate", "saved", "reading", "read", "archived", "discarded"]);
export const LIBRARY_SOURCE_VALUES = new Set(["daily", "manual"]);
export const REPORT_PRESENCE_VALUES = new Set(["with", "without"]);
export const IMPORTANCE_VALUES = new Set(["high", "medium", "low"]);
export const LIBRARY_SORT_VALUES = new Set(["updated", "importance"]);
const DEFAULT_HIDDEN_LIBRARY_STATUSES = ["archived", "discarded"];
const ARCHIVE_PROTECTED_STATUSES = new Set(["saved", "reading", "read"]);
const PAPER_REPORT_ARTIFACT_TYPE = "paper_report";

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInteger(value, field, { minimum = null } = {}) {
  const raw = text(value);
  if (!raw) return null;
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (minimum !== null && parsed < minimum) {
    throw new ValidationError(`${field} must be at least ${minimum}`);
  }
  return parsed;
}

function positiveId(value, field = "id") {
  const parsed = optionalInteger(value, field, { minimum: 1 });
  if (!parsed) throw new ValidationError(`${field} is required`);
  return parsed;
}

function normalizeLibraryStatus(value, { allowBlank = false } = {}) {
  const status = text(value);
  if (!status && allowBlank) return "";
  const normalized = status || "candidate";
  if (!VALID_LIBRARY_STATUSES.has(normalized)) {
    throw new ValidationError(`Invalid library status: ${normalized}`);
  }
  return normalized;
}

function normalizeLibrarySource(value) {
  const source = text(value);
  if (!source) return "";
  if (!LIBRARY_SOURCE_VALUES.has(source)) {
    throw new ValidationError(`Invalid paper source: ${source}`);
  }
  return source;
}

function normalizeReportPresence(value) {
  const reportPresence = text(value);
  if (!reportPresence) return "";
  if (!REPORT_PRESENCE_VALUES.has(reportPresence)) {
    throw new ValidationError(`Invalid report presence: ${reportPresence}`);
  }
  return reportPresence;
}

function normalizeImportance(value) {
  const importance = text(value);
  if (!importance) return "";
  if (!IMPORTANCE_VALUES.has(importance)) {
    throw new ValidationError(`Invalid paper importance: ${importance}`);
  }
  return importance;
}

function normalizeLibrarySort(value) {
  const sort = text(value) || "updated";
  if (!LIBRARY_SORT_VALUES.has(sort)) {
    throw new ValidationError(`Invalid library sort: ${sort}`);
  }
  return sort;
}

function normalizeLimit(value, fallback = 100) {
  const parsed = optionalInteger(text(value) || String(fallback), "limit");
  return Math.max(1, Math.min(parsed ?? fallback, 500));
}

function normalizeOffset(value) {
  const parsed = optionalInteger(text(value) || "0", "offset");
  return Math.max(0, parsed ?? 0);
}

function paperPayload(row) {
  return {
    id: Number(row.id),
    canonical_key: row.canonical_key,
    title: row.title,
    authors: parseJson(row.authors_json, []),
    abstract: row.abstract,
    published_at: row.published_at,
    updated_at: row.updated_at,
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    venue: row.venue,
    doi: row.doi,
    arxiv_id: row.arxiv_id,
    importance: text(row.importance),
    library_status: row.library_status,
    reading_state: row.reading_state,
    user_tags: parseJson(row.user_tags_json, []),
    user_note: row.user_note,
    saved_at: row.saved_at,
    last_read_at: row.last_read_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function sourcePayload(row) {
  return {
    id: Number(row.id),
    source_type: row.source_type,
    source_identifier: row.source_identifier,
    source_url: row.source_url,
    metadata: parseJson(row.metadata_json, {}),
    fetched_batch_id: row.fetched_batch_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function assetPayload(row) {
  return {
    id: Number(row.id),
    asset_type: row.asset_type,
    path: row.path,
    url: row.url,
    status: row.status,
    error_message: row.error_message,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function chunkPayload(row) {
  return {
    id: Number(row.id),
    asset_id: row.asset_id === null || row.asset_id === undefined ? null : Number(row.asset_id),
    chunk_index: Number(row.chunk_index),
    source: row.source,
    page_start: row.page_start,
    page_end: row.page_end,
    text: row.text,
    token_count: numberValue(row.token_count),
    char_count: numberValue(row.char_count),
    created_at: row.created_at
  };
}

function readingStateForStatus(status, existing = "") {
  if (status === "reading") return "reading";
  if (status === "read") return "read";
  if (status === "candidate" || status === "saved") return "unread";
  return text(existing) || "unread";
}

function buildLibraryFilter(params = {}) {
  const filter = {
    library_status: normalizeLibraryStatus(params.status ?? params.library_status, { allowBlank: true }),
    source: normalizeLibrarySource(params.source),
    report_presence: normalizeReportPresence(params.report_presence),
    importance: normalizeImportance(params.importance),
    sort: normalizeLibrarySort(params.sort),
    project_id: optionalInteger(params.project_id, "project_id", { minimum: 1 }),
    query: text(params.q ?? params.query),
    date_from: text(params.date_from).slice(0, 10),
    date_to: text(params.date_to).slice(0, 10),
    limit: normalizeLimit(params.limit, 100),
    offset: normalizeOffset(params.offset)
  };

  const clauses = [];
  const values = [];
  if (filter.library_status) {
    values.push(filter.library_status);
    clauses.push(`p.library_status = $${values.length}`);
  } else {
    values.push(...DEFAULT_HIDDEN_LIBRARY_STATUSES);
    clauses.push(`p.library_status NOT IN ($${values.length - 1}, $${values.length})`);
  }
  if (filter.source) {
    const manualSourceSql = `EXISTS (
      SELECT 1
      FROM paper_sources source_filter
      WHERE source_filter.paper_id = p.id
        AND (
          COALESCE(source_filter.fetched_batch_id, '') = 'reader-import'
          OR source_filter.source_type IN ('url', 'upload', 'web', 'manual')
          OR COALESCE(source_filter.source_identifier, '') LIKE 'reader-upload-%'
          OR COALESCE(source_filter.source_identifier, '') LIKE 'reader-url-%'
          OR COALESCE(source_filter.source_identifier, '') LIKE 'reader-web-%'
        )
    )`;
    clauses.push(filter.source === "manual" ? manualSourceSql : `NOT ${manualSourceSql}`);
  }
  if (filter.report_presence) {
    const operator = filter.report_presence === "with" ? "EXISTS" : "NOT EXISTS";
    clauses.push(`
      ${operator} (
        SELECT 1
        FROM artifacts report_filter
        WHERE report_filter.scope_type = 'paper'
          AND report_filter.scope_id = p.id
          AND report_filter.artifact_type = 'paper_report'
          AND report_filter.status <> 'removed'
      )
    `);
  }
  if (filter.importance) {
    values.push(filter.importance);
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM project_paper_recommendations importance_recommendation
        WHERE importance_recommendation.paper_id = p.id
          AND importance_recommendation.state = 'accepted'
          AND importance_recommendation.importance = $${values.length}
      )
    `);
  }
  if (filter.query) {
    const needle = `%${filter.query.toLowerCase()}%`;
    values.push(needle, needle, needle);
    clauses.push(`(LOWER(p.title) LIKE $${values.length - 2} OR LOWER(p.abstract) LIKE $${values.length - 1} OR LOWER(p.arxiv_id) LIKE $${values.length})`);
  }
  if (filter.date_from) {
    values.push(filter.date_from);
    clauses.push(`p.published_at != '' AND substr(p.published_at, 1, 10) >= $${values.length}`);
  }
  if (filter.date_to) {
    values.push(filter.date_to);
    clauses.push(`p.published_at != '' AND substr(p.published_at, 1, 10) <= $${values.length}`);
  }
  if (filter.project_id !== null) {
    values.push(filter.project_id);
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM project_papers pp
        WHERE pp.paper_id = p.id
          AND pp.project_id = $${values.length}
          AND NOT (pp.relation = 'candidate' AND pp.note = 'auto_matched_by_project_context')
      )
    `);
  }
  return {
    filter,
    values,
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  };
}

export async function getPaperLibrary(params = {}, db = { query }) {
  const { filter, values, where } = buildLibraryFilter(params);
  const limitParam = values.length + 1;
  const offsetParam = values.length + 2;
  const innerImportanceOrder = filter.sort === "importance" ? "COALESCE(ai.importance_rank, 3)," : "";
  const outerImportanceOrder = filter.sort === "importance" ? "f.importance_rank," : "";
  const rowsResult = await db.query(
    `
      WITH accepted_importance AS (
        SELECT
          r.paper_id,
          MIN(
            CASE r.importance
              WHEN 'high' THEN 0
              WHEN 'medium' THEN 1
              WHEN 'low' THEN 2
              ELSE 3
            END
          ) AS importance_rank
        FROM project_paper_recommendations r
        WHERE r.state = 'accepted'
        GROUP BY r.paper_id
      ),
      filtered AS (
        SELECT
          p.*,
          CASE ai.importance_rank
            WHEN 0 THEN 'high'
            WHEN 1 THEN 'medium'
            WHEN 2 THEN 'low'
            ELSE ''
          END AS importance,
          COALESCE(ai.importance_rank, 3) AS importance_rank
        FROM papers p
        LEFT JOIN accepted_importance ai ON ai.paper_id = p.id
        ${where}
        ORDER BY
          ${innerImportanceOrder}
          CASE p.library_status
            WHEN 'reading' THEN 0
            WHEN 'saved' THEN 1
            WHEN 'candidate' THEN 2
            WHEN 'read' THEN 3
            WHEN 'archived' THEN 4
            ELSE 5
          END,
          p.updated_at DESC,
          p.published_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      ),
      asset_counts AS (
        SELECT paper_id, COUNT(*) AS asset_count
        FROM paper_assets
        WHERE paper_id IN (SELECT id FROM filtered)
        GROUP BY paper_id
      ),
      chunk_counts AS (
        SELECT paper_id, COUNT(*) AS chunk_count
        FROM paper_chunks
        WHERE paper_id IN (SELECT id FROM filtered)
        GROUP BY paper_id
      ),
      artifact_counts AS (
        SELECT scope_id AS paper_id, COUNT(*) AS artifact_count
        FROM artifacts
        WHERE scope_type = 'paper'
          AND scope_id IN (SELECT id FROM filtered)
        GROUP BY scope_id
      )
      SELECT
        f.*,
        COALESCE(ac.asset_count, 0) AS asset_count,
        COALESCE(cc.chunk_count, 0) AS chunk_count,
        COALESCE(afc.artifact_count, 0) AS artifact_count
      FROM filtered f
      LEFT JOIN asset_counts ac ON ac.paper_id = f.id
      LEFT JOIN chunk_counts cc ON cc.paper_id = f.id
      LEFT JOIN artifact_counts afc ON afc.paper_id = f.id
      ORDER BY
        ${outerImportanceOrder}
        CASE f.library_status
          WHEN 'reading' THEN 0
          WHEN 'saved' THEN 1
          WHEN 'candidate' THEN 2
          WHEN 'read' THEN 3
          WHEN 'archived' THEN 4
          ELSE 5
        END,
        f.updated_at DESC,
        f.published_at DESC
    `,
    [...values, filter.limit, filter.offset]
  );
  const totalResult = await db.query(`SELECT COUNT(*) AS count FROM papers p ${where}`, values);
  const total = Number(totalResult.rows?.[0]?.count || 0);
  return {
    items: rowsResult.rows.map((row) => ({
      ...paperPayload(row),
      asset_count: numberValue(row.asset_count),
      chunk_count: numberValue(row.chunk_count),
      artifact_count: numberValue(row.artifact_count)
    })),
    total,
    limit: filter.limit,
    offset: filter.offset
  };
}

async function paperReportPayload(db, libraryPaperId) {
  if (!libraryPaperId) return null;
  const result = await db.query(
    `
      SELECT *
      FROM artifacts
      WHERE scope_type = 'paper'
        AND scope_id = $1
        AND artifact_type = $2
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [libraryPaperId, PAPER_REPORT_ARTIFACT_TYPE]
  );
  const row = maybeOne(result);
  if (!row || row.status === "removed") return null;
  const content = parseJson(row.content_json, {});
  const source = parseJson(row.source_json, {});
  return {
    paper_id: Number(libraryPaperId),
    artifact_id: Number(row.id),
    status: row.status,
    prompt: content.prompt || "",
    system_prompt: content.system_prompt || "",
    model_provider_id: row.model_provider_id || "",
    model: row.model || "",
    source_project_ids: Array.isArray(content.source_project_ids) ? content.source_project_ids : [],
    report_markdown: row.content_markdown || "",
    error_message: content.error_message || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: content.started_at ?? null,
    finished_at: content.finished_at ?? null
  };
}

export async function getPaperLibraryDetail(paperId, db = { query }) {
  const id = positiveId(paperId, "paper_id");
  const paperResult = await db.query("SELECT * FROM papers WHERE id = $1", [id]);
  const paperRow = maybeOne(paperResult);
  if (!paperRow) throw new NotFoundError(`Paper not found: ${id}`);
  const paper = paperPayload(paperRow);

  const [
    sources,
    assets,
    chunks,
    artifacts
  ] = await Promise.all([
    db.query(
      `
        SELECT id, source_type, source_identifier, source_url, metadata_json, fetched_batch_id, created_at, updated_at
        FROM paper_sources
        WHERE paper_id = $1
        ORDER BY source_type, id
      `,
      [id]
    ),
    db.query(
      `
        SELECT id, asset_type, path, url, status, error_message, metadata_json, created_at, updated_at
        FROM paper_assets
        WHERE paper_id = $1
        ORDER BY asset_type, id
      `,
      [id]
    ),
    db.query(
      `
        SELECT id, asset_id, chunk_index, source, page_start, page_end, text, token_count, char_count, created_at
        FROM paper_chunks
        WHERE paper_id = $1
        ORDER BY chunk_index
        LIMIT 50
      `,
      [id]
    ),
    db.query(
      `
        SELECT id, artifact_type, title, status, updated_at
        FROM artifacts
        WHERE scope_type = 'paper' AND scope_id = $1
        ORDER BY updated_at DESC
      `,
      [id]
    )
  ]);
  const linkedProjects = await db.query(
        `
          SELECT
            pp.project_id,
            rp.name AS project_name,
            pp.relation,
            pp.note,
            COALESCE(r.importance, '') AS importance,
            pp.updated_at
          FROM project_papers pp
          JOIN research_projects rp ON rp.id = pp.project_id
          LEFT JOIN project_paper_recommendations r
            ON r.project_id = pp.project_id
           AND r.paper_id = pp.paper_id
           AND r.state = 'accepted'
          WHERE pp.paper_id = $1
            AND NOT (pp.relation = 'candidate' AND pp.note = 'auto_matched_by_project_context')
          ORDER BY pp.updated_at DESC
        `,
        [id]
      );
  const report = await paperReportPayload(db, id);
  const linkedProjectRows = linkedProjects.rows || [];
  const importance = ["high", "medium", "low"].find((value) => (
    linkedProjectRows.some((project) => project.importance === value)
  )) || "";

  return {
    paper: { ...paper, importance },
    sources: sources.rows.map(sourcePayload),
    assets: assets.rows.map(assetPayload),
    chunks: chunks.rows.map(chunkPayload),
    linked_projects: linkedProjectRows.map((project) => ({
      project_id: Number(project.project_id),
      project_name: project.project_name,
      relation: project.relation,
      note: project.note,
      importance: project.importance || "",
      updated_at: project.updated_at
    })),
    artifacts: artifacts.rows.map((artifact) => ({
      id: Number(artifact.id),
      artifact_type: artifact.artifact_type,
      title: artifact.title,
      status: artifact.status,
      updated_at: artifact.updated_at
    })),
    paper_report: report
  };
}

export async function updatePaperLibraryStatus(paperId, payload = {}) {
  const id = positiveId(paperId, "paper_id");
  const status = normalizeLibraryStatus(payload.status ?? payload.library_status, { allowBlank: true });
  if (!status) throw new ValidationError("status is required");
  const userTags = Array.isArray(payload.user_tags) ? payload.user_tags.map((item) => text(item)).filter(Boolean) : null;
  const hasUserNote = Object.hasOwn(payload, "user_note");
  const result = await withTransaction(async (client) => {
    const paperResult = await client.query("SELECT * FROM papers WHERE id = $1", [id]);
    const paper = maybeOne(paperResult);
    if (!paper) throw new NotFoundError(`Paper not found: ${id}`);

    const now = nowIso();
    const savedAt = ARCHIVE_PROTECTED_STATUSES.has(status) && !paper.saved_at ? now : paper.saved_at;
    const lastReadAt = status === "read" ? now : paper.last_read_at;
    const readingState = readingStateForStatus(status, paper.reading_state);
    const updates = [
      "library_status = $1",
      "reading_state = $2",
      "saved_at = $3",
      "last_read_at = $4",
      "updated_at = $5"
    ];
    const values = [status, readingState, savedAt, lastReadAt, now];
    if (hasUserNote) {
      values.push(text(payload.user_note));
      updates.push(`user_note = $${values.length}`);
    }
    if (userTags !== null) {
      values.push(toJson(userTags));
      updates.push(`user_tags_json = $${values.length}`);
    }
    values.push(id);
    await client.query(`UPDATE papers SET ${updates.join(", ")} WHERE id = $${values.length}`, values);
    return {
      ok: true,
      paper_id: id,
      library_status: status,
      reading_state: readingState
    };
  });
  const detail = await getPaperLibraryDetail(id);
  return { ...detail, ...result };
}
