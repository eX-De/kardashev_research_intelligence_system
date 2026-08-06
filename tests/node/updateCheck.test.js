import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting } from "../../server/db.js";
import { checkForUpdates, readUpdateStatus } from "../../server/updateCheck.js";

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function statusPool(initial = null) {
  let stored = initial;
  return {
    get stored() { return stored; },
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
      if (normalized.startsWith("SELECT VALUE_JSON FROM APP_SETTINGS")) {
        return { rows: stored ? [{ value_json: JSON.stringify(stored) }] : [] };
      }
      if (normalized.startsWith("INSERT INTO APP_SETTINGS")) {
        stored = JSON.parse(params[1]);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function setAppVersion(t, value) {
  const previous = process.env.KRIS_APP_VERSION;
  process.env.KRIS_APP_VERSION = value;
  t.after(() => {
    if (previous === undefined) delete process.env.KRIS_APP_VERSION;
    else process.env.KRIS_APP_VERSION = previous;
  });
}

test("update check selects the highest semver tag and matching release", async (t) => {
  const pool = statusPool();
  setPoolForTesting(pool);
  t.after(() => setPoolForTesting(null));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/releases/latest")) {
      return response(200, {
        tag_name: "v1.2.0", name: "Version 1.2.0", body: "Release notes",
        html_url: "https://example.test/v1.2.0", published_at: "2026-08-05T00:00:00Z"
      });
    }
    return response(200, [{ name: "v1.1.9" }, { name: "v1.2.0" }, { name: "not-semver" }]);
  });
  setAppVersion(t, "1.1.0");

  const result = await checkForUpdates();
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.latest_tag, "v1.2.0");
  assert.equal(result.source, "github_release");
  assert.equal(result.notification.source.update.release_url, "https://example.test/v1.2.0");
  assert.equal(pool.stored.latest_version, "1.2.0");
});

test("404 release falls back to tags and persisted status can be read", async (t) => {
  const pool = statusPool();
  setPoolForTesting(pool);
  t.after(() => setPoolForTesting(null));
  t.mock.method(globalThis, "fetch", async (url) => (
    String(url).endsWith("/releases/latest")
      ? response(404, {})
      : response(200, [{ name: "v2.0.0" }, { name: "v1.9.9" }])
  ));
  setAppVersion(t, "2.0.0");

  const checked = await checkForUpdates();
  const read = await readUpdateStatus();
  assert.equal(checked.source, "github_tag");
  assert.equal(checked.release_url.endsWith("/tree/v2.0.0"), true);
  assert.equal(read.available, false);
  assert.equal(read.notification, null);
});

test("GitHub failures persist an unavailable error status", async (t) => {
  const pool = statusPool();
  setPoolForTesting(pool);
  t.after(() => setPoolForTesting(null));
  t.mock.method(globalThis, "fetch", async () => response(503, {}));
  setAppVersion(t, "1.0.0");

  const result = await checkForUpdates();
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.match(result.error, /503/);
  assert.equal(pool.stored.ok, false);
});
