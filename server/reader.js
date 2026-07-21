import { createHash } from "node:crypto";

import { ConflictError, NotFoundError, ValidationError, maybeOne, parseJson, query, toJson, withTransaction } from "./db.js";
import { DEFAULT_PAPER_READER_PROMPT, getAppSettings } from "./settings.js";

const PAPER_REPORT_ARTIFACT_TYPE = "paper_report";
const PAPER_READER_ANALYSIS_SYSTEM = "You are a research document reading assistant. Read the supplied cleaned document text and answer accurately from it.";
const AUTO_MATCH_NOTE = "auto_matched_by_project_context";
const REPORT_STATUSES = ["queued", "processing", "done", "failed", "cancelled"];

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

function positiveId(value, field = "id") {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) throw new ValidationError(`${field} must be a positive integer`);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ValidationError(`${field} must be a positive integer`);
  return parsed;
}

function normalizeLimit(value, fallback = 300) {
  const raw = text(value) || String(fallback);
  if (!/^[+-]?\d+$/.test(raw)) throw new ValidationError("limit must be an integer");
  return Math.max(1, Math.min(Number.parseInt(raw, 10), 1000));
}

function normalizeOffset(value) {
  const raw = text(value) || "0";
  if (!/^\d+$/.test(raw)) throw new ValidationError("offset must be a non-negative integer");
  return Number.parseInt(raw, 10);
}

function normalizeReaderSource(value) {
  const source = text(value).toLowerCase();
  if (!source) return "";
  if (source !== "daily" && source !== "manual") {
    throw new ValidationError("source must be daily or manual");
  }
  return source;
}

function normalizeReaderStatus(value) {
  const status = text(value).toLowerCase();
  if (!status) return "";
  if (!REPORT_STATUSES.includes(status)) throw new ValidationError(`Invalid report status: ${status}`);
  return status;
}

function likeEscape(value) {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function searchTokens(value) {
  return text(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .slice(0, 8);
}

function parseIntegerList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
}

function yearFromTimestamp(value) {
  const match = text(value).match(/^(\d{4})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return year >= 1000 && year <= 9999 ? year : null;
}

function sourceTypeForLegacyArxivId(arxivId) {
  const value = text(arxivId);
  if (value.startsWith("reader-upload-")) return "upload";
  if (value.startsWith("reader-url-")) return "url";
  if (value.startsWith("reader-web-")) return "web";
  return "arxiv";
}

function canonicalKey(sourceType, sourceIdentifier, arxivId = "") {
  const normalizedArxivId = text(arxivId).toLowerCase();
  if (normalizedArxivId && sourceType === "arxiv") return `arxiv:${normalizedArxivId}`;
  const identifier = text(sourceIdentifier).toLowerCase();
  if (identifier) return `${sourceType}:${identifier}`;
  const digest = createHash("sha256").update(`${sourceType}\n${nowIso()}`).digest("hex").slice(0, 24);
  return `hash:${digest}`;
}

function reportContent(row) {
  const content = parseJson(row?.content_json, {});
  return content && typeof content === "object" && !Array.isArray(content) ? content : {};
}

function reportSource(row) {
  const source = parseJson(row?.source_json, {});
  return source && typeof source === "object" && !Array.isArray(source) ? source : {};
}

function sourceProjectIdsFromContent(content) {
  return parseIntegerList(content?.source_project_ids);
}

function paperPayload(row) {
  return {
    id: Number(row.id),
    arxiv_id: row.arxiv_id || "",
    title: row.title || "",
    authors: parseJson(row.authors_json, []),
    summary: row.summary || row.abstract || "",
    categories: parseJson(row.categories_json, []),
    published_at: row.published_at || "",
    updated_at: row.updated_at || "",
    link: row.link || "",
    pdf_link: row.pdf_link || "",
    pdf_path: row.pdf_path || "",
    text_path: row.text_path || "",
    text_status: row.text_status || "",
    text_extracted_at: row.text_extracted_at || null,
    text_error: row.text_error || "",
    text_char_count: numberValue(row.text_char_count)
  };
}

function messagePayload(row) {
  return {
    id: Number(row.id),
    paper_id: Number(row.library_paper_id ?? row.paper_id),
    role: row.role || "",
    content: row.content || "",
    source: row.source || "",
    model_provider_id: row.model_provider_id || "",
    model: row.model || "",
    context: parseJson(row.context_json, {}),
    created_at: row.created_at || ""
  };
}

async function findReaderPaper(db, paperId) {
  const id = positiveId(paperId, "paper_id");
  const result = await db.query(
    `
      SELECT
        p.*,
        p.abstract AS summary,
        COALESCE(source.source_type, '') AS source_type,
        COALESCE(source.source_url, '') AS link,
        COALESCE(source.metadata_json, '{}') AS source_metadata_json,
        COALESCE(source.metadata_json::jsonb -> 'categories', '[]'::jsonb)::text AS categories_json,
        COALESCE(pdf_asset.url, '') AS pdf_link,
        COALESCE(pdf_asset.path, '') AS pdf_path,
        COALESCE(text_asset.path, '') AS text_path,
        COALESCE(text_asset.status, 'pending') AS text_status,
        text_asset.updated_at AS text_extracted_at,
        COALESCE(text_asset.error_message, '') AS text_error,
        COALESCE((text_asset.metadata_json::jsonb ->> 'char_count')::bigint, 0) AS text_char_count
      FROM papers p
      LEFT JOIN LATERAL (
        SELECT ps.source_type, ps.source_url, ps.metadata_json
        FROM paper_sources ps
        WHERE ps.paper_id = p.id
        ORDER BY ps.updated_at DESC, ps.id DESC
        LIMIT 1
      ) source ON TRUE
      LEFT JOIN LATERAL (
        SELECT pa.url, pa.path
        FROM paper_assets pa
        WHERE pa.paper_id = p.id AND pa.asset_type = 'pdf'
        ORDER BY CASE WHEN pa.path != '' THEN 0 WHEN pa.url != '' THEN 1 ELSE 2 END,
                 pa.updated_at DESC, pa.id DESC
        LIMIT 1
      ) pdf_asset ON TRUE
      LEFT JOIN LATERAL (
        SELECT pa.path, pa.status, pa.error_message, pa.metadata_json, pa.updated_at
        FROM paper_assets pa
        WHERE pa.paper_id = p.id AND pa.asset_type = 'text'
        ORDER BY CASE WHEN pa.status = 'complete' AND pa.path != '' THEN 0 ELSE 1 END,
                 pa.updated_at DESC, pa.id DESC
        LIMIT 1
      ) text_asset ON TRUE
      WHERE p.id = $1
    `,
    [id]
  );
  const row = maybeOne(result);
  if (!row) throw new NotFoundError(`Paper not found: ${id}`);
  return row;
}

function paperReportPayloadFromRow(row, paperId) {
  if (!row || row.status === "removed") return null;
  const content = reportContent(row);
  return {
    paper_id: Number(paperId),
    artifact_id: Number(row.id),
    status: row.status || "",
    prompt: content.prompt || "",
    system_prompt: content.system_prompt || "",
    model_provider_id: row.model_provider_id || "",
    model: row.model || "",
    source_project_ids: sourceProjectIdsFromContent(content),
    report_markdown: row.content_markdown || "",
    error_message: content.error_message || "",
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    started_at: content.started_at ?? null,
    finished_at: content.finished_at ?? null
  };
}

function reportSeedMessages(report, paperId) {
  if (!report || !text(report.report_markdown)) return [];
  const createdAt = report.finished_at || report.updated_at || report.created_at || "";
  const messages = [];
  if (text(report.prompt)) {
    messages.push({
      id: -(Number(paperId) * 10 + 1),
      paper_id: Number(paperId),
      role: "user",
      content: report.prompt,
      source: "analysis_prompt",
      model_provider_id: "",
      model: "",
      created_at: createdAt
    });
  }
  messages.push({
    id: -(Number(paperId) * 10 + 2),
    paper_id: Number(paperId),
    role: "assistant",
    content: report.report_markdown,
    source: "analysis_report",
    model_provider_id: report.model_provider_id || "",
    model: report.model || "",
    created_at: createdAt
  });
  return messages;
}

async function paperReportStats(db = { query }) {
  const result = await db.query(
    `
      SELECT status, COUNT(*) AS count, MAX(updated_at) AS latest_updated_at
      FROM artifacts
      WHERE scope_type = 'paper'
        AND artifact_type = $1
        AND status != 'removed'
      GROUP BY status
    `,
    [PAPER_REPORT_ARTIFACT_TYPE]
  );
  const stats = { queued: 0, processing: 0, done: 0, failed: 0, total: 0 };
  for (const row of result.rows || []) {
    const status = row.status || "";
    const count = numberValue(row.count);
    stats[status] = count;
    stats.total += count;
    if (row.latest_updated_at && (!stats.latest_updated_at || String(row.latest_updated_at) > String(stats.latest_updated_at))) {
      stats.latest_updated_at = row.latest_updated_at;
    }
  }
  return stats;
}

async function projectNameMap(projectIds, db = { query }) {
  const ids = parseIntegerList(projectIds);
  if (!ids.length) return new Map();
  const result = await db.query(
    "SELECT id, name FROM research_projects WHERE id = ANY($1::bigint[])",
    [ids]
  );
  return new Map((result.rows || []).map((row) => [Number(row.id), row.name || ""]));
}

async function projectLinksByPaper(paperIds, db = { query }) {
  const ids = parseIntegerList(paperIds);
  const empty = { linked: new Map(), recommendations: new Map() };
  if (!ids.length) return empty;
  const [linkedResult, recommendationResult] = await Promise.all([
    db.query(
      `
        SELECT pp.paper_id, pp.project_id, rp.name AS project_name
        FROM project_papers pp
        JOIN research_projects rp ON rp.id = pp.project_id
        WHERE pp.paper_id = ANY($1::bigint[])
          AND NOT (pp.relation = 'candidate' AND pp.note = $2)
        ORDER BY pp.paper_id, pp.updated_at DESC, rp.name
      `,
      [ids, AUTO_MATCH_NOTE]
    ),
    db.query(
      `
        SELECT r.paper_id, r.project_id, rp.name AS project_name
        FROM project_paper_recommendations r
        JOIN research_projects rp ON rp.id = r.project_id
        WHERE r.paper_id = ANY($1::bigint[])
          AND r.state IN ('pending', 'accepted')
        ORDER BY r.paper_id, CASE r.state WHEN 'pending' THEN 0 ELSE 1 END, rp.name
      `,
      [ids]
    )
  ]);
  function group(rows) {
    const grouped = new Map();
    for (const row of rows || []) {
      const paperId = Number(row.paper_id);
      if (!grouped.has(paperId)) grouped.set(paperId, { ids: [], names: [] });
      const item = grouped.get(paperId);
      item.ids.push(Number(row.project_id));
      item.names.push(row.project_name || "");
    }
    return grouped;
  }
  return {
    linked: group(linkedResult.rows),
    recommendations: group(recommendationResult.rows)
  };
}

async function sourceProjectNamesByIds(sourceIdsByPaper, db = { query }) {
  const allIds = [];
  for (const ids of sourceIdsByPaper.values()) allIds.push(...ids);
  const names = await projectNameMap(allIds, db);
  const result = new Map();
  for (const [paperId, ids] of sourceIdsByPaper.entries()) {
    result.set(paperId, ids.map((id) => names.get(id)).filter(Boolean));
  }
  return result;
}

export async function getPaperReportsSummary(db = { query }) {
  const latestResult = await db.query(
    `
      SELECT
        a.id,
        a.scope_id,
        a.status,
        a.content_json,
        a.source_json,
        a.updated_at,
        p.id AS paper_id
      FROM artifacts a
      JOIN papers p ON p.id = a.scope_id
      WHERE a.scope_type = 'paper'
        AND a.artifact_type = $1
        AND a.status != 'removed'
      ORDER BY a.updated_at DESC, a.id DESC
      LIMIT 20
    `,
    [PAPER_REPORT_ARTIFACT_TYPE]
  );
  let latest = null;
  for (const row of latestResult.rows || []) {
    const paperId = Number(row.paper_id || 0);
    if (!paperId) continue;
    latest = {
      artifact_id: Number(row.id),
      paper_id: paperId,
      library_paper_id: paperId,
      status: row.status || "",
      updated_at: row.updated_at || ""
    };
    break;
  }
  return {
    stats: await paperReportStats(db),
    latest
  };
}

export async function getReaderPapers(params = {}, db = { query }) {
  const limit = normalizeLimit(params.limit, 300);
  const offset = normalizeOffset(params.offset);
  const projectId = text(params.project_id) ? positiveId(params.project_id, "project_id") : null;
  const source = normalizeReaderSource(params.source ?? params.source_type);
  const status = normalizeReaderStatus(params.status);
  const tokens = searchTokens(params.q ?? params.query);
  const values = [PAPER_REPORT_ARTIFACT_TYPE];
  const filters = [];
  for (const token of tokens) {
    const needle = `%${likeEscape(token)}%`;
    const indexes = [];
    for (let i = 0; i < 8; i += 1) {
      values.push(needle);
      indexes.push(`$${values.length}`);
    }
    filters.push(`
      (
        LOWER(rr.title) LIKE ${indexes[0]} ESCAPE '\\'
        OR LOWER(rr.status) LIKE ${indexes[1]} ESCAPE '\\'
        OR LOWER(rr.content_markdown) LIKE ${indexes[2]} ESCAPE '\\'
        OR LOWER(rr.content_json) LIKE ${indexes[3]} ESCAPE '\\'
        OR LOWER(rr.source_json) LIKE ${indexes[4]} ESCAPE '\\'
        OR LOWER(COALESCE(p.arxiv_id, '')) LIKE ${indexes[5]} ESCAPE '\\'
        OR LOWER(COALESCE(p.title, '')) LIKE ${indexes[6]} ESCAPE '\\'
        OR LOWER(COALESCE(source.source_url, '')) LIKE ${indexes[7]} ESCAPE '\\'
      )
    `);
  }
  if (status) {
    values.push(status);
    filters.push(`rr.status = $${values.length}`);
  }
  if (projectId) {
    values.push(projectId);
    const index = `$${values.length}`;
    filters.push(`(
      EXISTS (
        SELECT 1 FROM project_papers pp
        WHERE pp.paper_id = p.id
          AND pp.project_id = ${index}
          AND NOT (pp.relation = 'candidate' AND pp.note = '${AUTO_MATCH_NOTE}')
      )
      OR EXISTS (
        SELECT 1 FROM project_paper_recommendations ppr
        WHERE ppr.paper_id = p.id
          AND ppr.project_id = ${index}
          AND ppr.state IN ('pending', 'accepted')
      )
      OR COALESCE(rr.content_json::jsonb -> 'source_project_ids', '[]'::jsonb)
           @> jsonb_build_array(${index}::bigint)
    )`);
  }
  const manualSourceSql = `COALESCE(source.source_type, '') IN ('upload', 'url', 'web', 'manual')`;
  if (source === "manual") filters.push(manualSourceSql);
  if (source === "daily") filters.push(`NOT ${manualSourceSql}`);
  const filterSql = filters.length ? `AND ${filters.join(" AND ")}` : "";
  const reportRowsSql = `WITH report_rows AS (
    SELECT
      a.id, a.scope_id, a.title, a.status, a.model_provider_id, a.model,
      a.content_markdown, LEFT(a.content_markdown, 500) AS report_excerpt,
      a.content_json, a.source_json, a.created_at, a.updated_at
    FROM artifacts a
    WHERE a.scope_type = 'paper'
      AND a.artifact_type = $1
      AND a.status != 'removed'
  )`;
  const countResult = await db.query(
    `${reportRowsSql}
     SELECT COUNT(*) AS total
     FROM report_rows rr
     JOIN papers p ON p.id = rr.scope_id
     LEFT JOIN LATERAL (
       SELECT ps.source_type, ps.source_url
       FROM paper_sources ps
       WHERE ps.paper_id = p.id
       ORDER BY ps.updated_at DESC, ps.id DESC
       LIMIT 1
     ) source ON TRUE
     WHERE 1 = 1 ${filterSql}`,
    values
  );
  const total = numberValue(countResult.rows?.[0]?.total);
  const listValues = [...values, limit, offset];
  const result = await db.query(
    `
      ${reportRowsSql}
      SELECT
        rr.id,
        rr.scope_id,
        rr.title AS artifact_title,
        rr.status,
        rr.model_provider_id,
        rr.model,
        rr.report_excerpt,
        rr.content_json,
        rr.source_json,
        rr.created_at,
        rr.updated_at,
        p.id AS paper_id,
        p.arxiv_id,
        p.title,
        p.authors_json,
        COALESCE(source.metadata_json::jsonb -> 'categories', '[]'::jsonb)::text AS categories_json,
        p.published_at,
        COALESCE(source.source_url, '') AS link,
        COALESCE(text_asset.status, 'pending') AS text_status,
        CASE WHEN ${manualSourceSql} THEN 'manual' ELSE 'daily' END AS source
      FROM report_rows rr
      JOIN papers p ON p.id = rr.scope_id
      LEFT JOIN LATERAL (
        SELECT ps.source_type, ps.source_url, ps.metadata_json
        FROM paper_sources ps
        WHERE ps.paper_id = p.id
        ORDER BY ps.updated_at DESC, ps.id DESC
        LIMIT 1
      ) source ON TRUE
      LEFT JOIN LATERAL (
        SELECT pa.status
        FROM paper_assets pa
        WHERE pa.paper_id = p.id AND pa.asset_type = 'text'
        ORDER BY CASE WHEN pa.status = 'complete' AND pa.path != '' THEN 0 ELSE 1 END,
                 pa.updated_at DESC, pa.id DESC
        LIMIT 1
      ) text_asset ON TRUE
      WHERE 1 = 1
        ${filterSql}
      ORDER BY
        CASE rr.status
          WHEN 'processing' THEN 0
          WHEN 'queued' THEN 1
          WHEN 'failed' THEN 2
          WHEN 'done' THEN 3
          WHEN 'cancelled' THEN 4
          ELSE 5
        END,
        rr.updated_at DESC,
        rr.id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}
    `,
    listValues
  );
  const paperIds = (result.rows || []).map((row) => Number(row.paper_id)).filter(Boolean);
  const links = await projectLinksByPaper(paperIds, db);
  const sourceIdsByPaper = new Map();
  for (const row of result.rows || []) {
    sourceIdsByPaper.set(Number(row.paper_id), sourceProjectIdsFromContent(reportContent(row)));
  }
  const sourceNames = await sourceProjectNamesByIds(sourceIdsByPaper, db);
  const items = (result.rows || []).map((row) => {
    const paperId = Number(row.paper_id);
    const linked = links.linked.get(paperId) || { ids: [], names: [] };
    const recommendations = links.recommendations.get(paperId) || { ids: [], names: [] };
    const sourceProjectIds = sourceIdsByPaper.get(paperId) || [];
    const content = reportContent(row);
    return {
      paper_id: paperId,
      id: paperId,
      library_paper_id: paperId,
      artifact_id: Number(row.id),
      status: row.status || "",
      title: row.title || row.artifact_title || "",
      arxiv_id: row.arxiv_id || "",
      authors: parseJson(row.authors_json, []),
      categories: parseJson(row.categories_json, []),
      published_at: row.published_at || "",
      link: row.link || "",
      text_status: row.text_status || "",
      source: row.source || "daily",
      project_count: sourceProjectIds.length,
      project_ids: sourceProjectIds,
      project_names: sourceNames.get(paperId) || [],
      source_project_ids: sourceProjectIds,
      source_project_names: sourceNames.get(paperId) || [],
      recommendation_project_count: recommendations.ids.length,
      recommendation_project_ids: recommendations.ids,
      recommendation_project_names: recommendations.names,
      linked_project_count: linked.ids.length,
      linked_project_ids: linked.ids,
      linked_project_names: linked.names,
      relation_types: [],
      model_provider_id: row.model_provider_id || "",
      model: row.model || "",
      error_message: content.error_message || "",
      report_excerpt: text(row.report_excerpt).slice(0, 500),
      created_at: row.created_at || "",
      updated_at: row.updated_at || "",
      started_at: content.started_at ?? null,
      finished_at: content.finished_at ?? null
    };
  });
  return {
    stats: await paperReportStats(db),
    total,
    limit,
    offset,
    items
  };
}

export async function updateReaderPaperTitle(paperId, payload = {}) {
  const id = positiveId(paperId, "paper_id");
  const title = text(payload.title);
  if (!title) throw new ValidationError("title is required");
  await withTransaction(async (client) => {
    const now = nowIso();
    const paperResult = await client.query(
      "UPDATE papers SET title = $1, updated_at = $2 WHERE id = $3 RETURNING id",
      [title, now, id]
    );
    if (!paperResult.rowCount) throw new NotFoundError(`Paper not found: ${id}`);
    await client.query(
      `
        UPDATE artifacts
        SET title = $1, updated_at = $2
        WHERE scope_type = 'paper'
          AND artifact_type = $3
          AND status != 'removed'
          AND scope_id = $4
      `,
      [title, now, PAPER_REPORT_ARTIFACT_TYPE, id]
    );
  });
  return { ...(await getReaderPaperDetail(id)), ok: true };
}

async function findLegacyPaper(db, paperId) {
  const id = positiveId(paperId, "paper_id");
  const result = await db.query("SELECT * FROM arxiv_papers WHERE id = $1", [id]);
  const row = maybeOne(result);
  if (!row) throw new NotFoundError(`Paper not found: ${id}`);
  return row;
}

export async function findLibraryPaperIdForLegacyPaper(db, legacyPaper) {
  const arxivId = text(legacyPaper.arxiv_id);
  if (!arxivId) return null;
  const sourceType = sourceTypeForLegacyArxivId(arxivId);
  const key = canonicalKey(sourceType, arxivId, sourceType === "arxiv" ? arxivId : "");
  const direct = await db.query(
    `
      SELECT id
      FROM papers
      WHERE ($1 != '' AND arxiv_id = $1)
         OR canonical_key = $2
      ORDER BY id
      LIMIT 1
    `,
    [sourceType === "arxiv" ? arxivId : "", key]
  );
  const directRow = maybeOne(direct);
  if (directRow) return Number(directRow.id);
  const source = await db.query(
    `
      SELECT p.id
      FROM papers p
      JOIN paper_sources s ON s.paper_id = p.id
      WHERE s.source_type = $1
        AND s.source_identifier = $2
      ORDER BY p.id
      LIMIT 1
    `,
    [sourceType, arxivId]
  );
  const sourceRow = maybeOne(source);
  return sourceRow ? Number(sourceRow.id) : null;
}

async function upsertPaperAsset(db, paperId, { assetType, path = "", url = "", status = "pending", errorMessage = "", metadata = {} }) {
  if (!text(path) && !text(url) && status === "pending" && !text(errorMessage)) return null;
  const now = nowIso();
  const result = await db.query(
    `
      SELECT id
      FROM paper_assets
      WHERE paper_id = $1
        AND asset_type = $2
        AND (
          ($3 != '' AND path = $3)
          OR ($4 != '' AND url = $4)
          OR (path = '' AND url = '' AND $3 = '' AND $4 = '')
        )
      ORDER BY id
      LIMIT 1
    `,
    [paperId, assetType, text(path), text(url)]
  );
  const existing = maybeOne(result);
  if (existing) {
    await db.query(
      `
        UPDATE paper_assets
        SET path = $1,
            url = $2,
            status = $3,
            error_message = $4,
            metadata_json = $5,
            updated_at = $6
        WHERE id = $7
      `,
      [text(path), text(url), text(status) || "pending", text(errorMessage), toJson(metadata), now, Number(existing.id)]
    );
    return Number(existing.id);
  }
  const inserted = await db.query(
    `
      INSERT INTO paper_assets(
        paper_id, asset_type, path, url, status, error_message, metadata_json, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
      RETURNING id
    `,
    [paperId, assetType, text(path), text(url), text(status) || "pending", text(errorMessage), toJson(metadata), now]
  );
  return Number(inserted.rows[0].id);
}

export async function ensureLibraryPaperIdForLegacyPaper(db, legacyPaper) {
  const existing = await findLibraryPaperIdForLegacyPaper(db, legacyPaper);
  if (existing) return existing;
  const arxivId = text(legacyPaper.arxiv_id);
  const sourceType = sourceTypeForLegacyArxivId(arxivId);
  const longTermArxivId = sourceType === "arxiv" ? arxivId : "";
  const key = canonicalKey(sourceType, arxivId, longTermArxivId);
  const now = nowIso();
  const publishedAt = text(legacyPaper.published_at);
  const inserted = await db.query(
    `
      INSERT INTO papers(
        canonical_key, title, authors_json, abstract, published_at,
        year, venue, doi, arxiv_id, library_status, reading_state,
        user_tags_json, user_note, saved_at, last_read_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, '', '', $7, 'candidate', 'unread', '[]', '', NULL, NULL, $8, $8)
      ON CONFLICT(canonical_key) DO UPDATE SET
        title = excluded.title,
        authors_json = excluded.authors_json,
        abstract = excluded.abstract,
        published_at = excluded.published_at,
        year = COALESCE(excluded.year, papers.year),
        arxiv_id = excluded.arxiv_id,
        updated_at = excluded.updated_at
      RETURNING id
    `,
    [
      key,
      text(legacyPaper.title) || "Untitled paper",
      legacyPaper.authors_json || "[]",
      text(legacyPaper.summary),
      publishedAt,
      yearFromTimestamp(publishedAt),
      longTermArxivId,
      now
    ]
  );
  const paperId = Number(inserted.rows[0].id);
  await db.query(
    `
      INSERT INTO paper_sources(paper_id, source_type, source_identifier, source_url, metadata_json, fetched_batch_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      ON CONFLICT(paper_id, source_type, source_identifier) DO UPDATE SET
        source_url = excluded.source_url,
        metadata_json = excluded.metadata_json,
        fetched_batch_id = excluded.fetched_batch_id,
        updated_at = excluded.updated_at
    `,
    [
      paperId,
      sourceType,
      arxivId,
      text(legacyPaper.link),
      toJson({
        categories: parseJson(legacyPaper.categories_json, []),
        pdf_link: text(legacyPaper.pdf_link),
        arxiv_updated_at: text(legacyPaper.updated_at)
      }),
      text(legacyPaper.fetched_batch_id),
      now
    ]
  );
  await upsertPaperAsset(db, paperId, {
    assetType: "pdf",
    path: legacyPaper.pdf_path || "",
    url: legacyPaper.pdf_link || "",
    status: legacyPaper.pdf_path ? "complete" : "pending"
  });
  const textAssetId = await upsertPaperAsset(db, paperId, {
    assetType: "text",
    path: legacyPaper.text_path || "",
    status: legacyPaper.text_status || "pending",
    errorMessage: legacyPaper.text_error || "",
    metadata: { char_count: numberValue(legacyPaper.text_char_count) }
  });
  const legacyPaperId = Number(legacyPaper.id || legacyPaper.paper_id || 0);
  if (legacyPaperId > 0) {
    const chunks = await db.query(
      `
        SELECT chunk_index, source, page_start, page_end, text, token_count, char_count
        FROM arxiv_text_chunks
        WHERE paper_id = $1
        ORDER BY chunk_index
      `,
      [legacyPaperId]
    );
    if (chunks.rows?.length) {
      await db.query("DELETE FROM paper_chunks WHERE paper_id = $1", [paperId]);
      for (const chunk of chunks.rows) {
        await db.query(
          `
            INSERT INTO paper_chunks(
              paper_id, asset_id, chunk_index, source, page_start, page_end,
              text, token_count, char_count, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            paperId,
            chunk.source === "full_text" ? textAssetId : null,
            numberValue(chunk.chunk_index),
            chunk.source || "full_text",
            chunk.page_start ?? null,
            chunk.page_end ?? null,
            chunk.text || "",
            numberValue(chunk.token_count),
            numberValue(chunk.char_count),
            now
          ]
        );
      }
    }
    await db.query(
      `
        INSERT INTO paper_embeddings(paper_id, model, embedding_json, created_at)
        SELECT $1, model, embedding_json, created_at
        FROM arxiv_paper_embeddings
        WHERE paper_id = $2
        ON CONFLICT(paper_id, model) DO UPDATE SET
          embedding_json = excluded.embedding_json,
          created_at = excluded.created_at
      `,
      [paperId, legacyPaperId]
    );
    await db.query(
      `
        INSERT INTO paper_chunk_embeddings(paper_chunk_id, model, embedding_json, created_at)
        SELECT pc.id, source_embedding.model, source_embedding.embedding_json, source_embedding.created_at
        FROM paper_chunks pc
        JOIN arxiv_text_chunks source_chunk
          ON source_chunk.paper_id = $1
         AND source_chunk.chunk_index = pc.chunk_index
        JOIN arxiv_chunk_embeddings source_embedding
          ON source_embedding.arxiv_chunk_id = source_chunk.id
        WHERE pc.paper_id = $2
        ON CONFLICT(paper_chunk_id, model) DO UPDATE SET
          embedding_json = excluded.embedding_json,
          created_at = excluded.created_at
      `,
      [legacyPaperId, paperId]
    );
  }
  return paperId;
}

async function reportArtifactRow(db, paperId) {
  const id = positiveId(paperId, "paper_id");
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
    [id, PAPER_REPORT_ARTIFACT_TYPE]
  );
  return { row: maybeOne(result) };
}

async function paperReportPayload(db, paperId) {
  const { row } = await reportArtifactRow(db, paperId);
  return paperReportPayloadFromRow(row, paperId);
}

async function sourceProjectIdsForPaper(db, paperId) {
  const result = await db.query(
    `
      SELECT r.project_id
      FROM project_paper_recommendations r
      JOIN research_projects rp ON rp.id = r.project_id
      WHERE r.paper_id = $1
        AND r.state IN ('pending', 'accepted')
        AND rp.status NOT IN ('paused', 'archived')
      ORDER BY r.project_id
    `,
    [Number(paperId)]
  );
  return parseIntegerList((result.rows || []).map((row) => row.project_id));
}

function reportContentForState({ paper, paperId, prompt, sourceProjectIds, errorMessage = "", startedAt = null, finishedAt = null }) {
  return {
    paper_id: Number(paperId),
    arxiv_id: paper.arxiv_id || "",
    link: paper.link || "",
    prompt: prompt || "",
    system_prompt: PAPER_READER_ANALYSIS_SYSTEM,
    source_project_ids: sourceProjectIds || [],
    error_message: errorMessage || "",
    started_at: startedAt,
    finished_at: finishedAt
  };
}

function reportSourceForState({ paperId, sourceTextHash = "" }) {
  return {
    source_key: `paper_report:${Number(paperId)}`,
    generated_from: "paper_report_queue",
    source_text_hash: sourceTextHash || ""
  };
}

async function upsertQueuedReport(db, paperId, prompt) {
  const paper = await findReaderPaper(db, paperId);
  const { row } = await reportArtifactRow(db, paperId);
  const existingContent = reportContent(row);
  const existingSource = reportSource(row);
  const sourceProjectIds = row
    ? sourceProjectIdsFromContent(existingContent)
    : await sourceProjectIdsForPaper(db, paperId);
  const sourceTextHash = existingSource.source_text_hash || row?.input_hash || "";
  const content = reportContentForState({
    paper,
    paperId,
    prompt,
    sourceProjectIds,
    startedAt: null,
    finishedAt: null
  });
  const source = reportSourceForState({ paperId, sourceTextHash });
  const now = nowIso();
  if (row) {
    await db.query(
      `
        UPDATE artifacts
        SET title = $1,
            content_markdown = '',
            content_json = $2,
            status = 'queued',
            source_json = $3,
            model_provider_id = '',
            model = '',
            input_hash = $4,
            updated_at = $5
        WHERE id = $6
      `,
      [
        paper.title || `Paper ${Number(paperId)} Full Report`,
        toJson(content),
        toJson(source),
        sourceTextHash,
        now,
        Number(row.id)
      ]
    );
    return { artifact_id: Number(row.id), paper_reports_requeued: row.status === "removed" ? 0 : 1, paper_reports_queued: row.status === "removed" ? 1 : 0 };
  }
  const inserted = await db.query(
    `
      INSERT INTO artifacts(
        scope_type, scope_id, artifact_type, title, content_markdown,
        content_json, status, source_json, model_provider_id, model,
        input_hash, created_at, updated_at
      )
      VALUES ('paper', $1, $2, $3, '', $4, 'queued', $5, '', '', $6, $7, $7)
      RETURNING id
    `,
    [
      paperId,
      PAPER_REPORT_ARTIFACT_TYPE,
      paper.title || `Paper ${Number(paperId)} Full Report`,
      toJson(content),
      toJson(source),
      sourceTextHash,
      now
    ]
  );
  return { artifact_id: Number(inserted.rows[0].id), paper_reports_queued: 1 };
}

async function reportPrompt() {
  const data = await getAppSettings();
  return text(data?.settings?.paper_reader_default_prompt) || DEFAULT_PAPER_READER_PROMPT;
}

export async function getReaderPaperDetail(paperId, db = { query }) {
  const id = positiveId(paperId, "paper_id");
  const paper = await findReaderPaper(db, id);
  const [
    evidenceRows,
    judgmentRows,
    recommendationRows,
    linkedProjectRows,
    feedbackRows,
    messageRows,
    referenceRows,
    report
  ] = await Promise.all([
    db.query(
      `
        SELECT
          m.chunk_id,
          m.arxiv_chunk_id,
          m.score,
          m.searchers_json,
          m.evidence_json,
          ac.chunk_index AS arxiv_chunk_index,
          ac.source AS arxiv_chunk_source,
          ac.page_start AS arxiv_page_start,
          ac.page_end AS arxiv_page_end,
          ac.text AS arxiv_text,
          c.heading,
          c.text,
          COALESCE(n.title, kd.title) AS note_title,
          COALESCE(n.path, kd.source_uri) AS note_path,
          kd.source_type AS context_source_type,
          kd.id AS context_document_id
        FROM matches m
        JOIN research_chunks c ON c.id = m.chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN knowledge_documents kd ON kd.id = c.document_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = m.arxiv_chunk_id
        WHERE m.paper_id IN (
          SELECT source_arxiv_paper_id
          FROM project_paper_recommendations
          WHERE paper_id = $1 AND source_arxiv_paper_id IS NOT NULL
          UNION
          SELECT ap.id
          FROM paper_sources ps
          JOIN arxiv_papers ap ON ap.arxiv_id = ps.source_identifier
          WHERE ps.paper_id = $1
        )
        ORDER BY m.score DESC
      `,
      [id]
    ),
    db.query(
      `
        SELECT
          j.project_id,
          rp.name AS project_name,
          j.relation_type,
          j.relevance_score,
          j.usefulness_score,
          j.confidence,
          j.suggested_action,
          j.reason,
          j.evidence_mapping_json,
          j.missing_evidence,
          j.updated_at
        FROM project_paper_judgments j
        JOIN research_projects rp ON rp.id = j.project_id
        WHERE j.paper_id IN (
          SELECT source_arxiv_paper_id
          FROM project_paper_recommendations
          WHERE paper_id = $1 AND source_arxiv_paper_id IS NOT NULL
          UNION
          SELECT ap.id
          FROM paper_sources ps
          JOIN arxiv_papers ap ON ap.arxiv_id = ps.source_identifier
          WHERE ps.paper_id = $1
        )
        ORDER BY
          CASE j.relation_type WHEN 'direct' THEN 0 WHEN 'indirect' THEN 1 WHEN 'weak' THEN 2 ELSE 3 END,
          j.usefulness_score DESC,
          j.confidence DESC
      `,
      [id]
    ),
    db.query(
      `
        SELECT
          r.project_id,
          rp.name AS project_name,
          rp.obsidian_project_path,
          rp.obsidian_folder,
          r.state,
          r.importance,
          r.relation_type,
          r.reason,
          r.obsidian_path,
          r.attachment_path,
          r.source_judgment_hash,
          r.synced_at,
          r.updated_at,
          j.relevance_score,
          j.usefulness_score,
          j.confidence
        FROM project_paper_recommendations r
        JOIN research_projects rp ON rp.id = r.project_id
        LEFT JOIN project_paper_judgments j
          ON j.project_id = r.project_id AND j.paper_id = r.source_arxiv_paper_id
        WHERE r.paper_id = $1
        ORDER BY
          CASE r.state WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
          CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
          COALESCE(j.usefulness_score, 0) DESC,
          rp.name
      `,
      [id]
    ),
    db.query(
      `
        SELECT
          pp.project_id,
          rp.name AS project_name,
          rp.obsidian_project_path,
          rp.obsidian_folder,
          pp.relation,
          pp.note,
          pp.updated_at
        FROM project_papers pp
        JOIN research_projects rp ON rp.id = pp.project_id
        WHERE pp.paper_id = $1
          AND NOT (pp.relation = 'candidate' AND pp.note = $2)
        ORDER BY pp.updated_at DESC, rp.name
      `,
      [id, AUTO_MATCH_NOTE]
    ),
    db.query(
      "SELECT status, note, updated_at FROM user_feedback WHERE paper_id = $1 ORDER BY updated_at DESC",
      [id]
    ),
    db.query(
      `
        SELECT id, library_paper_id, role, content, source, model_provider_id, model, context_json, created_at
        FROM paper_reader_messages
        WHERE library_paper_id = $1
        ORDER BY id
      `,
      [id]
    ),
    db.query(
      `
        SELECT
          p.id AS paper_id,
          p.arxiv_id,
          p.title,
          COALESCE(text_asset.status, 'pending') AS text_status,
          COALESCE((text_asset.metadata_json::jsonb ->> 'char_count')::bigint, 0) AS text_char_count,
          r.position,
          r.updated_at
        FROM paper_reader_references r
        JOIN papers p ON p.id = r.reference_paper_id
        LEFT JOIN LATERAL (
          SELECT pa.status, pa.metadata_json
          FROM paper_assets pa
          WHERE pa.paper_id = p.id AND pa.asset_type = 'text'
          ORDER BY CASE WHEN pa.status = 'complete' AND pa.path != '' THEN 0 ELSE 1 END,
                   pa.updated_at DESC, pa.id DESC
          LIMIT 1
        ) text_asset ON TRUE
        WHERE r.paper_id = $1
        ORDER BY r.position, p.id
      `,
      [id]
    ),
    paperReportPayload(db, id)
  ]);
  return {
    paper: paperPayload(paper),
    explanation: null,
    project_judgments: (judgmentRows.rows || []).map((row) => ({
      project_id: Number(row.project_id),
      project_name: row.project_name || "",
      relation_type: row.relation_type || "",
      relevance_score: numberValue(row.relevance_score),
      usefulness_score: numberValue(row.usefulness_score),
      confidence: numberValue(row.confidence),
      suggested_action: row.suggested_action || "",
      reason: row.reason || "",
      evidence_mapping: parseJson(row.evidence_mapping_json, []),
      missing_evidence: row.missing_evidence || "",
      updated_at: row.updated_at || ""
    })),
    project_recommendations: (recommendationRows.rows || []).map((row) => ({
      project_id: Number(row.project_id),
      project_name: row.project_name || "",
      obsidian_project_path: row.obsidian_project_path || "",
      obsidian_folder: row.obsidian_folder || "",
      state: row.state || "",
      importance: row.importance || "",
      relation_type: row.relation_type || "",
      reason: row.reason || "",
      obsidian_path: row.obsidian_path || "",
      attachment_path: row.attachment_path || "",
      source_judgment_hash: row.source_judgment_hash || "",
      synced_at: row.synced_at || null,
      updated_at: row.updated_at || "",
      relevance_score: numberValue(row.relevance_score),
      usefulness_score: numberValue(row.usefulness_score),
      confidence: numberValue(row.confidence)
    })),
    linked_projects: (linkedProjectRows.rows || []).map((row) => ({
      project_id: Number(row.project_id),
      project_name: row.project_name || "",
      obsidian_project_path: row.obsidian_project_path || "",
      obsidian_folder: row.obsidian_folder || "",
      relation: row.relation || "",
      note: row.note || "",
      updated_at: row.updated_at || ""
    })),
    paper_report: report,
    evidence: (evidenceRows.rows || []).map((row) => ({
      chunk_id: Number(row.chunk_id),
      arxiv_chunk_id: row.arxiv_chunk_id === null || row.arxiv_chunk_id === undefined ? null : Number(row.arxiv_chunk_id),
      score: numberValue(row.score),
      searchers: parseJson(row.searchers_json, []),
      match_evidence: parseJson(row.evidence_json, {}),
      arxiv_chunk_index: row.arxiv_chunk_index,
      arxiv_chunk_source: row.arxiv_chunk_source,
      arxiv_page_start: row.arxiv_page_start,
      arxiv_page_end: row.arxiv_page_end,
      arxiv_text: row.arxiv_text,
      heading: row.heading,
      text: row.text,
      note_title: row.note_title,
      note_path: row.note_path,
      context_source_type: row.context_source_type,
      context_document_id: row.context_document_id === null || row.context_document_id === undefined ? null : Number(row.context_document_id)
    })),
    feedback: (feedbackRows.rows || []).map((row) => ({
      status: row.status || "",
      note: row.note || "",
      updated_at: row.updated_at || ""
    })),
    reference_papers: (referenceRows.rows || []).map((row) => ({
      paper_id: Number(row.paper_id),
      arxiv_id: row.arxiv_id || "",
      title: row.title || "",
      text_status: row.text_status || "",
      text_char_count: numberValue(row.text_char_count),
      position: numberValue(row.position),
      updated_at: row.updated_at || ""
    })),
    reader_messages: [...reportSeedMessages(report, id), ...(messageRows.rows || []).map(messagePayload)]
  };
}

export async function saveReaderReferencePapers(paperId, payload = {}) {
  const id = positiveId(paperId, "paper_id");
  const rawIds = Array.isArray(payload.paper_ids) ? payload.paper_ids : [];
  const referenceIds = [...new Set(rawIds.map((value) => positiveId(value, "reference_paper_id")))];
  if (referenceIds.length > 3) throw new ValidationError("At most 3 reference papers can be selected");
  if (referenceIds.includes(id)) throw new ValidationError("A paper cannot reference itself");

  await withTransaction(async (client) => {
    await findReaderPaper(client, id);
    if (referenceIds.length) {
      const result = await client.query(
        `
          SELECT
            p.id,
            COALESCE(text_asset.status, 'pending') AS text_status,
            COALESCE(text_asset.path, '') AS text_path
          FROM papers p
          LEFT JOIN LATERAL (
            SELECT pa.status, pa.path
            FROM paper_assets pa
            WHERE pa.paper_id = p.id AND pa.asset_type = 'text'
            ORDER BY CASE WHEN pa.status = 'complete' AND pa.path != '' THEN 0 ELSE 1 END,
                     pa.updated_at DESC, pa.id DESC
            LIMIT 1
          ) text_asset ON TRUE
          WHERE p.id = ANY($1::bigint[])
        `,
        [referenceIds]
      );
      if ((result.rows || []).length !== referenceIds.length) {
        throw new ValidationError("One or more reference papers do not exist");
      }
      const unavailable = (result.rows || []).find(
        (row) => row.text_status !== "complete" || !text(row.text_path)
      );
      if (unavailable) throw new ValidationError("Reference paper full text is not available");
    }
    await client.query("DELETE FROM paper_reader_references WHERE paper_id = $1", [id]);
    const now = nowIso();
    for (const [position, referenceId] of referenceIds.entries()) {
      await client.query(
        `
          INSERT INTO paper_reader_references(
            paper_id, reference_paper_id, position, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $4)
        `,
        [id, referenceId, position, now]
      );
    }
  });
  return { ...(await getReaderPaperDetail(id)), ok: true };
}

export async function getReaderPaperPdfPath(paperId, db = { query }) {
  const paper = await findReaderPaper(db, paperId);
  return { pdf_path: paper.pdf_path || "" };
}

export async function deleteReaderMessage(paperId, messageId) {
  const id = positiveId(paperId, "paper_id");
  const message = positiveId(messageId, "message_id");
  await withTransaction(async (client) => {
    const result = await client.query(
      "DELETE FROM paper_reader_messages WHERE id = $1 AND library_paper_id = $2",
      [message, id]
    );
    if (!result.rowCount) throw new NotFoundError("Message not found");
  });
  const detail = await getReaderPaperDetail(id);
  return { ...detail, ok: true };
}

export async function cancelReaderReport(paperId) {
  const id = positiveId(paperId, "paper_id");
  await withTransaction(async (client) => {
    const { row } = await reportArtifactRow(client, id);
    if (!row || row.status === "removed") throw new NotFoundError("Report queue item was not found");
    if (row.status === "processing") throw new ConflictError("Processing reports cannot be cancelled");
    if (row.status !== "queued") return;
    const content = { ...reportContent(row), error_message: "", finished_at: nowIso() };
    await client.query(
      `
        UPDATE artifacts
        SET status = 'cancelled',
            content_json = $1,
            updated_at = $2
        WHERE id = $3
      `,
      [toJson(content), content.finished_at, Number(row.id)]
    );
  });
  const detail = await getReaderPaperDetail(id);
  return { ...detail, ok: true };
}

export async function retryReaderReport(paperId) {
  const id = positiveId(paperId, "paper_id");
  const prompt = await reportPrompt();
  await withTransaction(async (client) => {
    await upsertQueuedReport(client, id, prompt);
  });
  const detail = await getReaderPaperDetail(id);
  return { ...detail, ok: true };
}

export async function deleteReaderReport(paperId) {
  const id = positiveId(paperId, "paper_id");
  return withTransaction(async (client) => {
    const { row } = await reportArtifactRow(client, id);
    if (!row || row.status === "removed") {
      return { ok: true, paper_id: id, paper_reports_removed: 0 };
    }
    if (row.status === "processing") throw new ConflictError("Processing reports cannot be removed from the queue");
    const content = {
      ...reportContent(row),
      error_message: "",
      started_at: null,
      finished_at: nowIso()
    };
    await client.query(
      `
        UPDATE artifacts
        SET status = 'removed',
            content_json = $1,
            updated_at = $2
        WHERE id = $3
      `,
      [toJson(content), content.finished_at, Number(row.id)]
    );
    return { ok: true, paper_id: id, artifact_id: Number(row.id), paper_reports_removed: 1 };
  });
}

export const READER_REPORT_STATUSES = REPORT_STATUSES;
