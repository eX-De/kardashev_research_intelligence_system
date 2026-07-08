import { existsSync, readFileSync } from "node:fs";

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

export function loadDotEnv(path) {
  if (!path || !existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]+|['"]+$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function envValue(name, fallback = "") {
  const filePath = String(process.env[`${name}_FILE`] || "").trim();
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").replace(/[\r\n]+$/, "");
    } catch (error) {
      throw new Error(`Failed to read ${name}_FILE (${filePath}): ${error.message}`);
    }
  }
  const fallbackText = fallback === null ? "None" : String(fallback);
  return process.env[name] === undefined ? fallbackText : String(process.env[name]);
}

export function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function envBoolean(name, fallback = false) {
  return TRUE_VALUES.has(envValue(name, fallback ? "true" : "false").trim().toLowerCase());
}
