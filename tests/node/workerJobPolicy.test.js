import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { allWorkerJobPolicies, resolveWorkerJobPolicy } from "../../server/workerJobPolicy.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/worker-job-policy-cases.json", import.meta.url), "utf8"));

test("worker policy covers every job and resolves contract fixture", () => {
  assert.equal(allWorkerJobPolicies().length, 20);
  for (const item of fixture.cases) {
    const resolved = resolveWorkerJobPolicy(item.job_type, item.payload);
    assert.equal(resolved.concurrency_key, item.key, item.job_type);
    assert.equal(resolved.policy_version, 1);
  }
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
