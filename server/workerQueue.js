import { parseJson, query, toJson, ValidationError, withTransaction } from "./db.js";
import { SERVER_EVENTS, compactTaskEventPayload } from "./events.js";
import { insertAppEvent } from "./outbox.js";
import { resolveWorkerJobPolicy } from "./workerJobPolicy.js";

const WORKER_JOB_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const DAILY_JOB_TYPES = new Set(["run-daily", "resume-daily", "retry-daily"]);

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
    concurrency_group: row.concurrency_group || "",
    concurrency_key: row.concurrency_key || "",
    policy_version: Number(row.policy_version || 0),
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

export async function enqueueWorkerJobInTransaction(client, {
  jobType,
  payload = {},
  runAfter = null,
  message = "Queued",
  now = isoNow()
} = {}) {
  const normalizedJobType = cleanJobType(jobType);
  const policy = resolveWorkerJobPolicy(normalizedJobType, payload);
  if (policy.deduplicate_active && policy.concurrency_key) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`worker-enqueue:${policy.concurrency_key}`]);
    const existingResult = await client.query(
      `SELECT id, job_run_id, job_type, status, priority, payload_json, result_json,
              error_message, attempts, max_attempts, concurrency_group, concurrency_key, policy_version,
              run_after, locked_by, locked_at, cancel_requested_at, cancel_reason,
              created_at, updated_at, started_at, finished_at
       FROM worker_jobs
       WHERE job_type = $1 AND concurrency_key = $2 AND status IN ('queued', 'running')
       ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [normalizedJobType, policy.concurrency_key]
    );
    const existing = workerJobRow(existingResult.rows?.[0]);
    if (existing) return { job_run: null, worker_job: existing, deduplicated: true };
  }
  let jobRun = null;
  if (DAILY_JOB_TYPES.has(normalizedJobType)) {
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
          toJson({ queued: true, daily_run: true, queued_at: now })
        ]
      );
      jobRun = jobRunRow(jobRunResult.rows[0]);
  }
  const workerJobResult = await client.query(
      `
        INSERT INTO worker_jobs(
          job_run_id, job_type, status, priority, payload_json, max_attempts,
          concurrency_group, concurrency_key, policy_version, run_after, created_at, updated_at
        )
        VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $10)
        RETURNING id, job_run_id, job_type, status, priority, payload_json, result_json,
                  error_message, attempts, max_attempts, concurrency_group, concurrency_key, policy_version,
                  run_after, locked_by, locked_at,
                  cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
      `,
      [
        jobRun?.id || null,
        normalizedJobType,
        policy.priority,
        toJson(payload || {}),
        policy.default_max_attempts,
        policy.concurrency_group,
        policy.concurrency_key,
        policy.policy_version,
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
  return { job_run: jobRun, worker_job: workerJob, deduplicated: false };
}

export async function rebindWorkerJobPolicyInTransaction(
  client, workerJobId, jobType, payload, now = isoNow(), { statusScope = "queued" } = {}
) {
  if (!new Set(["queued", "active"]).has(statusScope)) {
    throw new Error(`Unsupported worker job policy rebind scope: ${statusScope}`);
  }
  const normalizedJobType = cleanJobType(jobType);
  const policy = resolveWorkerJobPolicy(normalizedJobType, payload);
  const result = await client.query(
    `UPDATE worker_jobs
     SET payload_json = $1, priority = $2, max_attempts = $3,
         concurrency_group = $4, concurrency_key = $5, policy_version = $6,
         updated_at = $7
     WHERE id = $8 ${statusScope === "queued" ? "AND status = 'queued'" : "AND status IN ('queued', 'running')"}
     RETURNING id`,
    [toJson(payload || {}), policy.priority, policy.default_max_attempts, policy.concurrency_group,
      policy.concurrency_key, policy.policy_version, now, workerJobId]
  );
  return Boolean(result.rows?.[0]);
}

async function cancelPaperReportDomainInTransaction(client, workerJob, now, message) {
  if (workerJob?.job_type !== "paper-report") return;
  const paperId = Number(workerJob.payload?.paper_id || 0);
  if (!Number.isInteger(paperId) || paperId <= 0) return;
  const selected = await client.query(
    `SELECT * FROM artifacts
     WHERE scope_type = 'paper' AND scope_id = $1 AND artifact_type = 'paper_report'
     ORDER BY updated_at DESC, id DESC LIMIT 1 FOR UPDATE`,
    [paperId]
  );
  const artifact = selected.rows[0];
  if (!artifact || artifact.status === "removed") return;
  const content = parseJson(artifact.content_json, {});
  const expectedGeneration = String(workerJob.payload?.generation_id || "");
  if (expectedGeneration && String(content.generation_id || "") !== expectedGeneration) return;
  const updatedContent = { ...content, error_message: "", finished_at: now };
  await client.query(
    "UPDATE artifacts SET status = 'cancelled', content_json = $1, updated_at = $2 WHERE id = $3",
    [toJson(updatedContent), now, artifact.id]
  );
  await insertAppEvent(SERVER_EVENTS.PAPER_REPORT_UPDATED, {
    paper: { paper_id: paperId, id: paperId, title: artifact.title || null, report_status: "cancelled", updated_at: now },
    paper_report: { paper_id: paperId, artifact_id: Number(artifact.id), status: "cancelled", error_message: "", updated_at: now },
    paper_id: paperId,
    artifact_id: Number(artifact.id),
    status: "cancelled",
    project_ids: [],
    action: "worker_job_cancel",
    message
  }, { createdAt: now, client });
}

export async function enqueueWorkerJob(options = {}) {
  cleanJobType(options.jobType);
  const queued = await withTransaction((client) => enqueueWorkerJobInTransaction(client, options));
  console.info(JSON.stringify({
    event: queued.deduplicated ? "worker_job.deduplicated" : "worker_job.queued",
    worker_job_id: queued.worker_job?.id || null,
    job_type: queued.worker_job?.job_type || "",
    worker_id: null,
    attempt: 0,
    concurrency_group: queued.worker_job?.concurrency_group || "",
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
             error_message, attempts, max_attempts, concurrency_group, concurrency_key, policy_version,
             run_after, locked_by, locked_at,
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
             error_message, attempts, max_attempts, concurrency_group, concurrency_key, policy_version,
             run_after, locked_by, locked_at,
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
    const previewResult = await client.query(
      "SELECT job_type, payload_json FROM worker_jobs WHERE id = $1",
      [id]
    );
    const preview = previewResult.rows[0];
    if (preview?.job_type === "paper-report") {
      const previewPayload = parseJson(preview.payload_json, {});
      const paperId = Number(previewPayload.paper_id || 0);
      if (Number.isInteger(paperId) && paperId > 0) {
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", [724023, paperId]);
      }
    }
    const selected = await client.query(
      `
        SELECT id, job_run_id, job_type, status, priority, payload_json, result_json,
               error_message, attempts, max_attempts, concurrency_group, concurrency_key, policy_version,
               run_after, locked_by, locked_at,
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
                    error_message, attempts, max_attempts, concurrency_group, concurrency_key, policy_version,
                    run_after, locked_by, locked_at,
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
      await cancelPaperReportDomainInTransaction(client, workerJob, now, message);
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
                  error_message, attempts, max_attempts, concurrency_group, concurrency_key, policy_version,
                  run_after, locked_by, locked_at,
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
    await cancelPaperReportDomainInTransaction(client, workerJob, now, message);
    return { worker_job: workerJob, job_run: jobRun, cancellation_requested: true, cancelled: false };
  });
}

export function workerJobStatus(value) {
  return cleanStatus(value);
}
