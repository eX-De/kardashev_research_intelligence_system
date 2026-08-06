export const WORKER_CONCURRENCY_FIELDS = Object.freeze([
  "worker_process_count",
  "global_llm_request_concurrency",
  "global_embedding_request_concurrency",
  "embedding_concurrency",
  "project_judgment_concurrency",
  "project_chat_profile_concurrency"
]);

export function workerConcurrencyFlatValues(snapshot = {}) {
  return Object.fromEntries(WORKER_CONCURRENCY_FIELDS.map((field) => [field, snapshot[field]]));
}

export function workerCapacityApplyDecision({ state, pool, desired, attempts, maxAttempts = 15 }) {
  if (state !== "reconciling") return state;
  if (pool
    && Number(pool.actual_processes) === Number(desired)
    && Number(pool.draining_processes) === 0
    && !pool.degraded) return "applied";
  if (Number(attempts) >= maxAttempts) return "degraded";
  return "reconciling";
}
