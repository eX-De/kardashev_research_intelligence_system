import { parseJson, query, toJson, ValidationError, withTransaction } from "./db.js";
import { SERVER_EVENTS, compactTaskEventPayload } from "./events.js";
import { insertAppEvent } from "./outbox.js";
import { workerJobConcurrencyGroup } from "./workerJobInventory.js";

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

function cleanWorkerJobId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError("worker job id must be a positive integer");
  }
  return id;
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
    cancel_requested_at: row.cancel_requested_at ?? null,
    cancel_reason: row.cancel_reason || "",
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
  const queued = await withTransaction(async (client) => {
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
                  cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
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
    const workerJob = workerJobRow(workerJobResult.rows[0]);
    await insertAppEvent(
      SERVER_EVENTS.TASK_STARTED,
      compactTaskEventPayload(workerJob, { status: "queued", message }),
      { createdAt: now, client }
    );
    return { job_run: jobRun, worker_job: workerJob };
  });
  console.info(JSON.stringify({
    event: "worker_job.queued",
    worker_job_id: queued.worker_job?.id || null,
    job_type: normalizedJobType,
    worker_id: null,
    attempt: 0,
    concurrency_group: workerJobConcurrencyGroup(normalizedJobType),
    queue_wait_seconds: 0,
    handler_duration_seconds: null
  }));
  return queued;
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

export async function getWorkerJob(workerJobId) {
  const id = cleanWorkerJobId(workerJobId);
  const result = await query(
    `
      SELECT id, job_run_id, job_type, status, priority, payload_json, result_json,
             error_message, attempts, max_attempts, run_after, locked_by, locked_at,
             cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
      FROM worker_jobs
      WHERE id = $1
    `,
    [id]
  );
  return workerJobRow(result.rows?.[0]);
}

export async function listWorkerJobs({ status = "", jobType = "", limit = 100 } = {}) {
  const normalizedLimit = Number.parseInt(String(limit), 10);
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new ValidationError("limit must be a positive integer");
  }
  const params = [];
  const filters = [];
  if (String(status || "").trim()) {
    params.push(cleanStatus(status));
    filters.push(`status = $${params.length}`);
  }
  if (String(jobType || "").trim()) {
    params.push(cleanJobType(jobType));
    filters.push(`job_type = $${params.length}`);
  }
  params.push(normalizedLimit);
  const result = await query(
    `
      SELECT id, job_run_id, job_type, status, priority, payload_json, result_json,
             error_message, attempts, max_attempts, run_after, locked_by, locked_at,
             cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
      FROM worker_jobs
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT $${params.length}
    `,
    params
  );
  return result.rows.map(workerJobRow);
}

export async function requestWorkerJobCancellation(
  workerJobId,
  { reason = "Cancellation requested", now = isoNow() } = {}
) {
  const id = cleanWorkerJobId(workerJobId);
  const message = String(reason || "Cancellation requested").trim() || "Cancellation requested";
  return withTransaction(async (client) => {
    const selected = await client.query(
      `
        SELECT id, job_run_id, job_type, status, priority, payload_json, result_json,
               error_message, attempts, max_attempts, run_after, locked_by, locked_at,
               cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
        FROM worker_jobs
        WHERE id = $1
        FOR UPDATE
      `,
      [id]
    );
    const current = workerJobRow(selected.rows[0]);
    if (!current) return null;
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      return { worker_job: current, job_run: null, cancellation_requested: false, cancelled: current.status === "cancelled" };
    }

    if (current.status === "queued") {
      const updated = await client.query(
        `
          UPDATE worker_jobs
          SET status = 'cancelled',
              cancel_requested_at = $1,
              cancel_reason = $2,
              locked_by = '',
              locked_at = NULL,
              finished_at = $1,
              updated_at = $1
          WHERE id = $3 AND status = 'queued'
          RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                    error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                    cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
        `,
        [now, message, id]
      );
      const workerJob = workerJobRow(updated.rows[0]);
      if (!workerJob) return null;
      const jobRun = await updateJobRunForWorkerJob(client, workerJob, "cancelled", { now, message });
      await insertAppEvent(
        SERVER_EVENTS.TASK_CANCELLED,
        compactTaskEventPayload(workerJob, { status: "cancelled", message }),
        { createdAt: now, client }
      );
      return { worker_job: workerJob, job_run: jobRun, cancellation_requested: true, cancelled: true };
    }

    const updated = await client.query(
      `
        UPDATE worker_jobs
        SET cancel_requested_at = COALESCE(cancel_requested_at, $1),
            cancel_reason = CASE WHEN cancel_reason = '' THEN $2 ELSE cancel_reason END,
            updated_at = $1
        WHERE id = $3 AND status = 'running'
        RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                  error_message, attempts, max_attempts, run_after, locked_by, locked_at,
                  cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
      `,
      [now, message, id]
    );
    const workerJob = workerJobRow(updated.rows[0]);
    if (!workerJob) return null;
    const jobRun = await updateJobRunForWorkerJob(client, workerJob, "running", { now, message });
    await insertAppEvent(
      SERVER_EVENTS.TASK_CANCEL_REQUESTED,
      compactTaskEventPayload(workerJob, { status: "cancel_requested", message }),
      { createdAt: now, client }
    );
    return { worker_job: workerJob, job_run: jobRun, cancellation_requested: true, cancelled: false };
  });
}

export function workerJobStatus(value) {
  return cleanStatus(value);
}
