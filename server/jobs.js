import { parseJson, query, ValidationError } from "./db.js";

export function normalizeJobLimit(value, fallback = 20) {
  const raw = value === null || value === undefined || String(value).trim() === ""
    ? fallback
    : value;
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new ValidationError("limit must be an integer");
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < 0) {
    throw new ValidationError("limit must be at least 0");
  }
  return parsed;
}

function historyRow(row) {
  return {
    id: Number(row.id),
    job_type: row.job_type,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    message: row.message,
    pid: row.pid ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    meta: parseJson(row.meta_json, {})
  };
}

function latestJobRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    job_type: row.job_type,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    message: row.message,
    heartbeat_at: row.heartbeat_at
  };
}

export async function getJobHistory(limit = 20) {
  const normalizedLimit = normalizeJobLimit(limit, 20);
  const result = await query(
    `
      SELECT id, job_type, status, started_at, finished_at, message, pid, heartbeat_at, meta_json
      FROM job_runs
      ORDER BY id DESC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return { items: result.rows.map(historyRow) };
}

export async function getJobSummary() {
  const latestResult = await query(`
    SELECT id, job_type, status, started_at, finished_at, message, heartbeat_at
    FROM job_runs
    ORDER BY id DESC
    LIMIT 1
  `);
  const runningResult = await query("SELECT COUNT(*) AS count FROM job_runs WHERE status = 'running'");
  const runningCount = Number(runningResult.rows?.[0]?.count || 0);
  return {
    running_count: runningCount,
    latest_job: latestJobRow(latestResult.rows?.[0] || null)
  };
}
