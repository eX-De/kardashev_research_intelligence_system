import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { loadDotEnv } from "../server/env.js";

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadDotEnv(join(ROOT_DIR, ".env"));

const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const children = new Map();
let shuttingDown = false;
let requestedExitCode = 0;
let forcedExitTimer = null;

function formatExit(code, signal) {
  if (code !== null && code !== undefined) return `exit code ${code}`;
  if (signal) return `signal ${signal}`;
  return "unknown exit";
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.killed) return;
  try {
    child.kill();
  } catch {
    // The child may have already exited between the status check and kill.
  }
}

function finishIfStopped() {
  if (!shuttingDown || children.size > 0) return;
  if (forcedExitTimer) clearTimeout(forcedExitTimer);
  process.exit(requestedExitCode);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedExitCode = exitCode;
  for (const child of children.values()) stopChild(child);
  forcedExitTimer = setTimeout(() => {
    process.exit(requestedExitCode || 1);
  }, 5000);
  forcedExitTimer.unref?.();
  finishIfStopped();
}

function startProcess(name, command, args) {
  console.log(`[start] launching ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit",
    windowsHide: false
  });
  children.set(name, child);
  child.on("error", (error) => {
    console.error(`[start] failed to launch ${name}: ${error.message}`);
    children.delete(name);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      const exitCode = code === 0 ? 0 : 1;
      console.error(`[start] ${name} stopped with ${formatExit(code, signal)}; shutting down remaining services`);
      shutdown(exitCode);
      return;
    }
    finishIfStopped();
  });
  return child;
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

startProcess("api", process.execPath, ["server.js"]);
startProcess("worker", PYTHON_BIN, ["-m", "worker.service"]);
