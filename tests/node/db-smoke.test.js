import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { query, setPoolForTesting } from "../../server/db.js";

const TEST_DATABASE_SKIP_REASON = "TEST_DATABASE_URL is not set; skipping PostgreSQL integration test";
const databaseUrl = String(process.env.TEST_DATABASE_URL || "").trim();

test("Node Postgres helper can run a smoke query", { skip: databaseUrl ? false : TEST_DATABASE_SKIP_REASON }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  setPoolForTesting(pool);
  try {
    const result = await query("SELECT 1 AS ok");
    assert.equal(result.rows[0]?.ok, 1);
  } finally {
    setPoolForTesting(null);
    await pool.end();
  }
});
