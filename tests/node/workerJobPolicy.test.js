import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { allWorkerJobPolicies, resolveWorkerJobPolicy } from "../../server/workerJobPolicy.js";
import {
  WorkerRuntimePolicyConflictError,
  WorkerRuntimePolicyError,
  loadWorkerRuntimePolicy,
  mergeWorkerRuntimePolicy,
  saveWorkerRuntimePolicy
} from "../../server/workerRuntimePolicy.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/worker-job-policy-cases.json", import.meta.url), "utf8"));

test("worker policy covers every job and resolves contract fixture", () => {
  const policies = allWorkerJobPolicies();
  assert.equal(policies.length, 18);
  assert.equal(policies.some((policy) => policy.concurrency_group === "llm"), false);
  assert.deepEqual(
    Object.fromEntries(["concurrency_group", "limit_mode", "default_max_running"].map((key) => [key, policies.find((policy) => policy.type === "generate-reports")[key]])),
    { concurrency_group: "daily", limit_mode: "invariant", default_max_running: 1 }
  );
  for (const item of fixture.cases) {
    const resolved = resolveWorkerJobPolicy(item.job_type, item.payload);
    assert.equal(resolved.concurrency_key, item.key, item.job_type);
    assert.equal(resolved.policy_version, 3);
  }
  assert.throws(() => resolveWorkerJobPolicy("rank-papers", {}), /No worker job policy/);
  assert.throws(() => resolveWorkerJobPolicy("unknown-job", {}), /No worker job policy/);
});

test("Reader URL keys canonicalize, deduplicate, and ignore URL order", () => {
  const left = resolveWorkerJobPolicy("reader-import-url", {
    body: { urls: ["HTTPS://Example.test:443/paper?b=2&a=1#part", "https://b.test/x", "https://b.test/x"] }
  });
  const right = resolveWorkerJobPolicy("reader-import-url", {
    body: { urls: ["https://b.test/x", "https://example.test/paper?a=1&b=2"] }
  });
  assert.equal(left.concurrency_key, right.concurrency_key);
  assert.match(left.concurrency_key, /^reader-import:[a-f0-9]{64}$/);
  assert.equal(left.deduplicate_active, true);
  assert.equal(
    resolveWorkerJobPolicy("reader-import-url", { body: { url: "https://EXAMPLE.com:443" } }).concurrency_key,
    resolveWorkerJobPolicy("reader-import-url", { body: { url: "https://example.com/" } }).concurrency_key
  );
  const edgeCases = new Map([
    ["https://e.com/?B=1&a=2", "reader-import:e5107bdc8a5f940e331ff28da8dfb06584e9afed8fc083b7ecc68da504b9ff4c"],
    ["https://example.com/论文", "reader-import:7cc0bc0ab6f4f629dcfe9114d10f913a9a324c524583acd1d6a9dafa0e7eb97a"],
    ["https://例子.test/a", "reader-import:2d470871db71a97b9d7a57e5a97c74ea235a243dff1448b96b73e6ec8fa81c7b"]
  ]);
  for (const [url, expected] of edgeCases) assert.equal(
    resolveWorkerJobPolicy("reader-import-url", { body: { url } }).concurrency_key,
    expected
  );
});

test("runtime policy merge matches shared fixture and rejects invariant overrides", () => {
  const runtime = fixture.runtime;
  const snapshot = mergeWorkerRuntimePolicy(runtime.row, runtime.overrides);
  for (const [group, expected] of Object.entries(runtime.expected_groups)) {
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(snapshot.groups[group][field], value, `${group}.${field}`);
  }
  assert.throws(() => mergeWorkerRuntimePolicy(runtime.row, [{
    concurrency_group: "daily", max_running: 2, policy_revision: 7
  }]), /does not allow overrides/);
});

test("runtime policy reader uses one statement for zero or multiple overrides and rejects mismatched rows", async () => {
  const read = async (rows) => {
    let calls = 0;
    const snapshot = await loadWorkerRuntimePolicy({ async query(sql) {
      calls += 1;
      assert.match(sql, /LEFT JOIN worker_group_limit_overrides/);
      return { rows };
    } });
    assert.equal(calls, 1);
    return snapshot;
  };
  const noOverrides = await read([{
    ...fixture.runtime.row, concurrency_group: null, max_running: null, policy_revision: null
  }]);
  assert.equal(noOverrides.groups["reader-import"].source, "default");
  const multiple = await read(fixture.runtime.overrides.map((override) => ({
    ...fixture.runtime.row, ...override
  })));
  assert.equal(multiple.groups["reader-import"].max_running, 3);
  assert.equal(multiple.groups["artifact-index"].max_running, null);
  await assert.rejects(
    loadWorkerRuntimePolicy({ async query() { return { rows: [{
      ...fixture.runtime.row,
      concurrency_group: "reader-import", max_running: 3, policy_revision: 6
    }] }; } }),
    (error) => error instanceof WorkerRuntimePolicyError && /revision mismatch/.test(error.message)
  );
});

test("runtime policy save uses expected revision and a complete editable group map", async () => {
  const state = { runtime: { ...fixture.runtime.row }, overrides: [...fixture.runtime.overrides] };
  const client = { async query(sql, params) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM worker_runtime_policy") && normalized.includes("FOR UPDATE")) return { rows: [state.runtime] };
    if (normalized.includes("LEFT JOIN worker_group_limit_overrides")) return { rows: state.overrides.length
      ? state.overrides.map((override) => ({ ...state.runtime, ...override }))
      : [{ ...state.runtime, concurrency_group: null, max_running: null, policy_revision: null }] };
    if (normalized.startsWith("SELECT concurrency_group")) return { rows: state.overrides };
    if (normalized.startsWith("UPDATE worker_runtime_policy")) {
      [state.runtime.revision, state.runtime.worker_process_count,
        state.runtime.global_llm_request_concurrency, state.runtime.global_embedding_request_concurrency,
        state.runtime.embedding_concurrency, state.runtime.project_judgment_concurrency,
        state.runtime.project_chat_profile_concurrency] = params;
      return { rows: [] };
    }
    if (normalized.startsWith("DELETE FROM worker_group_limit_overrides")) { state.overrides = []; return { rows: [] }; }
    if (normalized.startsWith("INSERT INTO worker_group_limit_overrides")) {
      state.overrides.push({ concurrency_group: params[0], max_running: params[1], policy_revision: params[2] });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${normalized}`);
  } };
  const initial = mergeWorkerRuntimePolicy(state.runtime, state.overrides);
  const group_limits = Object.fromEntries(Object.entries(initial.groups)
    .filter(([, group]) => group.editable)
    .map(([name, group]) => [name, group.default_max_running]));
  group_limits["reader-import"] = null;
  const saved = await saveWorkerRuntimePolicy(client, {
    ...fixture.runtime.row,
    expected_revision: 7,
    group_limits
  });
  assert.equal(saved.revision, 8);
  assert.equal(saved.groups["reader-import"].max_running, null);
  assert.equal(saved.groups["reader-import"].source, "override");
  await assert.rejects(
    saveWorkerRuntimePolicy(client, { ...fixture.runtime.row, expected_revision: 7, group_limits }),
    (error) => error instanceof WorkerRuntimePolicyConflictError && error.snapshot.revision === 8
  );
});
