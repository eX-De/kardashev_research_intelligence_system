import { NotFoundError, ValidationError, maybeOne, parseJson, query } from "./db.js";

function text(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function optionalPositiveInteger(value, field) {
  const raw = text(value);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return parsed;
}

export function normalizeArtifactLimit(value, fallback = 100) {
  const raw = text(value) || String(fallback);
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new ValidationError("limit must be an integer");
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) {
    throw new ValidationError("limit must be at least 1");
  }
  return parsed;
}

export function normalizeArtifactOffset(value, fallback = 0) {
  const raw = text(value) || String(fallback);
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError("offset must be a non-negative integer");
  }
  return Number.parseInt(raw, 10);
}

function artifactPayload(row) {
  return {
    id: Number(row.id),
    scope_type: row.scope_type,
    scope_id: row.scope_id === null || row.scope_id === undefined ? null : Number(row.scope_id),
    artifact_type: row.artifact_type,
    title: row.title,
    content_markdown: row.content_markdown || "",
    content_json: parseJson(row.content_json, {}),
    status: row.status,
    source: parseJson(row.source_json, {}),
    model_provider_id: row.model_provider_id || "",
    model: row.model || "",
    input_hash: row.input_hash || "",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function dailyReportArxivIds(artifact) {
  if (artifact?.artifact_type !== "daily_report") return [];
  const candidates = Array.isArray(artifact.source?.project_candidates)
    ? artifact.source.project_candidates
    : [];
  return [...new Set(candidates.map((candidate) => text(candidate?.arxiv_id)).filter(Boolean))];
}

async function relatedDailyPapers(artifact, db) {
  const arxivIds = dailyReportArxivIds(artifact);
  if (!arxivIds.length) return [];
  const result = await db.query(
    `
      SELECT
        p.id,
        p.arxiv_id,
        p.title,
        p.link,
        p.published_at,
        lp.id AS library_paper_id,
        r.project_id,
        rp.name AS project_name,
        r.state,
        r.relation_type,
        r.reason,
        r.updated_at
      FROM arxiv_papers p
      JOIN project_paper_recommendations r ON r.source_arxiv_paper_id = p.id
      JOIN research_projects rp ON rp.id = r.project_id
      JOIN papers lp ON lp.id = r.paper_id
      WHERE p.arxiv_id = ANY($1::text[])
        AND r.state IN ('pending', 'accepted')
        AND NOT EXISTS (
          SELECT 1 FROM arxiv_paper_tombstones t
          WHERE t.arxiv_id = p.arxiv_id
        )
        AND (
          r.state = 'accepted'
          OR (
            NOT EXISTS (
              SELECT 1
              FROM papers hidden_lp
              WHERE hidden_lp.arxiv_id = p.arxiv_id
                AND hidden_lp.library_status IN ('archived', 'discarded')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM paper_sources ps
              JOIN papers hidden_lp ON hidden_lp.id = ps.paper_id
              WHERE ps.source_type = 'arxiv'
                AND ps.source_identifier = p.arxiv_id
                AND hidden_lp.library_status IN ('archived', 'discarded')
            )
          )
        )
      ORDER BY
        p.id,
        CASE r.state WHEN 'pending' THEN 0 ELSE 1 END,
        CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
        r.updated_at DESC,
        rp.name
    `,
    [arxivIds]
  );

  const papersByArxivId = new Map();
  for (const row of result.rows || []) {
    const arxivId = text(row.arxiv_id);
    if (!arxivId) continue;
    let paper = papersByArxivId.get(arxivId);
    if (!paper) {
      paper = {
        id: Number(row.id),
        arxiv_id: arxivId,
        title: row.title || arxivId,
        link: row.link || "",
        published_at: row.published_at || "",
        library_paper_id: Number(row.library_paper_id) || null,
        state: row.state === "pending" ? "pending" : "assigned",
        relation_type: row.relation_type || "",
        reason: row.reason || "",
        projects: []
      };
      papersByArxivId.set(arxivId, paper);
    }
    const projectId = Number(row.project_id);
    if (projectId > 0 && !paper.projects.some((project) => project.project_id === projectId)) {
      paper.projects.push({
        project_id: projectId,
        project_name: row.project_name || `项目 #${projectId}`,
        state: row.state === "pending" ? "pending" : "assigned"
      });
    }
    if (row.state === "pending") paper.state = "pending";
    if (!paper.library_paper_id && Number(row.library_paper_id) > 0) {
      paper.library_paper_id = Number(row.library_paper_id);
    }
  }

  return arxivIds.map((arxivId) => papersByArxivId.get(arxivId)).filter(Boolean);
}

export function normalizeArtifactsFilter(params = {}) {
  return {
    scope_type: text(params.scope_type),
    scope_id: optionalPositiveInteger(params.scope_id, "scope_id"),
    artifact_type: text(params.artifact_type),
    status: text(params.status),
    limit: normalizeArtifactLimit(params.limit, 100),
    offset: normalizeArtifactOffset(params.offset, 0)
  };
}

export async function getArtifacts(params = {}, db = { query }) {
  const filter = normalizeArtifactsFilter(params);
  const conditions = [];
  const values = [];

  if (filter.scope_type) {
    values.push(filter.scope_type);
    conditions.push(`scope_type = $${values.length}`);
  }
  if (filter.scope_id !== null) {
    values.push(filter.scope_id);
    conditions.push(`scope_id = $${values.length}`);
  }
  if (filter.artifact_type) {
    values.push(filter.artifact_type);
    conditions.push(`artifact_type = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total FROM artifacts ${where}`,
    [...values]
  );
  const total = Number(countResult.rows[0]?.total || 0);
  values.push(filter.limit);
  const limitPlaceholder = `$${values.length}`;
  values.push(filter.offset);
  const offsetPlaceholder = `$${values.length}`;
  const result = await db.query(
    `
      SELECT *
      FROM artifacts
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limitPlaceholder}
      OFFSET ${offsetPlaceholder}
    `,
    values
  );
  return { items: result.rows.map(artifactPayload), total };
}

export async function getArtifactDetail(artifactId, db = { query }) {
  const id = optionalPositiveInteger(artifactId, "artifact_id");
  if (!id) throw new ValidationError("artifact_id is required");
  const result = await db.query("SELECT * FROM artifacts WHERE id = $1", [id]);
  const row = maybeOne(result);
  if (!row) throw new NotFoundError(`Artifact not found: ${id}`);
  const artifact = artifactPayload(row);
  artifact.related_papers = await relatedDailyPapers(artifact, db);
  return { artifact };
}
