import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  WorkerPoolSupervisor,
  main,
  restartDelayMs,
  selectScaleDownSlots
} from "../../scripts/worker-pool.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    return true;
  }
}

test("scale-down selection drains idle workers before busy workers", () => {
  const workers = new Map([
    [1, { slot: 1, workerId: "one", draining: false }],
    [2, { slot: 2, workerId: "two", draining: false }],
    [3, { slot: 3, workerId: "three", draining: false }]
  ]);
  const statuses = new Map([
    ["one", { status: "running", current_job_id: 7 }],
    ["two", { status: "idle", current_job_id: null }],
    ["three", { status: "idle", current_job_id: null }]
  ]);

  assert.deepEqual(selectScaleDownSlots(workers, statuses, 2).map((item) => item.slot), [3, 2]);
});

test("reconcile scales out independent Python workers and drains surplus workers", async () => {
  const calls = [];
  const supervisor = new WorkerPoolSupervisor({
    host: "test-host",
    generationSeed: "test-seed",
    spawnChild(command, args, options) {
      const child = new FakeChild();
      calls.push({ command, args, options, child });
      return child;
    }
  });
  supervisor.client = {
    async query() {
      return {
        rows: [
          { worker_id: "test-host:pool:1:test-seed-1", status: "running", current_job_id: 5 },
          { worker_id: "test-host:pool:2:test-seed-1", status: "idle", current_job_id: null },
          { worker_id: "test-host:pool:3:test-seed-1", status: "idle", current_job_id: null }
        ]
      };
    }
  };

  await supervisor.reconcile({ revision: 2, desired: 3 });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.args), Array(3).fill(["-m", "worker.service"]));
  assert.deepEqual(calls.map((call) => call.options.env.KRIS_WORKER_ID), [
    "test-host:pool:1:test-seed-1",
    "test-host:pool:2:test-seed-1",
    "test-host:pool:3:test-seed-1"
  ]);
  assert.ok(calls.every((call) => call.options.env.KRIS_WORKER_INIT_DB_ON_START === "false"));

  await supervisor.reconcile({ revision: 3, desired: 1 });
  assert.deepEqual(calls.map((call) => call.child.signals), [[], ["SIGTERM"], ["SIGTERM"]]);
  assert.equal(supervisor.workers.get(1).draining, false);

  await supervisor.reconcile({ revision: 3, desired: 1 });
  assert.deepEqual(calls.map((call) => call.child.signals), [[], ["SIGTERM"], ["SIGTERM"]]);
});

test("unexpected child exit uses bounded exponential backoff", async () => {
  let now = 1000;
  const children = [];
  const supervisor = new WorkerPoolSupervisor({
    now: () => now,
    restartBaseMs: 100,
    restartMaxMs: 250,
    spawnChild() {
      const child = new FakeChild();
      children.push(child);
      return child;
    }
  });

  await supervisor.reconcile({ revision: 1, desired: 1 });
  children[0].emit("exit", 1, null);
  assert.equal(supervisor.restartState.get(1).nextSpawnAt, 1100);
  await supervisor.reconcile({ revision: 1, desired: 1 });
  assert.equal(children.length, 1);
  now = 1100;
  await supervisor.reconcile({ revision: 1, desired: 1 });
  assert.equal(children.length, 2);
  assert.equal(restartDelayMs(9, 100, 250), 250);
});

test("a standby supervisor cannot spawn a duplicate pool", async () => {
  let policyReads = 0;
  let spawns = 0;
  const client = {
    async connect() {},
    async query(sql) {
      if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ acquired: false }] };
      policyReads += 1;
      return { rows: [{ revision: 1, worker_process_count: 4 }] };
    }
  };
  const supervisor = new WorkerPoolSupervisor({
    clientFactory: () => client,
    spawnChild() {
      spawns += 1;
      return new FakeChild();
    }
  });

  await supervisor.poll();
  await supervisor.poll();
  assert.equal(policyReads, 0);
  assert.equal(spawns, 0);
  await client.end?.();
});

test("supervisor shutdown asks every child to drain and waits for their exits", async () => {
  const children = [];
  let clientEnds = 0;
  const supervisor = new WorkerPoolSupervisor({
    spawnChild() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    shutdownTimeoutMs: 5000
  });
  await supervisor.reconcile({ revision: 1, desired: 2 });
  supervisor.client = { async end() { clientEnds += 1; } };
  supervisor.leader = true;

  const stopped = supervisor.shutdown(143);
  const stoppedAgain = supervisor.shutdown(0);
  assert.deepEqual(children.map((child) => child.signals), [["SIGTERM"], ["SIGTERM"]]);
  assert.equal(clientEnds, 0);
  children[0].emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(clientEnds, 0);
  children[1].emit("exit", 0, null);
  assert.equal(await stopped, 143);
  assert.equal(await stoppedAgain, 143);
  assert.equal(clientEnds, 1);
});

test("losing the session leader lock drains children so another supervisor cannot multiply capacity", async () => {
  const children = [];
  const supervisor = new WorkerPoolSupervisor({
    spawnChild() {
      const child = new FakeChild();
      children.push(child);
      return child;
    }
  });
  let ended = 0;
  const client = { async end() { ended += 1; } };
  supervisor.client = client;
  supervisor.leader = true;
  await supervisor.reconcile({ revision: 1, desired: 2 });

  supervisor.handleLeaderConnectionError(client, new Error("connection terminated"));
  assert.equal(supervisor.leader, false);
  assert.equal(supervisor.client, null);
  assert.deepEqual(children.map((child) => child.signals), [["SIGTERM"], ["SIGTERM"]]);
  await Promise.resolve();
  assert.equal(ended, 1);

  const replacementClient = {};
  supervisor.client = replacementClient;
  supervisor.handleLeaderConnectionError(client, new Error("late old-client error"));
  assert.equal(supervisor.client, replacementClient);
});

test("worker-pool main initializes by default and honors the source-start skip override", async () => {
  const previous = process.env.KRIS_WORKER_POOL_INIT_DB_ON_START;
  let initialized = 0;
  let started = 0;
  class FakeSupervisor {
    start() {
      started += 1;
      return 0;
    }
  }
  try {
    delete process.env.KRIS_WORKER_POOL_INIT_DB_ON_START;
    assert.equal(await main({
      initialize() { initialized += 1; },
      Supervisor: FakeSupervisor,
      installSignals() {}
    }), 0);

    process.env.KRIS_WORKER_POOL_INIT_DB_ON_START = "false";
    assert.equal(await main({
      initialize() { initialized += 1; },
      Supervisor: FakeSupervisor,
      installSignals() {}
    }), 0);
  } finally {
    if (previous === undefined) delete process.env.KRIS_WORKER_POOL_INIT_DB_ON_START;
    else process.env.KRIS_WORKER_POOL_INIT_DB_ON_START = previous;
  }
  assert.equal(initialized, 1);
  assert.equal(started, 2);
});

test("separate supervisors on the same host generate distinct default worker IDs", async () => {
  const ids = [];
  function spawnChild(_command, _args, options) {
    ids.push(options.env.KRIS_WORKER_ID);
    return new FakeChild();
  }
  const first = new WorkerPoolSupervisor({ host: "same-host", spawnChild });
  const second = new WorkerPoolSupervisor({ host: "same-host", spawnChild });
  await first.reconcile({ revision: 1, desired: 1 });
  await second.reconcile({ revision: 1, desired: 1 });

  assert.notEqual(ids[0], ids[1]);
  assert.match(ids[0], /^same-host:pool:1:[^:]+-1$/);
  assert.match(ids[1], /^same-host:pool:1:[^:]+-1$/);
});
