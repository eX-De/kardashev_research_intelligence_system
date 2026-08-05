import { parseJson, query, ValidationError } from "./db.js";

const DAILY_JOB_SQL = "'run-daily', 'resume-daily', 'retry-daily'";

export function normalizeJobLimit(value, fallback = 20) {
  const raw = value === null || value === undefined || String(value).trim() === ""
    ? fallback
    : value;
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new ValidationError("limit must be an integer");
  const parsed = Number.parseInt(text, 10);
  if (parsed < 0) throw new ValidationError("limit must be at least 0");
  return parsed;
}

function historyRow(row) {
  const meta = parseJson(row.meta_json, {});
  const workerJobId = row.worker_job_id === null || row.worker_job_id === undefined
    ? null
    : Number(row.worker_job_id);
  const jobRunId = row.job_run_id === null || row.job_run_id === undefined
    ? null
    : Number(row.job_run_id);
  const recordType = String(row.record_type || "worker_job");
  const message = String(
    row.message
    || row.error_message
    || (meta && typeof meta === "object" && !Array.isArray(meta) ? meta.message : "")
    || ""
  );
  return {
    id: Number(row.id),
    record_type: recordType,
    worker_job_id: workerJobId,
    job_run_id: jobRunId,
    job_type: row.job_type,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    message,
    pid: row.pid ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    meta
  };
}

export async function getJobHistory(limit = 20) {
  const normalizedLimit = normalizeJobLimit(limit, 20);
  const result = await query(
    `
      WITH task_history AS (
        SELECT
          wj.id AS id,
          'worker_job'::text AS record_type,
          wj.id AS worker_job_id,
          wj.job_run_id,
          wj.job_type,
          wj.status,
          COALESCE(wj.started_at, wj.created_at) AS started_at,
          wj.finished_at,
          ''::text AS message,
          wj.error_message,
          NULL::integer AS pid,
          wj.locked_at AS heartbeat_at,
          wj.result_json AS meta_json,
          COALESCE(wj.finished_at, wj.started_at, wj.created_at) AS activity_at
        FROM worker_jobs wj
        WHERE wj.job_type NOT IN (${DAILY_JOB_SQL})

        UNION ALL

        SELECT
          jr.id AS id,
          'daily_run'::text AS record_type,
          (
            SELECT MAX(wj.id)
            FROM worker_jobs wj
            WHERE wj.job_run_id = jr.id
              AND wj.job_type IN (${DAILY_JOB_SQL})
          ) AS worker_job_id,
          jr.id AS job_run_id,
          jr.job_type,
          jr.status,
          jr.started_at,
          jr.finished_at,
          jr.message,
          ''::text AS error_message,
          jr.pid,
          jr.heartbeat_at,
          jr.meta_json,
          COALESCE(jr.finished_at, jr.started_at) AS activity_at
        FROM job_runs jr
        WHERE jr.job_type IN (${DAILY_JOB_SQL})

        UNION ALL

        SELECT
          jr.id AS id,
          'worker_job'::text AS record_type,
          NULL::bigint AS worker_job_id,
          jr.id AS job_run_id,
          jr.job_type,
          jr.status,
          jr.started_at,
          jr.finished_at,
          jr.message,
          ''::text AS error_message,
          jr.pid,
          jr.heartbeat_at,
          jr.meta_json,
          COALESCE(jr.finished_at, jr.started_at) AS activity_at
        FROM job_runs jr
        WHERE jr.job_type NOT IN (${DAILY_JOB_SQL})
          AND NOT EXISTS (
            SELECT 1 FROM worker_jobs wj WHERE wj.job_run_id = jr.id
          )
      )
      SELECT id, record_type, worker_job_id, job_run_id, job_type, status,
             started_at, finished_at, message, error_message, pid, heartbeat_at, meta_json
      FROM task_history
      ORDER BY activity_at DESC NULLS LAST, id DESC, record_type
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return { items: result.rows.map(historyRow) };
}

export async function getJobSummary() {
  const [history, countsResult] = await Promise.all([
    getJobHistory(1),
    query(`
      SELECT
        (
          SELECT COUNT(*) FROM worker_jobs
          WHERE status = 'running' AND job_type NOT IN (${DAILY_JOB_SQL})
        ) AS worker_running_count,
        (
          SELECT COUNT(*) FROM job_runs
          WHERE status = 'running' AND job_type IN (${DAILY_JOB_SQL})
        ) AS daily_running_count,
        (
          SELECT COUNT(*) FROM job_runs jr
          WHERE jr.status = 'running'
            AND jr.job_type NOT IN (${DAILY_JOB_SQL})
            AND NOT EXISTS (SELECT 1 FROM worker_jobs wj WHERE wj.job_run_id = jr.id)
        ) AS legacy_running_count
    `)
  ]);
  const counts = countsResult.rows?.[0] || {};
  const workerRunningCount = Number(counts.worker_running_count || 0) + Number(counts.legacy_running_count || 0);
  const dailyRunningCount = Number(counts.daily_running_count || 0);
  return {
    running_count: workerRunningCount + dailyRunningCount,
    worker_running_count: workerRunningCount,
    daily_running_count: dailyRunningCount,
    latest_job: history.items[0] || null
  };
}
