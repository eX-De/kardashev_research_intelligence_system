import pg from "pg";
import { envValue, positiveInteger } from "./env.js";

const { Pool } = pg;

let pool = null;

export class HttpError extends Error {
  constructor(message, { statusCode = 500, code = "", reason = "" } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    if (code) {
      this.structuredCode = code;
      this.code = code;
    }
    if (reason || code) this.reason = reason || code;
  }
}

export class ValidationError extends HttpError {
  constructor(message, options = {}) {
    super(message, { statusCode: 400, code: "validation_error", ...options });
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found", options = {}) {
    super(message, { statusCode: 404, code: "not_found", ...options });
  }
}

export class ConflictError extends HttpError {
  constructor(message, options = {}) {
    super(message, { statusCode: 409, code: "conflict", ...options });
  }
}

export class DatabaseError extends HttpError {
  constructor(message = "Database error", options = {}) {
    super(message, { statusCode: 500, code: "database_error", ...options });
  }
}

export function quotePostgresUrlPart(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export function databaseUrlFromEnv() {
  const configured = envValue("DATABASE_URL", "").trim();
  if (configured) return configured;

  const host = envValue("POSTGRES_HOST", "").trim();
  if (!host) return "";
  const port = envValue("POSTGRES_PORT", "5432").trim() || "5432";
  const user = envValue("POSTGRES_USER", "research_app").trim();
  const password = envValue("POSTGRES_PASSWORD", "").trim();
  const database = envValue("POSTGRES_DB", "research_intelligence").trim();
  return `postgresql://${quotePostgresUrlPart(user)}:${quotePostgresUrlPart(password)}@${host}:${port}/${quotePostgresUrlPart(database)}`;
}

export function postgresRequiredError() {
  return new DatabaseError(
    "PostgreSQL is required. Set DATABASE_URL/DATABASE_URL_FILE or POSTGRES_HOST, POSTGRES_DB, POSTGRES_USER, and POSTGRES_PASSWORD/POSTGRES_PASSWORD_FILE.",
    { code: "database_not_configured", reason: "database_not_configured" }
  );
}

export function databaseTarget(url = databaseUrlFromEnv()) {
  const target = redactedDatabaseUrl(url);
  return { dialect: "postgres", target, path: target };
}

export function redactedDatabaseUrl(url) {
  const cleaned = String(url || "").trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) return "postgres";
  try {
    const parsed = new URL(cleaned);
    if (!parsed.protocol || !parsed.host) return "postgres";
    if (parsed.password) parsed.password = "***";
    return `${parsed.protocol}//${parsed.username ? `${parsed.username}${parsed.password ? ":***" : ""}@` : ""}${parsed.host}${parsed.pathname}`;
  } catch {
    return "postgres";
  }
}

export function poolConfigFromEnv({ connectionString = databaseUrlFromEnv() } = {}) {
  if (!connectionString) throw postgresRequiredError();
  return {
    connectionString,
    max: positiveInteger(envValue("KRIS_PG_POOL_MAX", "10"), 10),
    idleTimeoutMillis: positiveInteger(envValue("KRIS_PG_IDLE_TIMEOUT_MS", "30000"), 30000),
    connectionTimeoutMillis: positiveInteger(envValue("KRIS_PG_CONNECTION_TIMEOUT_MS", "5000"), 5000)
  };
}

export function getPool() {
  if (!pool) {
    pool = new Pool(poolConfigFromEnv());
  }
  return pool;
}

export function setPoolForTesting(nextPool) {
  pool = nextPool;
}

export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export async function query(sql, params = []) {
  try {
    return await getPool().query(sql, params);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function withTransaction(fn) {
  let client = null;
  try {
    client = await getPool().connect();
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw mapDatabaseError(error);
  } finally {
    client?.release();
  }
}

export function many(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

export function maybeOne(result) {
  const rows = many(result);
  return rows.length ? rows[0] : null;
}

export function one(result, message = "Not found") {
  const row = maybeOne(result);
  if (!row) throw new NotFoundError(message);
  return row;
}

export function cleanUnicode(value) {
  if (typeof value === "string") {
    return value.replace(/\u0000/g, "");
  }
  if (Array.isArray(value)) {
    return value.map((item) => cleanUnicode(item));
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [cleanUnicode(key), cleanUnicode(item)])
    );
  }
  return value;
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return cleanUnicode(value);
  try {
    return cleanUnicode(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export function toJson(value) {
  return stableStringify(cleanUnicode(value));
}

function stableStringify(value) {
  const sorted = sortJsonValue(value);
  if (sorted === null) return "null";
  if (Array.isArray(sorted)) {
    return `[${sorted.map((item) => stableStringify(item)).join(", ")}]`;
  }
  if (sorted && typeof sorted === "object" && Object.getPrototypeOf(sorted) === Object.prototype) {
    return `{${Object.entries(sorted).map(([key, item]) => `${JSON.stringify(key)}: ${stableStringify(item)}`).join(", ")}}`;
  }
  if (typeof sorted === "number") {
    if (Number.isNaN(sorted)) return "NaN";
    if (sorted === Infinity) return "Infinity";
    if (sorted === -Infinity) return "-Infinity";
  }
  return JSON.stringify(sorted);
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }
  return value;
}

export function mapDatabaseError(error) {
  if (error instanceof HttpError) return error;
  if (error?.code === "23505") {
    return new ConflictError("Database conflict", { reason: "unique_violation" });
  }
  if (error?.code === "23503") {
    return new ConflictError("Database conflict", { reason: "foreign_key_violation" });
  }
  return new DatabaseError("Database error");
}
