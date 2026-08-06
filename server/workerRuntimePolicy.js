import { allWorkerGroupPolicies } from "./workerJobPolicy.js";

export class WorkerRuntimePolicyError extends Error {}
export class WorkerRuntimePolicyValidationError extends WorkerRuntimePolicyError {}
export class WorkerRuntimePolicyConflictError extends WorkerRuntimePolicyError {
  constructor(snapshot) {
    super("worker runtime policy revision conflict");
    this.snapshot = snapshot;
  }
}

export const WORKER_RUNTIME_FIELDS = Object.freeze([
  "worker_process_count",
  "global_llm_request_concurrency",
  "global_embedding_request_concurrency",
  "embedding_concurrency",
  "project_judgment_concurrency",
  "project_chat_profile_concurrency"
]);
const RUNTIME_BOUNDS = Object.freeze({
  worker_process_count: [1, 16],
  global_llm_request_concurrency: [1, 64],
  global_embedding_request_concurrency: [1, 64],
  embedding_concurrency: [1, 32],
  project_judgment_concurrency: [1, 8],
  project_chat_profile_concurrency: [1, 8]
});

export function mergeWorkerRuntimePolicy(runtimeRow, overrideRows = []) {
  if (!runtimeRow) throw new WorkerRuntimePolicyError("worker runtime policy singleton is missing");
  const revision = Number(runtimeRow.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new WorkerRuntimePolicyError("worker runtime policy row is invalid");
  }
  const values = {};
  for (const field of WORKER_RUNTIME_FIELDS) {
    const value = Number(runtimeRow[field]);
    const [minimum, maximum] = RUNTIME_BOUNDS[field];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new WorkerRuntimePolicyError("worker runtime policy row is invalid");
    }
    values[field] = value;
  }
  if (values.embedding_concurrency > values.global_embedding_request_concurrency
    || values.project_judgment_concurrency > values.global_llm_request_concurrency
    || values.project_chat_profile_concurrency > values.global_llm_request_concurrency) {
    throw new WorkerRuntimePolicyError("worker runtime policy row is invalid");
  }
  const groups = Object.fromEntries(Object.entries(allWorkerGroupPolicies()).map(([name, policy]) => [name, {
    ...policy,
    max_running: policy.default_max_running,
    source: policy.limit_mode === "capacity" ? "default" : policy.limit_mode,
    editable: policy.limit_mode === "capacity"
  }]));
  const seen = new Set();
  for (const row of overrideRows) {
    const group = String(row?.concurrency_group || "");
    if (seen.has(group)) throw new WorkerRuntimePolicyError(`duplicate worker group override: ${group}`);
    seen.add(group);
    if (!Object.hasOwn(groups, group)) throw new WorkerRuntimePolicyError(`unknown worker group override: ${group || "<empty>"}`);
    if (groups[group].limit_mode !== "capacity") throw new WorkerRuntimePolicyError(`worker group ${group} does not allow overrides`);
    if (Number(row.policy_revision) !== revision) throw new WorkerRuntimePolicyError(`worker group override revision mismatch: ${group}`);
    const limit = row.max_running === null ? null : Number(row.max_running);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new WorkerRuntimePolicyError(`invalid worker group override limit: ${group}`);
    }
    groups[group].max_running = limit;
    groups[group].source = "override";
  }
  return { revision, ...values, groups };
}

export async function loadWorkerRuntimePolicy(db) {
  try {
    const result = await db.query(
      `SELECT policy.*, override_row.concurrency_group,
              override_row.max_running, override_row.policy_revision
       FROM worker_runtime_policy policy
       LEFT JOIN worker_group_limit_overrides override_row ON TRUE
       WHERE policy.singleton_id = 1
       ORDER BY override_row.concurrency_group`,
      []
    );
    if (!result.rows[0]) return mergeWorkerRuntimePolicy(null, []);
    return mergeWorkerRuntimePolicy(
      result.rows[0],
      result.rows.filter((row) => row.concurrency_group !== null && row.concurrency_group !== undefined)
    );
  } catch (error) {
    if (error instanceof WorkerRuntimePolicyError) throw error;
    throw new WorkerRuntimePolicyError(`worker runtime policy is unavailable: ${error.message}`, { cause: error });
  }
}

function normalizeRuntimeDraft(draft) {
  const values = {};
  for (const field of WORKER_RUNTIME_FIELDS) {
    const value = draft?.[field];
    const [minimum, maximum] = RUNTIME_BOUNDS[field];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new WorkerRuntimePolicyValidationError(`${field} must be an integer between ${minimum} and ${maximum}`);
    }
    values[field] = value;
  }
  if (values.embedding_concurrency > values.global_embedding_request_concurrency) {
    throw new WorkerRuntimePolicyValidationError("embedding_concurrency must not exceed global_embedding_request_concurrency");
  }
  for (const field of ["project_judgment_concurrency", "project_chat_profile_concurrency"]) {
    if (values[field] > values.global_llm_request_concurrency) {
      throw new WorkerRuntimePolicyValidationError(`${field} must not exceed global_llm_request_concurrency`);
    }
  }
  const staticGroups = allWorkerGroupPolicies();
  const editableGroups = Object.entries(staticGroups)
    .filter(([, policy]) => policy.limit_mode === "capacity")
    .map(([group]) => group)
    .sort();
  const supplied = draft?.group_limits;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new WorkerRuntimePolicyValidationError("group_limits must be the complete editable group map");
  }
  const suppliedGroups = Object.keys(supplied).sort();
  if (suppliedGroups.length !== editableGroups.length
    || suppliedGroups.some((group, index) => group !== editableGroups[index])) {
    throw new WorkerRuntimePolicyValidationError("group_limits must contain every editable group and no other groups");
  }
  const limits = {};
  for (const group of editableGroups) {
    const limit = supplied[group];
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new WorkerRuntimePolicyValidationError(`${group} max_running must be a positive integer or null`);
    }
    limits[group] = limit;
  }
  return { values, limits, staticGroups };
}

/** Save through a caller-owned transaction so settings and secrets can commit atomically. */
export async function saveWorkerRuntimePolicy(client, draft) {
  const expectedRevision = draft?.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new WorkerRuntimePolicyValidationError("expected_revision must be a positive integer");
  }
  const normalized = normalizeRuntimeDraft(draft);
  const locked = await client.query(
    "SELECT * FROM worker_runtime_policy WHERE singleton_id = 1 FOR UPDATE",
    []
  );
  if (!locked.rows[0]) throw new WorkerRuntimePolicyError("worker runtime policy singleton is missing");
  const currentRevision = Number(locked.rows[0].revision);
  if (currentRevision !== expectedRevision) {
    const overrides = await client.query(
      "SELECT concurrency_group, max_running, policy_revision FROM worker_group_limit_overrides ORDER BY concurrency_group",
      []
    );
    throw new WorkerRuntimePolicyConflictError(mergeWorkerRuntimePolicy(locked.rows[0], overrides.rows));
  }
  const revision = currentRevision + 1;
  const updatedAt = new Date().toISOString();
  const valueParams = WORKER_RUNTIME_FIELDS.map((field) => normalized.values[field]);
  await client.query(
    `UPDATE worker_runtime_policy SET revision = $1,
       worker_process_count = $2, global_llm_request_concurrency = $3,
       global_embedding_request_concurrency = $4, embedding_concurrency = $5,
       project_judgment_concurrency = $6, project_chat_profile_concurrency = $7,
       updated_at = $8 WHERE singleton_id = 1`,
    [revision, ...valueParams, updatedAt]
  );
  await client.query("DELETE FROM worker_group_limit_overrides", []);
  for (const [group, limit] of Object.entries(normalized.limits)) {
    if (limit === normalized.staticGroups[group].default_max_running) continue;
    await client.query(
      `INSERT INTO worker_group_limit_overrides(
         concurrency_group, max_running, policy_revision, updated_at
       ) VALUES ($1, $2, $3, $4)`,
      [group, limit, revision, updatedAt]
    );
  }
  return loadWorkerRuntimePolicy(client);
}
