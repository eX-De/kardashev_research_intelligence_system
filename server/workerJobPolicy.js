import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const document = JSON.parse(readFileSync(new URL("../config/worker-job-policy.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));
const inventory = JSON.parse(readFileSync(new URL("../config/worker-job-inventory.json", import.meta.url), "utf8"));
const entries = Object.entries(document.jobs || {});
const byType = new Map(entries.map(([type, value]) => [type, Object.freeze({ type, ...value })]));

const requiredFields = ["execution_mode", "concurrency_group", "limit_mode", "default_max_running", "key_fields", "priority", "default_max_attempts", "user_visible"];
const inventoryTypes = new Set((inventory.jobs || []).map((entry) => String(entry.type || "")));
const valid = Number.isInteger(Number(document.version)) && Number(document.version) >= 1
  && byType.size === inventoryTypes.size
  && [...inventoryTypes].every((type) => byType.has(type))
  && entries.every(([, policy]) => requiredFields.every((field) => Object.hasOwn(policy, field))
    && ["background", "interactive", "node"].includes(policy.execution_mode)
    && String(policy.concurrency_group || "").trim()
    && ["invariant", "capacity", "unlimited"].includes(policy.limit_mode)
    && (policy.limit_mode === "unlimited"
      ? policy.default_max_running === null
      : Number.isInteger(policy.default_max_running) && policy.default_max_running >= 1)
    && Array.isArray(policy.key_fields)
    && Number.isInteger(policy.priority)
    && Number.isInteger(policy.default_max_attempts) && policy.default_max_attempts >= 1
    && typeof policy.user_visible === "boolean");
const groupPolicies = new Map();
for (const [, policy] of entries) {
  const current = { limit_mode: policy.limit_mode, default_max_running: policy.default_max_running };
  const previous = groupPolicies.get(policy.concurrency_group);
  if (previous && (previous.limit_mode !== current.limit_mode
    || previous.default_max_running !== current.default_max_running)) {
    throw new Error(`Inconsistent limit policy for ${policy.concurrency_group}`);
  }
  groupPolicies.set(policy.concurrency_group, Object.freeze(current));
}
if (!valid) {
  throw new Error("config/worker-job-policy.json is invalid");
}

export const WORKER_JOB_POLICY_VERSION = Number(document.version);
export const WORKER_JOB_AGING_SECONDS = Math.max(1, Number(document.aging_seconds || 60));

export function workerJobPolicy(jobType) {
  const normalized = String(jobType || "").trim();
  const policy = byType.get(normalized);
  if (!policy) throw new Error(`No worker job policy is declared for ${normalized || "<empty>"}`);
  return policy;
}

function payloadValue(payload, field) {
  let value = payload;
  for (const part of String(field).split(".")) value = value?.[/^\d+$/.test(part) ? Number(part) : part];
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    }
    return item;
  };
  const text = value && typeof value === "object" ? JSON.stringify(canonical(value)) : String(value ?? "");
  return text.trim().replaceAll("\\", "/");
}

function canonicalUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const ordered = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => compare(ak, bk) || compare(av, bv));
    url.search = "";
    for (const [key, item] of ordered) url.searchParams.append(key, item);
    return url.toString();
  } catch {
    return raw.replaceAll("\\", "/");
  }
}

function transformKeyValue(value, transform) {
  if (transform !== "canonical_url_set_sha256") return value;
  let parsed = value;
  try { parsed = JSON.parse(value); } catch {}
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const canonical = [...new Set(candidates.map(canonicalUrl).filter(Boolean))].sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function resolveWorkerJobPolicy(jobType, payload = {}) {
  const policy = workerJobPolicy(jobType);
  let concurrencyKey = String(policy.fixed_key || "").trim();
  if (!concurrencyKey) {
    const field = (policy.key_fields || []).find((candidate) => payloadValue(payload, candidate));
    if (field) {
      const value = transformKeyValue(payloadValue(payload, field), policy.key_transform);
      concurrencyKey = String(policy.key_format || `${policy.key_prefix || jobType}:{value}`).replace("{value}", value);
    }
  }
  return {
    ...policy,
    concurrency_key: concurrencyKey,
    policy_version: WORKER_JOB_POLICY_VERSION
  };
}

export function allWorkerJobPolicies() {
  return Array.from(byType.values());
}

export function allWorkerGroupPolicies() {
  return Object.fromEntries(groupPolicies);
}
