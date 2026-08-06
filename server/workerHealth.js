import { query } from "./db.js";

const DEFAULT_HEARTBEAT_TTL_SECONDS = 15;

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function workerHeartbeatTtlSeconds() {
  return positiveInteger(process.env.KRIS_WORKER_HEARTBEAT_TTL_SECONDS, DEFAULT_HEARTBEAT_TTL_SECONDS, 5);
}

export async function getWorkerStatus(options = {}, db = { query }) {
  const ttlSeconds = positiveInteger(options.heartbeatTtlSeconds, workerHeartbeatTtlSeconds(), 1);
  const [instancesResult, queueResult, queueBreakdownResult, runtimePolicyResult] = await Promise.all([
    db.query(
      `
        SELECT wi.worker_id, wi.status, wi.started_at, wi.heartbeat_at, wi.current_job_id, wi.pid,
               wj.job_type AS current_job_type, wj.concurrency_group AS current_job_group,
               (
                 wi.status <> 'stopped'
                 AND NULLIF(wi.heartbeat_at, '')::timestamptz >= NOW() - $1::interval
               ) AS is_live
        FROM worker_instances wi
        LEFT JOIN worker_jobs wj ON wj.id = wi.current_job_id
        ORDER BY NULLIF(wi.heartbeat_at, '')::timestamptz DESC NULLS LAST, wi.worker_id
      `,
      [`${ttlSeconds} seconds`]
    ),
    db.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued') AS queued,
          COUNT(*) FILTER (WHERE status = 'running') AS running,
          MIN(NULLIF(created_at, '')::timestamptz) FILTER (WHERE status = 'queued') AS oldest_queued_at,
          EXTRACT(EPOCH FROM (
            NOW() - MIN(NULLIF(created_at, '')::timestamptz) FILTER (WHERE status = 'queued')
          )) AS oldest_queued_seconds
        FROM worker_jobs
      `
    ),
    db.query(
      `
        SELECT
          job_type, concurrency_group,
          status,
          COUNT(*) AS count,
          MIN(NULLIF(created_at, '')::timestamptz) FILTER (WHERE status = 'queued') AS oldest_queued_at,
          EXTRACT(EPOCH FROM (
            NOW() - MIN(NULLIF(created_at, '')::timestamptz) FILTER (WHERE status = 'queued')
          )) AS oldest_queued_seconds
        FROM worker_jobs
        WHERE status IN ('queued', 'running')
        GROUP BY job_type, concurrency_group, status
        ORDER BY job_type, concurrency_group, status
      `
    ),
    db.query(
      `
        SELECT revision, worker_process_count
        FROM worker_runtime_policy
        WHERE singleton_id = 1
      `
    ).catch((error) => ({ rows: [], error }))
  ]);
  const instances = (instancesResult.rows || []).map((row) => ({
    worker_id: String(row.worker_id || ""),
    status: String(row.status || ""),
    started_at: row.started_at || null,
    heartbeat_at: row.heartbeat_at || null,
    current_job_id: row.current_job_id === null || row.current_job_id === undefined ? null : Number(row.current_job_id),
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    live: row.is_live === true || row.is_live === "t" || row.is_live === 1,
    current_job: row.current_job_id === null || row.current_job_id === undefined ? null : {
      id: Number(row.current_job_id),
      job_type: String(row.current_job_type || ""),
      concurrency_group: String(row.current_job_group || "")
    }
  }));
  const liveInstances = instances.filter((item) => item.live);
  const acceptingInstances = liveInstances.filter((item) => item.status !== "draining");
  const drainingInstances = liveInstances.filter((item) => item.status === "draining");
  const runtimePolicy = runtimePolicyResult.rows?.[0] || {};
  const parsedDesiredProcesses = Number(runtimePolicy.worker_process_count);
  const runtimePolicyAvailable = Number.isInteger(parsedDesiredProcesses) && parsedDesiredProcesses >= 1;
  const desiredProcesses = runtimePolicyAvailable ? parsedDesiredProcesses : null;
  const queueRow = queueResult.rows?.[0] || {};
  const queued = numberValue(queueRow.queued);
  const running = numberValue(queueRow.running);
  const byType = {};
  const byGroup = {};
  for (const row of queueBreakdownResult.rows || []) {
    const jobType = String(row.job_type || "unknown");
    const status = String(row.status || "");
    const count = numberValue(row.count);
    const group = String(row.concurrency_group || "unclassified");
    const typeStats = byType[jobType] || {
      queued: 0,
      running: 0,
      active: 0,
      concurrency_group: group,
      oldest_queued_at: null,
      oldest_queued_seconds: 0
    };
    if (status === "queued" || status === "running") typeStats[status] += count;
    typeStats.active += count;
    if (status === "queued") {
      typeStats.oldest_queued_at = row.oldest_queued_at || null;
      typeStats.oldest_queued_seconds = Math.max(0, numberValue(row.oldest_queued_seconds));
    }
    byType[jobType] = typeStats;

    const groupStats = byGroup[group] || {
      queued: 0,
      running: 0,
      active: 0,
      oldest_queued_at: null,
      oldest_queued_seconds: 0
    };
    if (status === "queued" || status === "running") groupStats[status] += count;
    groupStats.active += count;
    const waitSeconds = Math.max(0, numberValue(row.oldest_queued_seconds));
    if (status === "queued" && waitSeconds >= groupStats.oldest_queued_seconds) {
      groupStats.oldest_queued_at = row.oldest_queued_at || null;
      groupStats.oldest_queued_seconds = waitSeconds;
    }
    byGroup[group] = groupStats;
  }
  const available = acceptingInstances.length > 0;
  let poolState = "online";
  if (!runtimePolicyAvailable) poolState = "degraded";
  else if (drainingInstances.length > 0 || liveInstances.length > desiredProcesses) poolState = "draining";
  else if (liveInstances.length < desiredProcesses) poolState = "degraded";
  return {
    required: true,
    available,
    state: available ? "online" : "offline",
    heartbeat_ttl_seconds: ttlSeconds,
    online_workers: liveInstances.length,
    accepting_workers: acceptingInstances.length,
    draining_workers: drainingInstances.length,
    registered_workers: instances.length,
    last_heartbeat_at: instances[0]?.heartbeat_at || null,
    queue: {
      queued,
      running,
      active: queued + running,
      oldest_queued_at: queueRow.oldest_queued_at || null,
      oldest_queued_seconds: Math.max(0, numberValue(queueRow.oldest_queued_seconds)),
      by_type: byType,
      by_group: byGroup
    },
    instances,
    pool: {
      revision: runtimePolicyAvailable ? numberValue(runtimePolicy.revision) : null,
      policy_available: runtimePolicyAvailable,
      desired_processes: desiredProcesses,
      actual_processes: liveInstances.length,
      accepting_processes: acceptingInstances.length,
      draining_processes: drainingInstances.length,
      state: poolState,
      degraded: poolState === "degraded"
    },
    group_occupancy: byGroup,
    stalled: !available && queued + running > 0
  };
}

export async function requireAvailableWorker(options = {}, db = { query }) {
  const status = await getWorkerStatus(options, db);
  if (status.accepting_workers > 0) return status;
  const error = new Error("Background worker service is unavailable");
  error.statusCode = 503;
  error.structuredCode = "worker_unavailable";
  error.code = "worker_unavailable";
  error.reason = "worker_unavailable";
  error.workerStatus = status;
  throw error;
}
