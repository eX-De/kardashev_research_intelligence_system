import assert from "node:assert/strict";
import test from "node:test";

import { initializeSchema, main, parentShutdownTimeoutMs } from "../../scripts/start.js";

test("parent shutdown timeout is strictly longer than the worker-pool drain bound", () => {
  assert.equal(parentShutdownTimeoutMs({}), 35000);
  assert.equal(parentShutdownTimeoutMs({ KRIS_WORKER_POOL_SHUTDOWN_TIMEOUT_MS: "12000" }), 17000);
  assert.equal(parentShutdownTimeoutMs({ KRIS_WORKER_POOL_SHUTDOWN_TIMEOUT_MS: "999999" }), 305000);
});

test("npm start initializes the schema before launching compute, api, and the worker pool", () => {
  const order = [];
  const launches = [];

  main({
    installSignals() {},
    initialize() {
      order.push("init-db");
    },
    launch(name, command, args, options) {
      order.push(name);
      launches.push({ name, command, args, options });
    }
  });

  assert.deepEqual(order, ["init-db", "compute", "api", "worker"]);
  assert.deepEqual(launches.at(-1), {
    name: "worker",
    command: process.execPath,
    args: ["scripts/worker-pool.js"],
    options: { env: { KRIS_WORKER_POOL_INIT_DB_ON_START: "false" } }
  });
});

test("schema initialization failure prevents both long-running processes", () => {
  const launched = [];

  assert.throws(
    () => main({
      installSignals() {},
      initialize() {
        throw new Error("migration failed");
      },
      launch(name) {
        launched.push(name);
      }
    }),
    /migration failed/
  );
  assert.deepEqual(launched, []);
});

test("schema initialization invokes the worker cli synchronously", () => {
  const calls = [];

  initializeSchema({
    run(command, args, options) {
      calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
      return { status: 0, signal: null };
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["-m", "worker.cli", "init-db"]);
  assert.equal(calls[0].stdio, "inherit");
});
