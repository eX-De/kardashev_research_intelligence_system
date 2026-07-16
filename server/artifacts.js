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
  return { artifact: artifactPayload(row) };
}
