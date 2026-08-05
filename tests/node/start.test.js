import assert from "node:assert/strict";
import test from "node:test";

import { initializeSchema, main } from "../../scripts/start.js";

test("npm start initializes the schema before launching compute, api, and worker", () => {
  const order = [];

  main({
    installSignals() {},
    initialize() {
      order.push("init-db");
    },
    launch(name) {
      order.push(name);
    }
  });

  assert.deepEqual(order, ["init-db", "compute", "api", "worker"]);
});

test("legacy compute backend does not launch or require compute service", () => {
  const previous = process.env.KRIS_COMPUTE_BACKEND;
  process.env.KRIS_COMPUTE_BACKEND = "legacy";
  const launched = [];
  try {
    main({ installSignals() {}, initialize() {}, launch(name) { launched.push(name); } });
    assert.deepEqual(launched, ["api", "worker"]);
  } finally {
    if (previous === undefined) delete process.env.KRIS_COMPUTE_BACKEND;
    else process.env.KRIS_COMPUTE_BACKEND = previous;
  }
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
