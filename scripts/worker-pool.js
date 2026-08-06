import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import pg from "pg";

import { databaseUrlFromEnv } from "../server/db.js";
import { loadDotEnv } from "../server/env.js";

const { Client } = pg;
const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LEADER_LOCK_NAMESPACE = 724111;
const LEADER_LOCK_KEY = 1;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;
const DEFAULT_RESTART_BASE_MS = 500;
const DEFAULT_RESTART_MAX_MS = 30000;

loadDotEnv(join(ROOT_DIR, ".env"));

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on", "enabled"].includes(String(value).trim().toLowerCase());
}

export function createGenerationSeed() {
  return `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export function restartDelayMs(failures, baseMs = DEFAULT_RESTART_BASE_MS, maximumMs = DEFAULT_RESTART_MAX_MS) {
  const exponent = Math.max(0, Number(failures || 1) - 1);
  return Math.min(maximumMs, baseMs * (2 ** exponent));
}

export function selectScaleDownSlots(workers, statuses, count) {
  const candidates = [...workers.values()].filter((worker) => !worker.draining);
  candidates.sort((left, right) => {
    const leftStatus = statuses.get(left.workerId);
    const rightStatus = statuses.get(right.workerId);
    const leftBusy = leftStatus?.current_job_id != null || leftStatus?.status === "running";
    const rightBusy = rightStatus?.current_job_id != null || rightStatus?.status === "running";
    if (leftBusy !== rightBusy) return leftBusy ? 1 : -1;
    return right.slot - left.slot;
  });
  return candidates.slice(0, Math.max(0, count));
}

export function initializeSchema({ run = spawnSync, pythonBin = process.env.PYTHON_BIN || "python" } = {}) {
  const result = run(pythonBin, ["-m", "worker.cli", "init-db"], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit",
    windowsHide: false
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    throw new Error(`database schema initialization failed (${result?.signal || `exit ${result?.status}`})`);
  }
}

export class WorkerPoolSupervisor {
  constructor({
    clientFactory = () => new Client({ connectionString: databaseUrlFromEnv() }),
    spawnChild = spawn,
    now = Date.now,
    pollIntervalMs = boundedInteger(process.env.KRIS_WORKER_POOL_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 250, 60000),
    shutdownTimeoutMs = boundedInteger(process.env.KRIS_WORKER_POOL_SHUTDOWN_TIMEOUT_MS, DEFAULT_SHUTDOWN_TIMEOUT_MS, 1000, 300000),
    restartBaseMs = DEFAULT_RESTART_BASE_MS,
    restartMaxMs = DEFAULT_RESTART_MAX_MS,
    pythonBin = process.env.PYTHON_BIN || "python",
    host = hostname(),
    generationSeed = createGenerationSeed()
  } = {}) {
    this.clientFactory = clientFactory;
    this.spawnChild = spawnChild;
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.restartBaseMs = restartBaseMs;
    this.restartMaxMs = restartMaxMs;
    this.pythonBin = pythonBin;
    this.host = host;
    this.generationSeed = generationSeed;
    this.client = null;
    this.workers = new Map();
    this.slotGenerations = new Map();
    this.restartState = new Map();
    this.desired = 0;
    this.revision = null;
    this.leader = false;
    this.shuttingDown = false;
    this.pollTimer = null;
    this.shutdownTimer = null;
    this.lastStatusSignature = "";
    this.exitResolve = null;
    this.finishing = false;
    this.exitPromise = new Promise((resolveExit) => { this.exitResolve = resolveExit; });
  }

  async connectAndElect() {
    if (this.client) {
      if (this.leader) return true;
      const retry = await this.client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [
        LEADER_LOCK_NAMESPACE,
        LEADER_LOCK_KEY
      ]);
      this.leader = retry.rows?.[0]?.acquired === true;
      if (this.leader) console.log("[worker-pool] leader lock acquired after standby");
      return this.leader;
    }
    const client = this.clientFactory();
    client.on?.("error", (error) => this.handleLeaderConnectionError(client, error));
    await client.connect();
    const result = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [
      LEADER_LOCK_NAMESPACE,
      LEADER_LOCK_KEY
    ]);
    this.client = client;
    this.leader = result.rows?.[0]?.acquired === true;
    console.log(`[worker-pool] ${this.leader ? "leader lock acquired" : "leader lock held by another supervisor; standing by"}`);
    return this.leader;
  }

  handleLeaderConnectionError(client, error) {
    if (this.client !== client) return;
    const heldLeaderLock = this.leader;
    this.client = null;
    this.leader = false;
    try {
      const ending = client.end?.();
      ending?.catch?.(() => {});
    } catch {
      // The failed client may already be closed; leadership safety does not depend on cleanup succeeding.
    }
    console.error(`[worker-pool] database leadership connection lost: ${error.message}`);
    if (heldLeaderLock && !this.shuttingDown) {
      console.error("[worker-pool] draining children because the session leader lock was lost");
      for (const record of this.workers.values()) this.requestDrain(record);
    }
  }

  async readPolicy() {
    const result = await this.client.query(
      "SELECT revision, worker_process_count FROM worker_runtime_policy WHERE singleton_id = 1"
    );
    const row = result.rows?.[0];
    if (!row) throw new Error("worker_runtime_policy singleton row is missing");
    const desired = boundedInteger(row.worker_process_count, 0, 1, 16);
    if (!desired) throw new Error("worker_runtime_policy.worker_process_count is invalid");
    return { revision: Number(row.revision), desired };
  }

  async readWorkerStatuses() {
    if (!this.workers.size) return new Map();
    const ids = [...this.workers.values()].map((worker) => worker.workerId);
    const result = await this.client.query(
      "SELECT worker_id, status, current_job_id FROM worker_instances WHERE worker_id = ANY($1::text[])",
      [ids]
    );
    return new Map((result.rows || []).map((row) => [String(row.worker_id), row]));
  }

  nextFreeSlot() {
    for (let slot = 1; slot <= 16; slot += 1) {
      if (!this.workers.has(slot)) return slot;
    }
    return null;
  }

  spawnWorker(slot) {
    const generation = (this.slotGenerations.get(slot) || 0) + 1;
    this.slotGenerations.set(slot, generation);
    const workerId = `${this.host}:pool:${slot}:${this.generationSeed}-${generation}`;
    const child = this.spawnChild(this.pythonBin, ["-m", "worker.service"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        KRIS_WORKER_ID: workerId,
        KRIS_WORKER_INIT_DB_ON_START: "false"
      },
      stdio: "inherit",
      windowsHide: false
    });
    const record = { slot, generation, workerId, child, draining: false, expectedExit: false };
    this.workers.set(slot, record);
    console.log(`[worker-pool] spawned ${workerId}`);
    child.once("error", (error) => this.handleChildExit(record, null, null, error));
    child.once("exit", (code, signal) => this.handleChildExit(record, code, signal));
    return record;
  }

  handleChildExit(record, code, signal, error = null) {
    if (this.workers.get(record.slot) !== record) return;
    this.workers.delete(record.slot);
    if (!record.expectedExit && !this.shuttingDown) {
      const previous = this.restartState.get(record.slot)?.failures || 0;
      const failures = previous + 1;
      const delay = restartDelayMs(failures, this.restartBaseMs, this.restartMaxMs);
      this.restartState.set(record.slot, { failures, nextSpawnAt: this.now() + delay });
      console.error(`[worker-pool] ${record.workerId} stopped unexpectedly (${error?.message || signal || `exit ${code}`}); retry in ${delay}ms`);
    } else {
      this.restartState.delete(record.slot);
      console.log(`[worker-pool] ${record.workerId} stopped`);
    }
    if (this.shuttingDown && this.workers.size === 0) this.finishShutdown();
  }

  requestDrain(record) {
    if (!record || record.draining) return;
    record.draining = true;
    record.expectedExit = true;
    console.log(`[worker-pool] draining ${record.workerId}`);
    try {
      record.child.kill("SIGTERM");
    } catch (error) {
      console.error(`[worker-pool] failed to signal ${record.workerId}: ${error.message}`);
    }
  }

  async reconcile(policy) {
    this.desired = policy.desired;
    this.revision = policy.revision;
    const alreadyDraining = [...this.workers.values()].filter((worker) => worker.draining).length;
    const drainCount = Math.max(0, this.workers.size - this.desired - alreadyDraining);
    if (drainCount > 0) {
      const statuses = await this.readWorkerStatuses();
      for (const record of selectScaleDownSlots(this.workers, statuses, drainCount)) this.requestDrain(record);
    }
    while (!this.shuttingDown && this.workers.size < this.desired) {
      const slot = this.nextFreeSlot();
      if (slot === null) break;
      const restart = this.restartState.get(slot);
      if (restart && restart.nextSpawnAt > this.now()) break;
      this.spawnWorker(slot);
    }
    this.logStatus();
  }

  logStatus() {
    const draining = [...this.workers.values()].filter((worker) => worker.draining).length;
    const restartCount = [...this.restartState.values()].reduce(
      (total, state) => total + Number(state.failures || 0),
      0
    );
    const status = {
      event: "worker_pool.status",
      revision: this.revision,
      desired: this.desired,
      running: this.workers.size - draining,
      draining,
      restart_count: restartCount
    };
    const signature = JSON.stringify(status);
    if (signature === this.lastStatusSignature) return status;
    this.lastStatusSignature = signature;
    console.log(signature);
    return status;
  }

  async poll() {
    if (this.shuttingDown) return;
    try {
      if (!await this.connectAndElect()) return;
      const policy = await this.readPolicy();
      await this.reconcile(policy);
    } catch (error) {
      console.error(`[worker-pool] reconciliation degraded: ${error.message}`);
      // A policy/status query error does not release the session advisory lock.
      // Keep the existing children unchanged and retry on the same connection.
    }
  }

  schedulePoll() {
    if (this.shuttingDown) return;
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  async start() {
    await this.poll();
    this.schedulePoll();
    return this.exitPromise;
  }

  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return this.exitPromise;
    this.shuttingDown = true;
    this.requestedExitCode = exitCode;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const record of this.workers.values()) this.requestDrain(record);
    if (!this.workers.size) {
      this.finishShutdown(exitCode);
      return this.exitPromise;
    }
    this.shutdownTimer = setTimeout(() => {
      console.error("[worker-pool] graceful shutdown timed out; terminating remaining workers");
      for (const record of this.workers.values()) {
        try { record.child.kill("SIGKILL"); } catch { /* already stopped */ }
      }
      this.finishShutdown(exitCode || 1);
    }, this.shutdownTimeoutMs);
    this.shutdownTimer.unref?.();
    return this.exitPromise;
  }

  finishShutdown(exitCode = this.requestedExitCode || 0) {
    if (!this.exitResolve || this.finishing) return;
    this.finishing = true;
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    const resolveExit = this.exitResolve;
    const client = this.client;
    this.client = null;
    this.leader = false;
    Promise.resolve()
      .then(() => client?.end?.())
      .catch(() => {})
      .finally(() => {
        this.exitResolve = null;
        resolveExit(exitCode);
      });
  }
}

export async function main({
  initialize = initializeSchema,
  Supervisor = WorkerPoolSupervisor,
  installSignals = (supervisor) => {
    process.once("SIGINT", () => { void supervisor.shutdown(130); });
    process.once("SIGTERM", () => { void supervisor.shutdown(143); });
  }
} = {}) {
  if (envFlag("KRIS_WORKER_POOL_INIT_DB_ON_START", true)) initialize();
  const supervisor = new Supervisor();
  installSignals(supervisor);
  return supervisor.start();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`[worker-pool] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  }
}
