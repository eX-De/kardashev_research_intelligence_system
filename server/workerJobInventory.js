import { readFileSync } from "node:fs";

const inventoryDocument = JSON.parse(
  readFileSync(new URL("../config/worker-job-inventory.json", import.meta.url), "utf8")
);

const entries = Array.isArray(inventoryDocument.jobs) ? inventoryDocument.jobs : [];
const byType = new Map(entries.map((entry) => [String(entry.type || ""), Object.freeze({ ...entry })]));

if (byType.size !== entries.length || byType.has("")) {
  throw new Error("config/worker-job-inventory.json contains an empty or duplicate job type");
}

export const WORKER_JOB_INVENTORY_VERSION = Number(inventoryDocument.version || 1);
export const WORKER_JOB_INVENTORY = Object.freeze(Array.from(byType.values()));
export const WORKER_JOB_TYPES = Object.freeze(WORKER_JOB_INVENTORY.map((entry) => entry.type));

export function workerJobDefinition(jobType) {
  return byType.get(String(jobType || "")) || null;
}

export function workerJobConcurrencyGroup(jobType) {
  return workerJobDefinition(jobType)?.concurrency_group || "unclassified";
}

export function workerJobTitle(jobType) {
  return workerJobDefinition(jobType)?.label || String(jobType || "任务");
}
