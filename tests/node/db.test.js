import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConflictError,
  NotFoundError,
  cleanUnicode,
  databaseTarget,
  databaseUrlFromEnv,
  many,
  maybeOne,
  one,
  parseJson,
  poolConfigFromEnv,
  quotePostgresUrlPart,
  setPoolForTesting,
  toJson,
  withTransaction
} from "../../server/db.js";
import { envBoolean, envValue, loadDotEnv } from "../../server/env.js";

const ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_FILE",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_PASSWORD_FILE",
  "KRIS_PG_POOL_MAX",
  "KRIS_PG_IDLE_TIMEOUT_MS",
  "KRIS_PG_CONNECTION_TIMEOUT_MS",
  "NODE_DB_TEST_VALUE",
  "NODE_DB_TEST_VALUE_FILE"
];

async function withCleanEnv(fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("envValue prefers *_FILE and preserves non-newline whitespace", async () => {
  await withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "kris-env-"));
    const file = join(dir, "secret.txt");
    try {
      writeFileSync(file, "  secret \t\r\n\n", "utf8");
      process.env.NODE_DB_TEST_VALUE = "plain";
      process.env.NODE_DB_TEST_VALUE_FILE = ` ${file} `;
      assert.equal(envValue("NODE_DB_TEST_VALUE", "fallback"), "  secret \t");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("envValue and envBoolean match Python env defaults", async () => {
  await withCleanEnv(() => {
    assert.equal(envValue("NODE_DB_TEST_VALUE", null), "None");
    process.env.NODE_DB_TEST_VALUE = "";
    assert.equal(envValue("NODE_DB_TEST_VALUE", "fallback"), "");
    assert.equal(envBoolean("NODE_DB_TEST_VALUE", true), false);
    process.env.NODE_DB_TEST_VALUE = "enabled";
    assert.equal(envBoolean("NODE_DB_TEST_VALUE", false), true);
  });
});

test("loadDotEnv fills missing values without overriding real env", async () => {
  await withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "kris-dotenv-"));
    const file = join(dir, ".env");
    try {
      process.env.NODE_DB_TEST_VALUE = "real";
      writeFileSync(file, "NODE_DB_TEST_VALUE=from-file\nPOSTGRES_HOST=\"'db'\"\n", "utf8");
      loadDotEnv(file);
      assert.equal(process.env.NODE_DB_TEST_VALUE, "real");
      assert.equal(process.env.POSTGRES_HOST, "db");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("databaseUrlFromEnv preserves DATABASE_URL priority", async () => {
  await withCleanEnv(() => {
    process.env.DATABASE_URL = " postgresql://user:pw@host/db ";
    process.env.POSTGRES_HOST = "fallback";
    assert.equal(databaseUrlFromEnv(), "postgresql://user:pw@host/db");
  });
});

test("databaseUrlFromEnv builds Python-compatible POSTGRES_* fallback URL", async () => {
  await withCleanEnv(() => {
    process.env.POSTGRES_HOST = "db";
    process.env.POSTGRES_PORT = "";
    process.env.POSTGRES_USER = "research app";
    process.env.POSTGRES_PASSWORD = "p!'()*";
    process.env.POSTGRES_DB = "research/db";
    assert.equal(
      databaseUrlFromEnv(),
      "postgresql://research%20app:p%21%27%28%29%2A@db:5432/research%2Fdb"
    );
    assert.equal(quotePostgresUrlPart("!'()*"), "%21%27%28%29%2A");
  });
});

test("databaseUrlFromEnv returns empty when PostgreSQL is not configured", async () => {
  await withCleanEnv(() => {
    assert.equal(databaseUrlFromEnv(), "");
    assert.throws(() => poolConfigFromEnv(), /PostgreSQL is required/);
  });
});

test("databaseTarget redacts passwords for diagnostics", () => {
  assert.deepEqual(databaseTarget("postgresql://user:secret@localhost:5432/app?sslmode=require"), {
    dialect: "postgres",
    target: "postgresql://user:***@localhost:5432/app",
    path: "postgresql://user:***@localhost:5432/app"
  });
});

test("JSON helpers parse fallback, clean NULs, and sort keys", () => {
  assert.deepEqual(parseJson("", { fallback: true }), { fallback: true });
  assert.deepEqual(parseJson("{bad", ["fallback"]), ["fallback"]);
  assert.deepEqual(parseJson('{"b":"x\\u0000","a":{"d":2,"c":1}}', null), {
    a: { c: 1, d: 2 },
    b: "x"
  });
  assert.equal(toJson({ b: "x\u0000", a: { d: 2, c: 1 } }), '{"a": {"c": 1, "d": 2}, "b": "x"}');
  assert.deepEqual(cleanUnicode({ "a\u0000": "b\u0000" }), { a: "b" });
});

test("row helpers expose many/maybeOne/one behavior", () => {
  const result = { rows: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(many(result), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(maybeOne(result), { id: 1 });
  assert.deepEqual(one(result), { id: 1 });
  assert.throws(() => one({ rows: [] }, "Missing"), NotFoundError);
});

test("withTransaction commits success and rolls back failures", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    release() {
      calls.push("release");
    }
  };
  setPoolForTesting({
    async connect() {
      return client;
    }
  });
  try {
    const result = await withTransaction(async (tx) => {
      await tx.query("SELECT 1");
      return "ok";
    });
    assert.equal(result, "ok");
    assert.deepEqual(calls, ["BEGIN", "SELECT 1", "COMMIT", "release"]);

    calls.length = 0;
    await assert.rejects(
      () => withTransaction(async () => {
        const error = new Error("duplicate");
        error.code = "23505";
        throw error;
      }),
      ConflictError
    );
    assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "release"]);

    calls.length = 0;
    setPoolForTesting({
      async connect() {
        const error = new Error("connect failed");
        error.code = "ECONNREFUSED";
        throw error;
      }
    });
    await assert.rejects(() => withTransaction(async () => "unused"), /Database error/);
    assert.deepEqual(calls, []);
  } finally {
    setPoolForTesting(null);
  }
});
