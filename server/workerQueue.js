import { parseJson, query, toJson, ValidationError, withTransaction } from "./db.js";
import { SERVER_EVENTS, compactTaskEventPayload } from "./events.js";
import { insertAppEvent } from "./outbox.js";

const WORKER_JOB_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);

function isoNow() {
  return new Date().toISOString();
}

function cleanJobType(value) {
  const jobType = String(value || "").trim();
  if (!jobType) throw new ValidationError("job_type is required");
  return jobType;
}

function cleanStatus(value) {
  const status = String(value || "").trim();
  if (!WORKER_JOB_STATUSES.has(status)) throw new ValidationError("invalid worker job status");
  return status;
}

function cleanPriority(value) {
  const priority = Number.parseInt(String(value ?? 0), 10);
  if (!Number.isInteger(priority)) throw new ValidationError("priority must be an integer");
  return priority;
}

function cleanMaxAttempts(value) {
  const maxAttempts = Number.parseInt(String(value ?? 1), 10);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ValidationError("max_attempts must be a positive integer");
  }
  return maxAttempts;
}

function cleanWorkerId(value) {
  const workerId = String(value || "").trim();
  if (!workerId) throw new ValidationError("worker_id is required");
  return workerId;
}

function workerJobRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    job_run_id: row.job_run_id === null || row.job_run_id === undefined ? null : Number(row.job_run_id),
    job_type: row.job_type,
    status: row.status,
    priority: Number(row.priority || 0),
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, {}),
    error_message: row.error_message || "",
    attempts: Number(row.attempts || 0),
    max_attempts: Number(row.max_attempts || 1),
    run_after: row.run_after ?? null,
    locked_by: row.locked_by || "",
    locked_at: row.locked_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null
  };
}

function jobRunRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    job_type: row.job_type,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    message: row.message || "",
    pid: row.pid ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    meta: parseJson(row.meta_json, {})
  };
}

function staleCutoff(now, staleAfterSeconds) {
  const parsedNow = new Date(now);
  const base = Number.isFinite(parsedNow.getTime()) ? parsedNow : new Date();
  return new Date(base.getTime() - Math.max(1, Number(staleAfterSeconds) || 1) * 1000).toISOString();
}

async function updateJobRunForWorkerJob(client, workerJob, status, { now, message = "" } = {}) {
  if (!workerJob?.job_run_id) return null;
  const result = await client.query(
    `
      UPDATE job_runs
      SET status = $1,
          finished_at = CASE WHEN $1 IN ('completed', 'failed', 'cancelled') THEN $2 ELSE finished_at END,
          message = $3,
          heartbeat_at = $2
      WHERE id = $4
      RETURNING id, job_type, status, started_at, finished_at, message, pid, heartbeat_at, meta_json
    `,
    [status, now, message, workerJob.job_run_id]
  );
  return jobRunRow(result.rows[0]);
}

export async function enqueueWorkerJob({
  jobType,
  payload = {},
  priority = 0,
  runAfter = null,
  maxAttempts = 1,
  message = "Queued",
  now = isoNow()
} = {}) {
  const normalizedJobType = cleanJobType(jobType);
  const normalizedPriority = cleanPriority(priority);
  const normalizedMaxAttempts = cleanMaxAttempts(maxAttempts);
  return withTransaction(async (client) => {
    const jobRunResult = await client.query(
      `
        INSERT INTO job_runs(job_type, status, started_at, message, heartbeat_at, meta_json)
        VALUES ($1, 'queued', $2, $3, $2, $4)
        RETURNING id, job_type, status, started_at, finished_at, message, pid, heartbeat_at, meta_json
      `,
      [
        normalizedJobType,
        now,
        message,
        toJson({
          queued: true,
          worker_job: true,
          queued_at: now
        })
      ]
    );
    const jobRun = jobRunRow(jobRunResult.rows[0]);
    const workerJobResult = await client.query(
      `
        INSERT INTO worker_jobs(
          job_run_id, job_type, status, priority, payload_json, max_attempts,
          run_after, created_at, updated_at
        )
        VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $7)
        RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                  error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                  created_at, updated_at, started_at, finished_at
      `,
      [
        jobRun.id,
        normalizedJobType,
        normalizedPriority,
        toJson(payload || {}),
        normalizedMaxAttempts,
        runAfter,
        now
      ]
    );
    return { job_run: jobRun, worker_job: workerJobRow(workerJobResult.rows[0]) };
  });
}

export async function countActiveWorkerJobs(jobType = "") {
  const params = [];
  let filter = "";
  if (String(jobType || "").trim()) {
    params.push(cleanJobType(jobType));
    filter = "AND job_type = $1";
  }
  const result = await query(
    `
      SELECT COUNT(*) AS count
      FROM worker_jobs
      WHERE status IN ('queued', 'running')
      ${filter}
    `,
    params
  );
  return Number(result.rows?.[0]?.count || 0);
}

export async function claimNextWorkerJob({ workerId, now = isoNow() } = {}) {
  const normalizedWorkerId = cleanWorkerId(workerId);
  return withTransaction(async (client) => {
    const claimable = await client.query(
      `
        SELECT id, job_run_id, job_type, status, priority, payload_json, result_json,
               error_message, attempts, max_attempts, run_after, locked_by, locked_at,
               created_at, updated_at, started_at, finished_at
        FROM worker_jobs
        WHERE status = 'queued'
          AND attempts < max_attempts
          AND (run_after IS NULL OR run_after <= $1)
        ORDER BY priority DESC, run_after NULLS FIRST, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
      [now]
    );
    const queued = claimable.rows[0];
    if (!queued) return null;
    const claimedResult = await client.query(
      `
        UPDATE worker_jobs
        SET status = 'running',
            attempts = attempts + 1,
            locked_by = $1,
            locked_at = $2,
            started_at = COALESCE(started_at, $2),
            updated_at = $2
        WHERE id = $3
        RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                  error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                  created_at, updated_at, started_at, finished_at
      `,
      [normalizedWorkerId, now, queued.id]
    );
    const workerJob = workerJobRow(claimedResult.rows[0]);
    const jobRun = await updateJobRunForWorkerJob(
      client,
      workerJob,
      "running",
      { now, message: `Claimed by worker ${normalizedWorkerId}` }
    );
    return { worker_job: workerJob, job_run: jobRun };
  });
}

export async function completeWorkerJob(workerJobId, result = {}, { message = "Worker job completed", now = isoNow() } = {}) {
  const id = Number(workerJobId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("worker job id must be a positive integer");
  return withTransaction(async (client) => {
    const updated = await client.query(
      `
        UPDATE worker_jobs
        SET status = 'completed',
            result_json = $1,
            error_message = '',
            finished_at = $2,
            updated_at = $2
        WHERE id = $3
        RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                  error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                  created_at, updated_at, started_at, finished_at
      `,
      [toJson(result || {}), now, id]
    );
    const workerJob = workerJobRow(updated.rows[0]);
    const jobRun = await updateJobRunForWorkerJob(client, workerJob, "completed", { now, message });
    return { worker_job: workerJob, job_run: jobRun };
  });
}

export async function failWorkerJob(workerJobId, errorMessage, { now = isoNow() } = {}) {
  const id = Number(workerJobId);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("worker job id must be a positive integer");
  const message = String(errorMessage || "Worker job failed");
  return withTransaction(async (client) => {
    const updated = await client.query(
      `
        UPDATE worker_jobs
        SET status = 'failed',
            error_message = $1,
            finished_at = $2,
            updated_at = $2
        WHERE id = $3
        RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                  error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                  created_at, updated_at, started_at, finished_at
      `,
      [message, now, id]
    );
    const workerJob = workerJobRow(updated.rows[0]);
    const jobRun = await updateJobRunForWorkerJob(client, workerJob, "failed", { now, message });
    return { worker_job: workerJob, job_run: jobRun };
  });
}

export async function cleanupStaleWorkerJobs({
  staleAfterSeconds = 30 * 60,
  limit = 100,
  now = isoNow()
} = {}) {
  const normalizedLimit = Number.parseInt(String(limit), 10);
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new ValidationError("limit must be a positive integer");
  }
  const cutoff = staleCutoff(now, staleAfterSeconds);
  return withTransaction(async (client) => {
    const stale = await client.query(
      `
        SELECT id, job_run_id, job_type, status, priority, payload_json, result_json,
               error_message, attempts, max_attempts, run_after, locked_by, locked_at,
               created_at, updated_at, started_at, finished_at
        FROM worker_jobs
        WHERE status = 'running'
          AND (locked_at IS NULL OR locked_at < $1)
        ORDER BY locked_at NULLS FIRST, id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      `,
      [cutoff, normalizedLimit]
    );
    const result = {
      stale_worker_jobs_checked: stale.rows.length,
      stale_worker_jobs_requeued: 0,
      stale_worker_jobs_failed: 0
    };
    for (const row of stale.rows) {
      const current = workerJobRow(row);
      const attempts = Number(current.attempts || 0);
      const maxAttempts = Number(current.max_attempts || 1);
      const exhausted = attempts >= maxAttempts;
      const message = exhausted
        ? `Marked stale worker job failed after ${attempts}/${maxAttempts} attempts`
        : `Requeued stale worker job after ${attempts}/${maxAttempts} attempts`;
      if (exhausted) {
        const failed = await client.query(
          `
            UPDATE worker_jobs
            SET status = 'failed',
                error_message = $1,
                locked_by = '',
                locked_at = NULL,
                finished_at = $2,
                updated_at = $2
            WHERE id = $3
            RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                      error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                      created_at, updated_at, started_at, finished_at
          `,
          [message, now, current.id]
        );
        const workerJob = workerJobRow(failed.rows[0]);
        await updateJobRunForWorkerJob(client, workerJob, "failed", { now, message });
        await insertAppEvent(
          SERVER_EVENTS.TASK_FAILED,
          compactTaskEventPayload(workerJob, { status: "failed", stale: true, message }),
          { createdAt: now, client }
        );
        result.stale_worker_jobs_failed += 1;
      } else {
        const requeued = await client.query(
          `
            UPDATE worker_jobs
            SET status = 'queued',
                error_message = '',
                locked_by = '',
                locked_at = NULL,
                updated_at = $1
            WHERE id = $2
            RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                      error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                      created_at, updated_at, started_at, finished_at
          `,
          [now, current.id]
        );
        const workerJob = workerJobRow(requeued.rows[0]);
        await updateJobRunForWorkerJob(client, workerJob, "queued", { now, message });
        await insertAppEvent(
          SERVER_EVENTS.TASK_STARTED,
          compactTaskEventPayload(workerJob, { status: "queued", stale: true, message }),
          { createdAt: now, client }
        );
        result.stale_worker_jobs_requeued += 1;
      }
    }
    return result;
  });
}

export function workerJobStatus(value) {
  return cleanStatus(value);
}
