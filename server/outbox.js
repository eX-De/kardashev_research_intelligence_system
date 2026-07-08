import { parseJson, query, toJson, ValidationError } from "./db.js";

function isoNow() {
  return new Date().toISOString();
}

function cleanEventType(value) {
  const eventType = String(value || "").trim();
  if (!eventType) throw new ValidationError("event_type is required");
  return eventType;
}

function positiveEventIds(ids) {
  if (!Array.isArray(ids)) throw new ValidationError("event ids must be an array");
  const normalized = ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  if (normalized.length !== ids.length) throw new ValidationError("event ids must be positive integers");
  return [...new Set(normalized)];
}

function appEventRow(row) {
  return {
    id: Number(row.id),
    event_type: row.event_type,
    payload: parseJson(row.payload_json, {}),
    created_at: row.created_at,
    published_at: row.published_at ?? null
  };
}

export async function insertAppEvent(eventType, payload = {}, { createdAt = isoNow(), client = null } = {}) {
  const db = client || { query };
  const result = await db.query(
    `
      INSERT INTO app_events(event_type, payload_json, created_at)
      VALUES ($1, $2, $3)
      RETURNING id, event_type, payload_json, created_at, published_at
    `,
    [cleanEventType(eventType), toJson(payload || {}), createdAt]
  );
  return appEventRow(result.rows[0]);
}

export async function listUnpublishedAppEvents(limit = 100) {
  const rawLimit = limit === null || limit === undefined || String(limit).trim() === "" ? 100 : limit;
  const normalizedLimit = Number.parseInt(String(rawLimit), 10);
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new ValidationError("limit must be a positive integer");
  }
  const result = await query(
    `
      SELECT id, event_type, payload_json, created_at, published_at
      FROM app_events
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return result.rows.map(appEventRow);
}

export async function markAppEventsPublished(ids, { publishedAt = isoNow() } = {}) {
  const normalizedIds = positiveEventIds(ids);
  if (!normalizedIds.length) return { published: [] };
  const result = await query(
    `
      UPDATE app_events
      SET published_at = $1
      WHERE id = ANY($2::bigint[])
        AND published_at IS NULL
      RETURNING id
    `,
    [publishedAt, normalizedIds]
  );
  return { published: result.rows.map((row) => Number(row.id)) };
}
