import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ENV_PATH = join(__dirname, ".env");
loadDotEnv(ENV_PATH);

const PORT = Number(process.env.PORT || 3000);
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const DIST_DIR = join(__dirname, "dist");
const PUBLIC_DIR = existsSync(DIST_DIR) ? DIST_DIR : join(__dirname, "public");
const PANEL_PASSWORD = envValue("PANEL_PASSWORD", "");
const PANEL_SESSION_SECRET = envValue("PANEL_SESSION_SECRET", "") || randomBytes(32).toString("base64url");
const PANEL_SESSION_TTL_SECONDS = positiveInteger(process.env.PANEL_SESSION_TTL_SECONDS, 604800);
const PANEL_SESSION_COOKIE_NAME = "panel_session";
const KRIS_AGENT_TOKEN = envValue("KRIS_AGENT_TOKEN", "");
const PAPER_REPORT_QUEUE_INTERVAL_MS = Math.max(2000, Number(process.env.PAPER_REPORT_QUEUE_INTERVAL_MS || 5000));
const PAPER_REPORT_QUEUE_DEFAULT_CONCURRENCY = Math.max(
  1,
  Number(process.env.PAPER_REPORT_QUEUE_CONCURRENCY || process.env.PAPER_REPORT_QUEUE_LIMIT || 1)
);
const OBSIDIAN_NOT_CONFIGURED_CODE = "obsidian_not_configured";
const IN_MEMORY_JOB_RECONCILE_GRACE_MS = Math.max(
  5000,
  Number(process.env.IN_MEMORY_JOB_RECONCILE_GRACE_MS || 60000)
);
const SSE_HEARTBEAT_MS = Math.max(5000, positiveInteger(process.env.SSE_HEARTBEAT_MS, 25000));
const DAILY_PROGRESS_SSE_THROTTLE_MS = Math.max(
  250,
  Number(process.env.DAILY_PROGRESS_SSE_THROTTLE_MS || 1000)
);
const UPDATE_CHECK_ENABLED = envBoolean("KRIS_UPDATE_CHECK_ENABLED", true);
const UPDATE_CHECK_INITIAL_DELAY_MS = Math.max(
  0,
  Number(process.env.KRIS_UPDATE_CHECK_INITIAL_DELAY_MS || 30000)
);
const UPDATE_CHECK_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.KRIS_UPDATE_CHECK_INTERVAL_MS || 12 * 60 * 60 * 1000)
);
const WORKER_PROGRESS_EVENT_PREFIX = "KRIS_PROGRESS_EVENT ";
const DAILY_JOB_COMMANDS = new Set(["run-daily", "resume-daily", "retry-daily"]);
const PAPER_REPORT_QUEUE_COMMAND = "generate-paper-reports";

const jobRuntime = {
  currentJob: null,
  lastJob: null
};

const schedulerRuntime = {
  enabled: false,
  timer: null,
  nextRunAt: null,
  lastError: null
};

const startupDailyRuntime = {
  enabled: false,
  triggerInFlight: false,
  lastCheckAt: null,
  lastRunAt: null,
  lastSkipReason: null,
  lastError: null
};

const paperReportQueueRuntime = {
  enabled: true,
  timer: null,
  active: 0,
  activeJobs: [],
  concurrency: PAPER_REPORT_QUEUE_DEFAULT_CONCURRENCY,
  lastCheckAt: null,
  lastRunAt: null,
  lastSkipReason: null,
  lastError: null
};

const updateCheckRuntime = {
  enabled: UPDATE_CHECK_ENABLED,
  timer: null,
  checking: false,
  lastCheckAt: null,
  lastError: null,
  lastNotifiedVersion: null
};

const eventBus = {
  nextEventId: 1,
  nextClientId: 1,
  clients: new Map(),
  heartbeatTimer: null
};

const SERVER_EVENTS = Object.freeze({
  ARTIFACT_CREATED: "artifact.created",
  ARTIFACT_UPDATED: "artifact.updated",
  APP_UPDATE_AVAILABLE: "app.update_available",
  DAILY_RUN_PROGRESS_UPDATED: "daily_run_progress.updated",
  EVENTS_CONNECTED: "events.connected",
  EXPERIMENT_REPORT_UPSERTED: "experiment_report.upserted",
  JOB_FAILED: "job.failed",
  JOB_FINISHED: "job.finished",
  JOB_STARTED: "job.started",
  PAPER_FEEDBACK_UPDATED: "paper.feedback.updated",
  PAPER_LIBRARY_STATUS_UPDATED: "paper.library_status.updated",
  PAPER_RECOMMENDATION_UPDATED: "paper.recommendation.updated",
  PAPER_REPORT_DELETED: "paper_report.deleted",
  PAPER_REPORT_UPDATED: "paper_report.updated",
  PROJECT_CREATED: "project.created",
  PROJECT_NOTE_LINKED: "project_note.linked",
  PROJECT_NOTE_UNLINKED: "project_note.unlinked",
  PROJECT_PAPER_LINKED: "project_paper.linked",
  PROJECT_PAPER_UNLINKED: "project_paper.unlinked",
  PROJECT_UPDATED: "project.updated",
  READER_MESSAGE_DELETED: "reader.message.deleted",
  READER_MESSAGE_UPDATED: "reader.message.updated",
  READER_PAPER_UPDATED: "reader.paper.updated",
  READER_PAPERS_IMPORTED: "reader.papers.imported",
  SETTINGS_CHANGED: "settings.changed",
  TASK_FAILED: "task.failed",
  TASK_FINISHED: "task.finished",
  TASK_STARTED: "task.started"
});

const SCHEDULER_MODE_FIELDS = new Set(["run_daily_on_startup_enabled", "scheduler_enabled"]);
const SCHEDULER_MODES = new Set(["off", "scheduler", "startup"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8"
};

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function envValue(name, fallback = "") {
  const filePath = String(process.env[`${name}_FILE`] || "").trim();
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(`Failed to read ${name}_FILE (${filePath}): ${error.message}`);
    }
  }
  return process.env[name] ?? fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envBoolean(name, fallback = false) {
  const raw = envValue(name, fallback ? "true" : "false");
  return new Set(["1", "true", "yes", "on", "enabled"]).has(String(raw).trim().toLowerCase());
}

function workerErrorFromOutput(error, stdout = "", stderr = "") {
  let message = error?.message || "Worker failed";
  const stderrText = String(stderr || "").trim();
  const stdoutText = String(stdout || "").trim();
  let workerPayload = null;
  try {
    const parsed = JSON.parse(stdoutText || "{}");
    if (parsed && typeof parsed === "object") {
      workerPayload = parsed;
      if (parsed.error) message = String(parsed.error);
    }
  } catch {
    message = stderrText || stdoutText || message;
  }
  if (stderrText && !String(message).includes(stderrText)) {
    message = `${message}\n${stderrText}`.trim();
  }
  const err = new Error(message);
  const structuredCode = String(workerPayload?.code || workerPayload?.reason || "");
  if (structuredCode) {
    err.structuredCode = structuredCode;
    err.code = structuredCode;
    err.reason = String(workerPayload?.reason || structuredCode);
    err.workerPayload = workerPayload;
  }
  err.statusCode = Number(workerPayload?.status_code || 0) || (
    structuredCode === OBSIDIAN_NOT_CONFIGURED_CODE ? 409 : 500
  );
  err.stdout = stdoutText;
  err.stderr = stderrText;
  return err;
}

function worker(args, input = null) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      PYTHON_BIN,
      ["-m", "worker.cli", ...args],
      {
        cwd: __dirname,
        env: {
          ...process.env,
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8"
        },
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout, stderr) => {
        if (error) {
          if (stderr) {
            console.error(stderr.trimEnd());
          }
          reject(workerErrorFromOutput(error, stdout, stderr));
          return;
        }
        resolvePromise(stdout);
      }
    );
  if (input !== null) child.stdin.end(input, "utf8");
  });
}

function handleWorkerProgressLine(line, onProgressEvent, stderrLines) {
  if (line.startsWith(WORKER_PROGRESS_EVENT_PREFIX)) {
    const rawPayload = line.slice(WORKER_PROGRESS_EVENT_PREFIX.length).trim();
    try {
      const payload = JSON.parse(rawPayload || "{}");
      if (payload && typeof payload === "object" && typeof onProgressEvent === "function") {
        try {
          onProgressEvent(payload);
        } catch (error) {
          console.error(error.stack || error.message || error);
        }
      }
    } catch {
      stderrLines.push(line);
    }
    return;
  }
  if (line) stderrLines.push(line);
}

function managedWorker(args, input = null, { onProgressEvent = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(PYTHON_BIN, ["-m", "worker.cli", ...args], {
      cwd: __dirname,
      env: {
        ...process.env,
        KRIS_WORKER_PROGRESS_EVENTS: "1",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderrBuffer = "";
    let settled = false;
    const stderrLines = [];

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) handleWorkerProgressLine(line, onProgressEvent, stderrLines);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (stderrBuffer) handleWorkerProgressLine(stderrBuffer, onProgressEvent, stderrLines);
      reject(workerErrorFromOutput(error, stdout, stderrLines.join("\n")));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (stderrBuffer) handleWorkerProgressLine(stderrBuffer, onProgressEvent, stderrLines);
      const stderr = stderrLines.join("\n");
      if (code === 0 && !signal) {
        resolvePromise(stdout);
        return;
      }
      const message = signal
        ? `Worker terminated by signal ${signal}`
        : `Worker exited with code ${code}`;
      reject(workerErrorFromOutput(new Error(message), stdout, stderr));
    });

    if (input !== null) child.stdin.end(input, "utf8");
    else child.stdin.end();
  });
}

function streamWorkerEvents(args, input, res) {
  return new Promise((resolvePromise) => {
    const child = spawn(PYTHON_BIN, ["-m", "worker.cli", ...args], {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let buffer = "";
    let stderr = "";
    let closedByClient = false;

    const writeEvent = (event, data) => {
      if (closedByClient || res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        writeEvent(parsed.event || "message", parsed.data || {});
      } catch {
        writeEvent("error", { error: `Worker stream returned invalid JSON: ${trimmed.slice(0, 300)}` });
      }
    };

    res.on("close", () => {
      if (!res.writableEnded) {
        closedByClient = true;
        child.kill();
      }
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      writeEvent("error", { error: error.message });
      if (!res.writableEnded) res.end();
      resolvePromise();
    });
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      if (code !== 0 && !closedByClient) {
        writeEvent("error", { error: stderr.trim() || `Worker exited with code ${code}` });
      }
      if (!res.writableEnded) res.end();
      resolvePromise();
    });
    child.stdin.end(input ?? "", "utf8");
  });
}

function toIso(date) {
  return date ? new Date(date).toISOString() : null;
}

function computeNextRun(settings) {
  const now = new Date();
  const runTime = String(settings.scheduler_run_time || "09:00");
  const [hourRaw, minuteRaw] = runTime.split(":");
  const hour = Math.min(23, Math.max(0, Number(hourRaw || 9)));
  const minute = Math.min(59, Math.max(0, Number(minuteRaw || 0)));
  const intervalHours = Math.max(1, Number(settings.scheduler_interval_hours || 24));

  if (jobRuntime.lastJob?.finished_at && intervalHours !== 24) {
    const intervalNext = new Date(new Date(jobRuntime.lastJob.finished_at).getTime() + intervalHours * 60 * 60 * 1000);
    if (intervalNext > now) return intervalNext;
  }

  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function paperReportQueueConcurrency(settings = {}) {
  const value = Number(settings.paper_report_queue_concurrency || PAPER_REPORT_QUEUE_DEFAULT_CONCURRENCY);
  return Math.max(1, Math.min(8, Number.isFinite(value) ? Math.floor(value) : PAPER_REPORT_QUEUE_DEFAULT_CONCURRENCY));
}

function schedulerStatus() {
  return {
    enabled: schedulerRuntime.enabled,
    next_run_at: toIso(schedulerRuntime.nextRunAt),
    current_job: jobRuntime.currentJob,
    last_job: jobRuntime.lastJob,
    last_error: schedulerRuntime.lastError,
    startup_daily: {
      enabled: startupDailyRuntime.enabled,
      trigger_in_flight: startupDailyRuntime.triggerInFlight,
      last_check_at: startupDailyRuntime.lastCheckAt,
      last_run_at: startupDailyRuntime.lastRunAt,
      last_skip_reason: startupDailyRuntime.lastSkipReason,
      last_error: startupDailyRuntime.lastError
    },
    paper_report_queue: {
      enabled: paperReportQueueRuntime.enabled,
      active: paperReportQueueRuntime.active,
      active_jobs: paperReportQueueRuntime.activeJobs,
      concurrency: paperReportQueueRuntime.concurrency,
      last_check_at: paperReportQueueRuntime.lastCheckAt,
      last_run_at: paperReportQueueRuntime.lastRunAt,
      last_skip_reason: paperReportQueueRuntime.lastSkipReason,
      last_error: paperReportQueueRuntime.lastError
    }
  };
}

function normalizeEventType(type) {
  const normalized = String(type || "message").replace(/[^\w.-]/g, "_");
  return normalized || "message";
}

function removeEventClient(clientId) {
  eventBus.clients.delete(clientId);
  if (eventBus.clients.size === 0 && eventBus.heartbeatTimer) {
    clearInterval(eventBus.heartbeatTimer);
    eventBus.heartbeatTimer = null;
  }
}

function writeSseMessage(client, message) {
  if (!client || client.res.writableEnded || client.res.destroyed) {
    removeEventClient(client?.id);
    return false;
  }
  try {
    client.res.write(message);
    return true;
  } catch {
    removeEventClient(client.id);
    return false;
  }
}

function writeSseEvent(client, event) {
  return writeSseMessage(
    client,
    `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  );
}

function ensureEventHeartbeat() {
  if (eventBus.heartbeatTimer || eventBus.clients.size === 0) return;
  eventBus.heartbeatTimer = setInterval(() => {
    for (const client of eventBus.clients.values()) {
      writeSseMessage(client, `: ping ${new Date().toISOString()}\n\n`);
    }
  }, SSE_HEARTBEAT_MS);
  eventBus.heartbeatTimer.unref?.();
}

function publishEvent(type, data = {}) {
  const event = {
    id: eventBus.nextEventId++,
    type: normalizeEventType(type),
    emitted_at: new Date().toISOString(),
    data
  };
  for (const client of eventBus.clients.values()) {
    writeSseEvent(client, event);
  }
  return event;
}

function openEventStream(req, res) {
  const clientId = `${Date.now()}-${eventBus.nextClientId++}`;
  const client = { id: clientId, res };
  eventBus.clients.set(clientId, client);

  req.socket?.setTimeout?.(0);
  req.socket?.setKeepAlive?.(true);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  res.flushHeaders?.();

  req.on("close", () => {
    removeEventClient(clientId);
  });

  writeSseEvent(client, {
    id: eventBus.nextEventId++,
    type: SERVER_EVENTS.EVENTS_CONNECTED,
    emitted_at: new Date().toISOString(),
    data: { client_id: clientId }
  });
  ensureEventHeartbeat();
}

function compactTaskResult(result) {
  if (!result || typeof result !== "object") return result ?? null;
  const summary = {};
  for (const key of ["ok", "message", "stats", "created", "updated", "skipped", "errors"]) {
    if (Object.hasOwn(result, key)) summary[key] = result[key];
  }
  return Object.keys(summary).length ? summary : null;
}

function compactRuntimeJob(job) {
  if (!job) return null;
  return {
    id: job.id || null,
    command: job.command || null,
    source: job.source || null,
    args: Array.isArray(job.args) ? job.args : [],
    status: job.status || null,
    started_at: job.started_at || null,
    finished_at: job.finished_at || null,
    message: job.message || null
  };
}

function isDailyJobCommand(command) {
  return DAILY_JOB_COMMANDS.has(String(command || ""));
}

function isPaperReportQueueCommand(command) {
  return String(command || "") === PAPER_REPORT_QUEUE_COMMAND;
}

function compactSchedulerStatus(status = schedulerStatus()) {
  return {
    ...status,
    current_job: compactRuntimeJob(status.current_job),
    last_job: compactRuntimeJob(status.last_job),
    paper_report_queue: {
      ...status.paper_report_queue,
      active_jobs: (status.paper_report_queue?.active_jobs || []).map(compactRuntimeJob)
    }
  };
}

function publishTaskEvent(type, job, options = {}) {
  const task = {
    id: job?.id || null,
    command: job?.command || null,
    source: job?.source || null,
    args: Array.isArray(job?.args) ? job.args : [],
    status: options.status || job?.status || "running",
    started_at: job?.started_at || null,
    finished_at: job?.finished_at || null,
    message: job?.message || null
  };
  if (options.result !== undefined) {
    task.result = compactTaskResult(options.result);
  }
  const payload = {
    task,
    scheduler: compactSchedulerStatus()
  };
  if (options.stale) payload.stale = true;
  publishEvent(type, payload);
}

function compactDailyProgressEvent(payload, command) {
  if (payload?.event && payload.event !== SERVER_EVENTS.DAILY_RUN_PROGRESS_UPDATED) return null;
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (!data || typeof data !== "object") return null;
  if (!data.job_id && !data.current_key && !data.current_label) return null;
  return {
    job_id: data.job_id || null,
    job_type: data.job_type || command || null,
    status: data.status || null,
    current: data.current || null,
    total: data.total || null,
    completed: data.completed || 0,
    current_key: data.current_key || null,
    current_label: data.current_label || null,
    updated_at: data.updated_at || new Date().toISOString()
  };
}

function createDailyProgressPublisher(command) {
  let latestProgress = null;
  let timer = null;
  let lastPublishedAt = 0;

  function emit() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!latestProgress) return;
    const progress = latestProgress;
    latestProgress = null;
    lastPublishedAt = Date.now();
    publishEvent(SERVER_EVENTS.DAILY_RUN_PROGRESS_UPDATED, {
      progress,
      scheduler: compactSchedulerStatus()
    });
  }

  function queue(payload) {
    const progress = compactDailyProgressEvent(payload, command);
    if (!progress) return;
    latestProgress = progress;
    const elapsed = Date.now() - lastPublishedAt;
    if (elapsed >= DAILY_PROGRESS_SSE_THROTTLE_MS) {
      emit();
      return;
    }
    if (!timer) {
      timer = setTimeout(emit, DAILY_PROGRESS_SSE_THROTTLE_MS - elapsed);
      timer.unref?.();
    }
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    latestProgress = null;
  }

  return { flush: emit, queue, stop };
}

function publishSettingsChanged(_settings, scheduler = schedulerStatus()) {
  publishEvent(SERVER_EVENTS.SETTINGS_CHANGED, {
    scheduler: compactSchedulerStatus(scheduler)
  });
}

function updateVersionKey(data = {}) {
  return String(data.latest_tag || data.latest_version || data.notification?.source?.update?.latest_tag || "").trim();
}

function compactUpdatePayload(data = {}) {
  const update = data.notification?.source?.update || {};
  return {
    ok: Boolean(data.ok),
    available: Boolean(data.available),
    checked_at: data.checked_at || update.checked_at || null,
    current_version: data.current_version || update.current_version || null,
    latest_version: data.latest_version || update.latest_version || null,
    latest_tag: data.latest_tag || update.latest_tag || null,
    repository: data.repository || update.repository || null,
    release_url: data.release_url || update.release_url || null,
    source: data.source || update.source || null
  };
}

function publishUpdateAvailable(data = {}, { force = false } = {}) {
  if (!data?.available || !data?.notification) return null;
  const versionKey = updateVersionKey(data);
  if (!force && versionKey && versionKey === updateCheckRuntime.lastNotifiedVersion) return null;
  if (versionKey) updateCheckRuntime.lastNotifiedVersion = versionKey;
  return publishEvent(SERVER_EVENTS.APP_UPDATE_AVAILABLE, {
    update: compactUpdatePayload(data),
    notification: data.notification
  });
}

function scheduleUpdateCheck(delayMs = UPDATE_CHECK_INTERVAL_MS) {
  if (!updateCheckRuntime.enabled) return;
  if (updateCheckRuntime.timer) clearTimeout(updateCheckRuntime.timer);
  updateCheckRuntime.timer = setTimeout(() => {
    updateCheckRuntime.timer = null;
    runUpdateCheck().catch((error) => {
      updateCheckRuntime.lastError = { message: error.message, at: new Date().toISOString() };
      scheduleUpdateCheck();
    });
  }, Math.max(0, Number(delayMs) || 0));
  updateCheckRuntime.timer.unref?.();
}

async function runUpdateCheck({ forceNotify = false, reschedule = true } = {}) {
  if (!updateCheckRuntime.enabled) {
    return { ok: false, disabled: true, available: false };
  }
  if (updateCheckRuntime.checking) {
    return { ok: false, checking: true, available: false };
  }
  updateCheckRuntime.checking = true;
  updateCheckRuntime.lastCheckAt = new Date().toISOString();
  try {
    const data = await jsonFromWorker(["api-update-check"]);
    updateCheckRuntime.lastError = data.ok === false
      ? { message: data.error || "Update check failed", at: new Date().toISOString() }
      : null;
    publishUpdateAvailable(data, { force: forceNotify });
    return data;
  } finally {
    updateCheckRuntime.checking = false;
    if (reschedule) scheduleUpdateCheck();
  }
}

function compactExperimentReportPayload(data) {
  const artifact = data?.artifact && typeof data.artifact === "object" ? data.artifact : {};
  const contentJson = artifact.content_json && typeof artifact.content_json === "object"
    ? artifact.content_json
    : {};
  const knowledgeDocument = data?.knowledge_document && typeof data.knowledge_document === "object"
    ? data.knowledge_document
    : contentJson.knowledge_document;

  const projectId = contentJson.project_id ?? artifact.scope_id ?? null;
  const sourceAgent = contentJson.source_agent ?? null;
  const artifactId = artifact.id ?? null;
  const updatedAt = artifact.updated_at ?? contentJson.received_at ?? null;
  const detail = [
    artifact.title || "未命名实验报告",
    projectId ? `项目 ${projectId}` : "",
    sourceAgent ? `来源 ${sourceAgent}` : "",
    updatedAt ? `更新于 ${updatedAt}` : ""
  ].filter(Boolean).join(" · ");

  return {
    artifact: {
      id: artifactId,
      artifact_type: artifact.artifact_type ?? null,
      title: artifact.title ?? null,
      scope_type: artifact.scope_type ?? null,
      scope_id: artifact.scope_id ?? null,
      created_at: artifact.created_at ?? null,
      updated_at: updatedAt
    },
    project_id: projectId,
    source_agent: sourceAgent,
    idempotency_key: contentJson.idempotency_key ?? null,
    received_at: contentJson.received_at ?? null,
    knowledge_document: knowledgeDocument ? {
      document_id: knowledgeDocument.document_id ?? null,
      chunks_created: knowledgeDocument.chunks_created ?? null,
      embeddings_created: knowledgeDocument.embeddings_created ?? null,
      relation: knowledgeDocument.relation ?? null,
      source_type: knowledgeDocument.source_type ?? null
    } : null,
    obsidian: data?.obsidian ?? contentJson.obsidian_export ?? null,
    notification: {
      id: artifactId ? `experiment-report-upserted-${artifactId}` : "experiment-report-upserted",
      type: "experiment_report_arrived",
      severity: "info",
      title: "收到实验报告",
      detail,
      created_at: updatedAt,
      source: {
        artifact_id: artifactId,
        project_id: projectId,
        source_agent: sourceAgent
      },
      channels: ["toast"],
      requires_action: false
    }
  };
}

function eventNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function compactProjectPayload(data = {}, fallbackId = null) {
  const project = data?.project && typeof data.project === "object" ? data.project : {};
  const projectId = eventNumber(project.id ?? data.project_id ?? fallbackId);
  return {
    project_id: projectId,
    id: projectId,
    name: project.name || null,
    status: project.status || null,
    updated_at: project.updated_at || data.updated_at || null
  };
}

function compactArtifactPayload(data = {}, fallbackId = null) {
  const artifact = data?.artifact && typeof data.artifact === "object"
    ? data.artifact
    : data?.generated_artifact && typeof data.generated_artifact === "object"
      ? data.generated_artifact
      : {};
  const artifactId = eventNumber(artifact.id ?? data.artifact_id ?? fallbackId);
  return {
    artifact_id: artifactId,
    id: artifactId,
    artifact_type: artifact.artifact_type || null,
    title: artifact.title || null,
    scope_type: artifact.scope_type || null,
    scope_id: eventNumber(artifact.scope_id),
    status: artifact.status || null,
    updated_at: artifact.updated_at || data.updated_at || null
  };
}

function compactPaperPayload(data = {}, fallbackId = null) {
  const paper = data?.paper && typeof data.paper === "object" ? data.paper : {};
  const report = data?.paper_report && typeof data.paper_report === "object" ? data.paper_report : {};
  const paperId = eventNumber(
    data.paper_id ??
    paper.id ??
    report.paper_id ??
    fallbackId
  );
  return {
    paper_id: paperId,
    id: paperId,
    arxiv_id: paper.arxiv_id || data.arxiv_id || null,
    library_status: paper.library_status || data.library_status || null,
    report_status: report.status || data.report_status || null,
    status: data.status || paper.status || null,
    updated_at: paper.updated_at || report.updated_at || data.updated_at || null
  };
}

function projectIdsFromData(data = {}) {
  const ids = new Set();
  const candidates = [
    data.project_id,
    data.projectId,
    data.project?.id,
    ...(Array.isArray(data.project_ids) ? data.project_ids : []),
    ...(Array.isArray(data.source_project_ids) ? data.source_project_ids : []),
    ...(Array.isArray(data.project_recommendations) ? data.project_recommendations.map((item) => item.project_id) : []),
    ...(Array.isArray(data.linked_projects) ? data.linked_projects.map((item) => item.project_id) : [])
  ];
  for (const value of candidates) {
    const id = eventNumber(value);
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

function publishProjectChanged(type, data = {}, fallbackId = null, extra = {}) {
  publishEvent(type, {
    project: compactProjectPayload(data, fallbackId),
    project_id: eventNumber(data?.project?.id ?? data?.project_id ?? fallbackId),
    ...extra
  });
}

function publishArtifactChanged(type, data = {}, fallbackId = null, extra = {}) {
  const artifact = compactArtifactPayload(data, fallbackId);
  publishEvent(type, {
    artifact,
    artifact_id: artifact.artifact_id,
    project_id: artifact.scope_type === "project" ? artifact.scope_id : eventNumber(data?.project_id),
    ...extra
  });
}

function publishPaperChanged(type, data = {}, fallbackId = null, extra = {}) {
  const paper = compactPaperPayload(data, fallbackId);
  publishEvent(type, {
    paper,
    paper_id: paper.paper_id,
    project_ids: projectIdsFromData(data),
    ...extra
  });
}

function publishPaperReportChanged(type, data = {}, fallbackId = null, extra = {}) {
  const paper = compactPaperPayload(data, fallbackId);
  const report = data?.paper_report && typeof data.paper_report === "object" ? data.paper_report : {};
  publishEvent(type, {
    paper,
    paper_id: paper.paper_id,
    artifact_id: eventNumber(report.artifact_id ?? report.id ?? data.artifact_id),
    status: report.status || data.status || null,
    project_ids: projectIdsFromData(data),
    ...extra
  });
}

async function readAppSettings() {
  const data = await jsonFromWorker(["api-settings"]);
  return data.settings || {};
}

async function saveAppSettings(payload) {
  return jsonFromWorker(["api-settings-save"], JSON.stringify(payload));
}

function settingsPayloadWithoutSchedulerMode(payload = {}) {
  const nextPayload = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (!SCHEDULER_MODE_FIELDS.has(key)) nextPayload[key] = value;
  }
  return nextPayload;
}

function truthySetting(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
}

function schedulerModeFromPayload(payload = {}) {
  const rawMode = String(payload.mode || "").trim().toLowerCase();
  if (rawMode) {
    if (SCHEDULER_MODES.has(rawMode)) return rawMode;
    const err = new Error("mode must be one of: off, scheduler, startup");
    err.statusCode = 400;
    throw err;
  }

  const schedulerEnabled = truthySetting(payload.scheduler_enabled);
  const startupEnabled = truthySetting(payload.run_daily_on_startup_enabled);
  if (schedulerEnabled && startupEnabled) {
    const err = new Error("scheduler_enabled and run_daily_on_startup_enabled are mutually exclusive");
    err.statusCode = 400;
    throw err;
  }
  if (schedulerEnabled) return "scheduler";
  if (startupEnabled) return "startup";
  return "off";
}

function schedulerSettingsForMode(mode) {
  return {
    run_daily_on_startup_enabled: mode === "startup",
    scheduler_enabled: mode === "scheduler"
  };
}

async function cleanupStaleJobs() {
  try {
    return await jsonFromWorker(["api-jobs-cleanup"]);
  } catch (error) {
    schedulerRuntime.lastError = { message: error.message, at: new Date().toISOString() };
    return { ok: false, error: error.message };
  }
}

function jobAgeMs(job) {
  const startedAt = new Date(job?.started_at || 0).getTime();
  return Number.isFinite(startedAt) ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
}

async function runningDatabaseJob({ ignoreDailyJobs = false, ignorePaperReportQueueJobs = false } = {}) {
  await cleanupStaleJobs();
  const history = await jsonFromWorker(["api-jobs-history", "--limit", "100"]);
  return (history.items || []).find((job) => {
    if (job.status !== "running") return false;
    if (ignoreDailyJobs && isDailyJobCommand(job.job_type)) return false;
    if (ignorePaperReportQueueJobs && isPaperReportQueueCommand(job.job_type)) return false;
    return true;
  }) || null;
}

async function reconcileCurrentJobWithDatabase() {
  const current = jobRuntime.currentJob;
  if (!current) return null;

  const running = await runningDatabaseJob();
  if (running) return running;

  if (jobAgeMs(current) < IN_MEMORY_JOB_RECONCILE_GRACE_MS) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const message = "Cleared stale in-memory job state after database cleanup found no running job";
  jobRuntime.lastJob = {
    command: current.command,
    source: current.source,
    args: current.args || [],
    status: "failed",
    started_at: current.started_at,
    finished_at: finishedAt,
    message
  };
  jobRuntime.currentJob = null;
  if (current.source === "paper-report-queue") {
    paperReportQueueRuntime.lastError = { message, at: finishedAt };
  } else {
    schedulerRuntime.lastError = { message, at: finishedAt };
  }
  publishTaskEvent(SERVER_EVENTS.TASK_FAILED, jobRuntime.lastJob, { stale: true });
  return null;
}

function clearSchedulerTimer() {
  if (schedulerRuntime.timer) {
    clearTimeout(schedulerRuntime.timer);
    schedulerRuntime.timer = null;
  }
}

function scheduleNext(settings) {
  clearSchedulerTimer();
  if (!schedulerRuntime.enabled) return;

  const next = computeNextRun(settings);
  schedulerRuntime.nextRunAt = next;
  const delay = Math.max(1000, next.getTime() - Date.now());
  schedulerRuntime.timer = setTimeout(() => {
    runScheduledDaily().catch((error) => {
      schedulerRuntime.lastError = {
        message: error.message,
        at: new Date().toISOString()
      };
    });
  }, delay);
}

async function startScheduler({ persist = true, settings = null } = {}) {
  let activeSettings = settings;
  if (persist) {
    const data = await saveAppSettings(schedulerSettingsForMode("scheduler"));
    activeSettings = data.settings;
  }
  if (!activeSettings) activeSettings = await readAppSettings();
  schedulerRuntime.enabled = true;
  startupDailyRuntime.enabled = false;
  schedulerRuntime.lastError = null;
  scheduleNext(activeSettings);
  const status = schedulerStatus();
  if (persist) publishSettingsChanged(activeSettings, status);
  return status;
}

async function stopScheduler({ persist = true } = {}) {
  clearSchedulerTimer();
  schedulerRuntime.enabled = false;
  schedulerRuntime.nextRunAt = null;
  startupDailyRuntime.enabled = false;
  if (persist) startupDailyRuntime.lastSkipReason = "disabled";
  let activeSettings = null;
  if (persist) {
    const data = await saveAppSettings(schedulerSettingsForMode("off"));
    activeSettings = data.settings;
  }
  const status = schedulerStatus();
  if (persist) publishSettingsChanged(activeSettings, status);
  return status;
}

async function applySchedulerMode(mode) {
  const data = await saveAppSettings(schedulerSettingsForMode(mode));
  if (mode === "scheduler") {
    await startScheduler({ persist: false, settings: data.settings });
  } else {
    await stopScheduler({ persist: false });
    startupDailyRuntime.enabled = mode === "startup";
    startupDailyRuntime.lastError = null;
    startupDailyRuntime.lastSkipReason = mode === "startup"
      ? "will_run_on_next_dashboard_visit"
      : "disabled";
  }
  const scheduler = schedulerStatus();
  publishSettingsChanged(data.settings, scheduler);
  return { ok: true, mode, settings: data.settings, scheduler };
}

async function runManagedJob(command, source = "manual", args = []) {
  const isDailyJob = isDailyJobCommand(command);
  if (jobRuntime.currentJob) {
    await reconcileCurrentJobWithDatabase();
  }
  if (jobRuntime.currentJob) {
    const err = new Error(`Another job is already running: ${jobRuntime.currentJob.command}`);
    err.statusCode = 409;
    throw err;
  }
  if (!isDailyJob && source !== "paper-report-queue" && paperReportQueueRuntime.active > 0) {
    const err = new Error(`Paper report queue is running: ${paperReportQueueRuntime.active} active`);
    err.statusCode = 409;
    throw err;
  }
  if (source !== "paper-report-queue") {
    const running = await runningDatabaseJob({ ignorePaperReportQueueJobs: isDailyJob });
    if (running) {
      const err = new Error(`Database job is already running: ${running.job_type} #${running.id}`);
      err.statusCode = 409;
      throw err;
    }
  }
  const startedAt = new Date().toISOString();
  jobRuntime.currentJob = { command, source, args, started_at: startedAt };
  publishTaskEvent(SERVER_EVENTS.TASK_STARTED, { ...jobRuntime.currentJob, status: "running" });
  const progressPublisher = DAILY_JOB_COMMANDS.has(command)
    ? createDailyProgressPublisher(command)
    : null;
  try {
    const data = progressPublisher
      ? await jsonFromManagedWorker([command, ...args], null, {
        onProgressEvent: (payload) => progressPublisher.queue(payload)
      })
      : await jsonFromWorker([command, ...args]);
    progressPublisher?.flush();
    const finishedAt = new Date().toISOString();
    jobRuntime.lastJob = {
      command,
      source,
      args,
      status: "completed",
      started_at: startedAt,
      finished_at: finishedAt,
      message: data.message || `${command} completed`,
      result: data
    };
    jobRuntime.currentJob = null;
    publishTaskEvent(SERVER_EVENTS.TASK_FINISHED, jobRuntime.lastJob, { result: data });
    return data;
  } catch (error) {
    progressPublisher?.flush();
    const finishedAt = new Date().toISOString();
    jobRuntime.lastJob = {
      command,
      source,
      args,
      status: "failed",
      started_at: startedAt,
      finished_at: finishedAt,
      message: error.message
    };
    if (source === "paper-report-queue") {
      paperReportQueueRuntime.lastError = { message: error.message, at: finishedAt };
    } else {
      schedulerRuntime.lastError = { message: error.message, at: finishedAt };
    }
    jobRuntime.currentJob = null;
    publishTaskEvent(SERVER_EVENTS.TASK_FAILED, jobRuntime.lastJob);
    throw error;
  } finally {
    progressPublisher?.stop();
    jobRuntime.currentJob = null;
  }
}

function schedulePaperReportQueue(delay = PAPER_REPORT_QUEUE_INTERVAL_MS) {
  if (!paperReportQueueRuntime.enabled) return;
  if (paperReportQueueRuntime.timer) clearTimeout(paperReportQueueRuntime.timer);
  paperReportQueueRuntime.timer = setTimeout(() => {
    runPaperReportQueueOnce().catch((error) => {
      paperReportQueueRuntime.lastError = {
        message: error.message,
        at: new Date().toISOString()
      };
      schedulePaperReportQueue();
    });
  }, delay);
}

async function runPaperReportWorker(workerId) {
  const startedAt = new Date().toISOString();
  const activeJob = {
    id: workerId,
    command: PAPER_REPORT_QUEUE_COMMAND,
    source: "paper-report-queue",
    args: ["--limit", "1"],
    started_at: startedAt
  };
  paperReportQueueRuntime.active += 1;
  paperReportQueueRuntime.activeJobs = [...paperReportQueueRuntime.activeJobs, activeJob];
  publishTaskEvent(SERVER_EVENTS.TASK_STARTED, { ...activeJob, status: "running" });
  let result = null;
  let failure = null;
  let finishedAt = null;
  try {
    result = await jsonFromWorker([PAPER_REPORT_QUEUE_COMMAND, "--limit", "1"]);
    finishedAt = new Date().toISOString();
    paperReportQueueRuntime.lastRunAt = finishedAt;
    paperReportQueueRuntime.lastError = null;
    return result;
  } catch (error) {
    failure = error;
    finishedAt = new Date().toISOString();
    paperReportQueueRuntime.lastError = {
      message: error.message,
      at: finishedAt
    };
    return null;
  } finally {
    paperReportQueueRuntime.active = Math.max(0, paperReportQueueRuntime.active - 1);
    paperReportQueueRuntime.activeJobs = paperReportQueueRuntime.activeJobs.filter((job) => job.id !== workerId);
    const completedJob = {
      ...activeJob,
      status: failure ? "failed" : "completed",
      finished_at: finishedAt || new Date().toISOString(),
      message: failure?.message || result?.message || "generate-paper-reports completed"
    };
    publishTaskEvent(failure ? SERVER_EVENTS.TASK_FAILED : SERVER_EVENTS.TASK_FINISHED, completedJob, failure ? {} : { result });
    schedulePaperReportQueue(1000);
  }
}

async function runPaperReportQueueOnce() {
  paperReportQueueRuntime.lastCheckAt = new Date().toISOString();
  paperReportQueueRuntime.lastSkipReason = null;
  if (jobRuntime.currentJob) {
    await reconcileCurrentJobWithDatabase();
  }
  if (jobRuntime.currentJob && !isDailyJobCommand(jobRuntime.currentJob.command)) {
    paperReportQueueRuntime.lastSkipReason = `busy:${jobRuntime.currentJob.command}`;
    schedulePaperReportQueue();
    return schedulerStatus();
  }

  const settings = await readAppSettings();
  const concurrency = paperReportQueueConcurrency(settings);
  paperReportQueueRuntime.concurrency = concurrency;
  if (paperReportQueueRuntime.active >= concurrency) {
    paperReportQueueRuntime.lastSkipReason = `active:${paperReportQueueRuntime.active}/${concurrency}`;
    schedulePaperReportQueue();
    return schedulerStatus();
  }

  const running = await runningDatabaseJob({
    ignoreDailyJobs: true,
    ignorePaperReportQueueJobs: paperReportQueueRuntime.active > 0
  });
  if (running) {
    paperReportQueueRuntime.lastSkipReason = `busy:${running.job_type}`;
    schedulePaperReportQueue();
    return schedulerStatus();
  }

  const data = await jsonFromWorker(["api-paper-reports-summary"]);
  const queued = Number(data?.stats?.queued || 0);
  if (!queued) {
    paperReportQueueRuntime.lastSkipReason = "empty";
    schedulePaperReportQueue();
    return schedulerStatus();
  }

  const available = Math.max(0, concurrency - paperReportQueueRuntime.active);
  const launchCount = Math.min(queued, available);
  for (let index = 0; index < launchCount; index += 1) {
    runPaperReportWorker(`${Date.now()}-${index}`).catch((error) => {
      paperReportQueueRuntime.lastError = {
        message: error.message,
        at: new Date().toISOString()
      };
    });
  }
  paperReportQueueRuntime.lastSkipReason = `launched:${launchCount}`;
  schedulePaperReportQueue(1000);
  return schedulerStatus();
}

async function runScheduledDaily() {
  schedulerRuntime.nextRunAt = null;
  try {
    await runManagedJob("run-daily", "scheduler");
  } finally {
    if (schedulerRuntime.enabled) {
      const settings = await readAppSettings();
      scheduleNext(settings);
    }
  }
}

function localDateKey(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function runDailyStateToday() {
  await cleanupStaleJobs();
  const today = localDateKey(new Date());
  const history = await jsonFromWorker(["api-jobs-history", "--limit", "500"]);
  for (const job of history.items || []) {
    const finishedAt = job.finished_at || job.started_at;
    if (job.job_type !== "run-daily" || localDateKey(finishedAt) !== today) continue;
    if (job.status === "running") return "running";
    if (job.status === "completed") return "completed";
  }
  return "none";
}

async function dailyRunRecoveryState() {
  const data = await jsonFromWorker(["api-notifications", "--limit", "20"]);
  const item = (data.items || []).find((entry) => entry?.type === "daily_run_recoverable");
  const recovery = item?.source?.recovery;
  if (!recovery?.resumable) return null;
  return {
    ...recovery,
    title: item.title || "每日流程可继续",
    detail: item.detail || "",
    created_at: item.created_at || null,
  };
}

async function runDailyOnDashboardOpenIfNeeded(settings) {
  startupDailyRuntime.enabled = Boolean(settings.run_daily_on_startup_enabled);
  startupDailyRuntime.lastCheckAt = new Date().toISOString();
  startupDailyRuntime.lastSkipReason = null;
  startupDailyRuntime.lastError = null;
  if (!startupDailyRuntime.enabled) {
    startupDailyRuntime.lastSkipReason = "disabled";
    return { triggered: false, reason: "disabled", scheduler: schedulerStatus() };
  }
  if (settings.scheduler_enabled) {
    startupDailyRuntime.enabled = false;
    startupDailyRuntime.lastSkipReason = "scheduler_enabled";
    return { triggered: false, reason: "scheduler_enabled", scheduler: schedulerStatus() };
  }
  if (startupDailyRuntime.triggerInFlight) {
    startupDailyRuntime.lastSkipReason = "trigger_in_flight";
    return { triggered: false, reason: "trigger_in_flight", scheduler: schedulerStatus() };
  }
  if (jobRuntime.currentJob) {
    await reconcileCurrentJobWithDatabase();
  }
  const running = jobRuntime.currentJob
    ? null
    : await runningDatabaseJob({ ignorePaperReportQueueJobs: true });
  if (jobRuntime.currentJob) {
    startupDailyRuntime.lastSkipReason = `busy:${jobRuntime.currentJob.command}`;
    return { triggered: false, reason: startupDailyRuntime.lastSkipReason, scheduler: schedulerStatus() };
  }
  if (running) {
    startupDailyRuntime.lastSkipReason = `busy:${running.job_type}`;
    return { triggered: false, reason: startupDailyRuntime.lastSkipReason, scheduler: schedulerStatus() };
  }
  const todayState = await runDailyStateToday();
  if (todayState === "running") {
    startupDailyRuntime.lastSkipReason = "already_running_today";
    return { triggered: false, reason: "already_running_today", scheduler: schedulerStatus() };
  }
  if (todayState === "completed") {
    startupDailyRuntime.lastSkipReason = "already_completed_today";
    return { triggered: false, reason: "already_completed_today", scheduler: schedulerStatus() };
  }
  const recovery = await dailyRunRecoveryState();
  if (recovery) {
    startupDailyRuntime.lastSkipReason = "recoverable_daily_run";
    return {
      triggered: false,
      reason: "recoverable_daily_run",
      recovery,
      scheduler: schedulerStatus()
    };
  }
  startupDailyRuntime.triggerInFlight = true;
  startupDailyRuntime.lastSkipReason = "launched";
  runManagedJob("run-daily", "dashboard-open")
    .then(() => {
      startupDailyRuntime.lastRunAt = new Date().toISOString();
      startupDailyRuntime.lastSkipReason = "completed";
      startupDailyRuntime.lastError = null;
    })
    .catch((error) => {
      startupDailyRuntime.lastSkipReason = "failed";
      startupDailyRuntime.lastError = { message: error.message, at: new Date().toISOString() };
    })
    .finally(() => {
      startupDailyRuntime.triggerInFlight = false;
    });
  return { triggered: true, reason: "launched", scheduler: schedulerStatus() };
}

async function jsonFromWorker(args, input = null) {
  const output = await worker(args, input);
  try {
    return JSON.parse(output || "{}");
  } catch (error) {
    const err = new Error(`Worker returned invalid JSON: ${output.slice(0, 300)}`);
    err.statusCode = 500;
    throw err;
  }
}

async function jsonFromManagedWorker(args, input = null, options = {}) {
  const output = await managedWorker(args, input, options);
  try {
    return JSON.parse(output || "{}");
  } catch (error) {
    const err = new Error(`Worker returned invalid JSON: ${output.slice(0, 300)}`);
    err.statusCode = 500;
    throw err;
  }
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isPanelAuthRequired() {
  return PANEL_PASSWORD !== "";
}

function isAuthApiRequest(req, pathname) {
  return (
    (req.method === "GET" && pathname === "/api/auth/status") ||
    (req.method === "POST" && pathname === "/api/auth/login") ||
    (req.method === "POST" && pathname === "/api/auth/logout")
  );
}

function parseCookies(req) {
  const cookies = Object.create(null);
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = trimmed.slice(separator + 1);
  }
  return cookies;
}

function sessionSigningKey() {
  return `${PANEL_SESSION_SECRET}\0${PANEL_PASSWORD}`;
}

function signSessionPayload(payload) {
  return createHmac("sha256", sessionSigningKey()).update(payload).digest("base64url");
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function passwordMatches(password) {
  const left = createHmac("sha256", PANEL_SESSION_SECRET).update(String(password)).digest();
  const right = createHmac("sha256", PANEL_SESSION_SECRET).update(PANEL_PASSWORD).digest();
  return timingSafeEqual(left, right);
}

function createSessionCookieValue() {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iat: now,
    exp: now + PANEL_SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url")
  })).toString("base64url");
  return `${payload}.${signSessionPayload(payload)}`;
}

function isValidSessionCookie(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  if (!timingSafeStringEqual(parts[1], signSessionPayload(parts[0]))) return false;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const expiresAt = Number(payload?.exp || 0);
    return payload?.v === 1 && Number.isFinite(expiresAt) && expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function isAuthenticatedRequest(req) {
  if (!isPanelAuthRequired()) return true;
  const cookies = parseCookies(req);
  return isValidSessionCookie(cookies[PANEL_SESSION_COOKIE_NAME]);
}

function isAgentApiRequest(req, pathname) {
  return (
    (req.method === "GET" && pathname === "/api/projects") ||
    (req.method === "POST" && pathname === "/api/experiments/reports")
  );
}

function isAgentAuthenticatedRequest(req) {
  if (!KRIS_AGENT_TOKEN) return false;
  const token = String(req.headers["x-experiment-agent-token"] || "");
  return token !== "" && timingSafeStringEqual(token, KRIS_AGENT_TOKEN);
}

function shouldUseSecureCookie(req) {
  const configured = String(process.env.PANEL_COOKIE_SECURE || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(configured)) return true;
  if (["0", "false", "no", "off"].includes(configured)) return false;
  return Boolean(req.socket?.encrypted);
}

function sessionCookieHeader(req, value, maxAgeSeconds) {
  const expires = maxAgeSeconds > 0
    ? new Date(Date.now() + maxAgeSeconds * 1000).toUTCString()
    : "Thu, 01 Jan 1970 00:00:00 GMT";
  const parts = [
    `${PANEL_SESSION_COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${expires}`
  ];
  if (shouldUseSecureCookie(req)) parts.push("Secure");
  return parts.join("; ");
}

function authStatus(req) {
  const authRequired = isPanelAuthRequired();
  return {
    auth_required: authRequired,
    authenticated: !authRequired || isAuthenticatedRequest(req)
  };
}

async function routeAuthApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(res, 200, authStatus(req));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!isPanelAuthRequired()) {
      sendJson(res, 200, { ok: true, auth_required: false, authenticated: true });
      return true;
    }

    let body = {};
    try {
      body = await readRequestJson(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON", code: "invalid_json" });
      return true;
    }

    const password = typeof body?.password === "string" ? body.password : "";
    if (!passwordMatches(password)) {
      sendJson(res, 401, { error: "Invalid password", code: "invalid_password" });
      return true;
    }

    res.setHeader("Set-Cookie", sessionCookieHeader(req, createSessionCookieValue(), PANEL_SESSION_TTL_SECONDS));
    sendJson(res, 200, { ok: true, auth_required: true, authenticated: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    res.setHeader("Set-Cookie", sessionCookieHeader(req, "", 0));
    sendJson(res, 200, {
      ok: true,
      auth_required: isPanelAuthRequired(),
      authenticated: !isPanelAuthRequired()
    });
    return true;
  }

  return false;
}

function execFileText(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 64 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise(String(stdout || "").trim());
    });
  });
}

function pathDialogCancelled(error) {
  const output = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
  return /user canceled|cancelled|canceled/i.test(output) || error.code === 2 || error.exitCode === 2;
}

function localPathError(message, statusCode = 500, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.structuredCode = code;
    error.code = code;
    error.reason = code;
  }
  return error;
}

function errorResponseBody(error) {
  const body = { error: error.message || "Server error" };
  const code = String(error.structuredCode || error.workerPayload?.code || error.workerPayload?.reason || "");
  if (code) {
    body.code = code;
    body.reason = String(error.reason || error.workerPayload?.reason || code);
  }
  return body;
}

function applescriptString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function selectMacPath(mode, title) {
  const prompt = applescriptString(title);
  const picker = mode === "file" ? "choose file" : "choose folder";
  return execFileText("osascript", ["-e", `POSIX path of (${picker} with prompt ${prompt})`]);
}

async function selectWindowsPath(mode, title) {
  const quotedTitle = String(title).replaceAll("'", "''");
  const script = mode === "file"
    ? [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
        `$dialog.Title = '${quotedTitle}'`,
        "$dialog.Filter = 'Markdown files (*.md)|*.md|All files (*.*)|*.*'",
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName } else { exit 2 }"
      ].join("; ")
    : [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = '${quotedTitle}'`,
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { exit 2 }"
      ].join("; ");
  return execFileText("powershell.exe", ["-NoProfile", "-STA", "-Command", script]);
}

async function selectLinuxPath(mode, title) {
  const zenityArgs = mode === "file"
    ? ["--file-selection", "--title", title]
    : ["--file-selection", "--directory", "--title", title];
  try {
    return await execFileText("zenity", zenityArgs);
  } catch (error) {
    if (pathDialogCancelled(error)) throw error;
  }

  const kdialogArgs = mode === "file"
    ? ["--getopenfilename", ".", "*.md|Markdown files"]
    : ["--getexistingdirectory", "."];
  return execFileText("kdialog", ["--title", title, ...kdialogArgs]);
}

async function selectLocalPath({ mode = "directory", title = "选择路径" } = {}) {
  const normalizedMode = mode === "file" ? "file" : "directory";
  try {
    if (process.platform === "darwin") {
      return await selectMacPath(normalizedMode, title);
    }
    if (process.platform === "win32") {
      return await selectWindowsPath(normalizedMode, title);
    }
    return await selectLinuxPath(normalizedMode, title);
  } catch (error) {
    if (pathDialogCancelled(error)) {
      error.cancelled = true;
      throw error;
    }
    throw localPathError(
      `无法打开本地文件选择器：${String(error.stderr || error.message || error).trim()}`,
      500
    );
  }
}

function isPathInside(child, root) {
  const rel = relative(root, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function withOptionalRelativePath(selectedPath, body) {
  const result = { ok: true, path: selectedPath };
  if (body.relative_to !== "obsidian_vault") return result;

  let vaultPath = String(body.base_path || "").trim();
  if (!vaultPath) {
    const settings = await readAppSettings();
    vaultPath = String(settings.obsidian_vault_path || "").trim();
  }
  if (!vaultPath) {
    throw localPathError(
      "Obsidian 未配置：请先选择或填写 Obsidian vault 路径，再选择 vault 内部路径。",
      409,
      OBSIDIAN_NOT_CONFIGURED_CODE
    );
  }

  const vaultRoot = resolve(vaultPath);
  const resolvedSelected = resolve(selectedPath);
  if (!isPathInside(resolvedSelected, vaultRoot)) {
    throw localPathError("选择的路径必须位于当前 Obsidian vault 内。", 400);
  }

  result.relative_path = relative(vaultRoot, resolvedSelected).replaceAll("\\", "/");
  return result;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = resolvePublicPath(url.pathname);

  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (await tryServeStaticFile(filePath, res)) return;

  if (!extname(url.pathname)) {
    const indexPath = resolvePublicPath("/index.html");
    if (indexPath && await tryServeStaticFile(indexPath, res)) return;
  }

  res.writeHead(404);
  res.end("Not found");
}

function resolvePublicPath(pathname) {
  const decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const relativePath = decodedPath.replace(/^[\\/]+/, "");
  const filePath = resolve(PUBLIC_DIR, relativePath);
  return isPathInside(filePath, PUBLIC_DIR) ? filePath : null;
}

async function tryServeStaticFile(filePath, res) {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream"
    });
    res.end(body);
    return true;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
    return false;
  }
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/events") {
    openEventStream(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const data = await jsonFromWorker(["api-projects"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/experiments/reports") {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-experiment-report"], JSON.stringify(body));
    sendJson(res, 200, data);
    publishEvent(SERVER_EVENTS.EXPERIMENT_REPORT_UPSERTED, compactExperimentReportPayload(data));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-save"], JSON.stringify(body));
    sendJson(res, 200, data);
    publishProjectChanged(body.id ? SERVER_EVENTS.PROJECT_UPDATED : SERVER_EVENTS.PROJECT_CREATED, data, body.id);
    return;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (req.method === "GET" && projectMatch) {
    const data = await jsonFromWorker(["api-project", projectMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && projectMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker([
      "api-project-save"
    ], JSON.stringify({ ...body, id: Number(projectMatch[1]) }));
    sendJson(res, 200, data);
    publishProjectChanged(SERVER_EVENTS.PROJECT_UPDATED, data, projectMatch[1]);
    return;
  }

  const projectExportMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/export-obsidian$/);
  if (req.method === "POST" && projectExportMatch) {
    const data = await jsonFromWorker(["api-project-export", projectExportMatch[1]]);
    sendJson(res, 200, data);
    publishProjectChanged(SERVER_EVENTS.PROJECT_UPDATED, data, projectExportMatch[1], { reason: "export_obsidian" });
    return;
  }

  const projectIndexMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/artifacts\/project-index$/);
  if (req.method === "POST" && projectIndexMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-index", projectIndexMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
    publishProjectChanged(SERVER_EVENTS.PROJECT_UPDATED, data, projectIndexMatch[1], { reason: "project_index" });
    publishArtifactChanged(SERVER_EVENTS.ARTIFACT_CREATED, data, data?.generated_artifact?.id);
    return;
  }

  const projectPaperMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/papers$/);
  if (req.method === "POST" && projectPaperMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-link-paper", projectPaperMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
    publishEvent(SERVER_EVENTS.PROJECT_PAPER_LINKED, {
      project_id: eventNumber(projectPaperMatch[1]),
      paper_id: eventNumber(body.paper_id),
      relation: body.relation || null,
      project: compactProjectPayload(data, projectPaperMatch[1])
    });
    return;
  }

  const projectPaperDeleteMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/papers\/(\d+)$/);
  if (req.method === "DELETE" && projectPaperDeleteMatch) {
    const data = await jsonFromWorker([
      "api-project-unlink-paper",
      projectPaperDeleteMatch[1],
      projectPaperDeleteMatch[2]
    ]);
    sendJson(res, 200, data);
    publishEvent(SERVER_EVENTS.PROJECT_PAPER_UNLINKED, {
      project_id: eventNumber(projectPaperDeleteMatch[1]),
      paper_id: eventNumber(projectPaperDeleteMatch[2]),
      project: compactProjectPayload(data, projectPaperDeleteMatch[1])
    });
    return;
  }

  const projectNoteMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/notes$/);
  if (req.method === "POST" && projectNoteMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-link-note", projectNoteMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
    publishEvent(SERVER_EVENTS.PROJECT_NOTE_LINKED, {
      project_id: eventNumber(projectNoteMatch[1]),
      note_id: eventNumber(body.note_id),
      relation: body.relation || null,
      project: compactProjectPayload(data, projectNoteMatch[1])
    });
    return;
  }

  const projectNoteDeleteMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/notes\/(\d+)$/);
  if (req.method === "DELETE" && projectNoteDeleteMatch) {
    const data = await jsonFromWorker([
      "api-project-unlink-note",
      projectNoteDeleteMatch[1],
      projectNoteDeleteMatch[2]
    ]);
    sendJson(res, 200, data);
    publishEvent(SERVER_EVENTS.PROJECT_NOTE_UNLINKED, {
      project_id: eventNumber(projectNoteDeleteMatch[1]),
      note_id: eventNumber(projectNoteDeleteMatch[2]),
      project: compactProjectPayload(data, projectNoteDeleteMatch[1])
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    const data = await jsonFromWorker(["api-settings"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readRequestJson(req);
    const data = await saveAppSettings(settingsPayloadWithoutSchedulerMode(body));
    paperReportQueueRuntime.concurrency = paperReportQueueConcurrency(data.settings || {});
    schedulePaperReportQueue(1000);
    if (schedulerRuntime.enabled) {
      scheduleNext(data.settings || {});
    }
    const responseBody = { ...data, scheduler: schedulerStatus() };
    sendJson(res, 200, responseBody);
    publishSettingsChanged(data.settings, responseBody.scheduler);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/local-path/select") {
    const body = await readRequestJson(req);
    try {
      const selectedPath = await selectLocalPath({
        mode: body.mode,
        title: body.title || "选择路径"
      });
      sendJson(res, 200, await withOptionalRelativePath(selectedPath, body));
    } catch (error) {
      if (error.cancelled) {
        sendJson(res, 200, { ok: false, cancelled: true });
        return;
      }
      throw error;
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const data = await jsonFromWorker(["api-health"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health/summary") {
    const data = await jsonFromWorker(["api-health-summary"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/status") {
    sendJson(res, 200, { scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/summary") {
    const data = await jsonFromWorker(["api-jobs-summary"]);
    sendJson(res, 200, { ...data, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/history") {
    const limit = url.searchParams.get("limit") || "20";
    const data = await jsonFromWorker(["api-jobs-history", "--limit", limit]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const limit = url.searchParams.get("limit") || "5";
    const data = await jsonFromWorker(["api-notifications", "--limit", limit]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/update-status") {
    const data = await jsonFromWorker(["api-update-status"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/update-check") {
    const data = await runUpdateCheck({ forceNotify: true, reschedule: false });
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/scheduler/start") {
    const scheduler = await startScheduler({ persist: true });
    sendJson(res, 200, { ok: true, scheduler });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/scheduler/stop") {
    const scheduler = await stopScheduler({ persist: true });
    sendJson(res, 200, { ok: true, scheduler });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/scheduler/mode") {
    const body = await readRequestJson(req);
    const data = await applySchedulerMode(schedulerModeFromPayload(body));
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/startup-daily/check") {
    const settings = await readAppSettings();
    const result = await runDailyOnDashboardOpenIfNeeded(settings);
    sendJson(res, 200, { ok: true, startup_daily_trigger: result, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/run-now") {
    const body = await readRequestJson(req);
    if (!body.force) {
      const recovery = await dailyRunRecoveryState();
      if (recovery) {
        sendJson(res, 409, {
          error: "今天已有失败但可恢复的每日流程。继续上次流程，或确认后重新执行今日流程。",
          code: "daily_run_recoverable",
          recovery,
        });
        return;
      }
    }
    const data = await runManagedJob("run-daily", "manual");
    sendJson(res, 200, { ok: true, ...data, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/resume-daily") {
    const data = await runManagedJob("resume-daily", "manual");
    sendJson(res, 200, { ok: true, ...data, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/retry-daily") {
    const data = await runManagedJob("retry-daily", "manual");
    sendJson(res, 200, { ok: true, ...data, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inbox") {
    const data = await jsonFromWorker(["api-inbox"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/paper-reports/summary") {
    const data = await jsonFromWorker(["api-paper-reports-summary"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/paper-reports") {
    const limit = url.searchParams.get("limit") || "300";
    const data = await jsonFromWorker(["api-paper-reports", "--limit", limit]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/library") {
    const args = [
      "api-paper-library",
      "--status",
      url.searchParams.get("status") || "",
      "--source-type",
      url.searchParams.get("source_type") || "",
      "--project-id",
      url.searchParams.get("project_id") || "",
      "--query",
      url.searchParams.get("q") || "",
      "--date-from",
      url.searchParams.get("date_from") || "",
      "--date-to",
      url.searchParams.get("date_to") || "",
      "--limit",
      url.searchParams.get("limit") || "100",
      "--offset",
      url.searchParams.get("offset") || "0"
    ];
    const data = await jsonFromWorker(args);
    sendJson(res, 200, data);
    return;
  }

  const libraryPaperMatch = url.pathname.match(/^\/api\/library\/(\d+)$/);
  if (req.method === "GET" && libraryPaperMatch) {
    const data = await jsonFromWorker(["api-paper-library-detail", libraryPaperMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  const libraryStatusMatch = url.pathname.match(/^\/api\/library\/(\d+)\/status$/);
  if (req.method === "POST" && libraryStatusMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-paper-library-status", libraryStatusMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
    publishPaperChanged(SERVER_EVENTS.PAPER_LIBRARY_STATUS_UPDATED, data, libraryStatusMatch[1], {
      library_status: data?.paper?.library_status || body.status || body.library_status || null
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts") {
    const args = [
      "api-artifacts",
      "--scope-type",
      url.searchParams.get("scope_type") || "",
      "--scope-id",
      url.searchParams.get("scope_id") || "",
      "--artifact-type",
      url.searchParams.get("artifact_type") || "",
      "--status",
      url.searchParams.get("status") || "",
      "--limit",
      url.searchParams.get("limit") || "100"
    ];
    const data = await jsonFromWorker(args);
    sendJson(res, 200, data);
    return;
  }

  const artifactMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)$/);
  if (req.method === "GET" && artifactMatch) {
    const data = await jsonFromWorker(["api-artifact", artifactMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  const artifactExportMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)\/export-obsidian$/);
  if (req.method === "POST" && artifactExportMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-artifact-export", artifactExportMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
    publishArtifactChanged(SERVER_EVENTS.ARTIFACT_UPDATED, data, artifactExportMatch[1], { reason: "export_obsidian" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/reader/papers") {
    const limit = url.searchParams.get("limit") || "300";
    const data = await jsonFromWorker(["api-reader-papers", "--limit", limit]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reader/papers/upload") {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-reader-upload"], JSON.stringify(body));
    sendJson(res, 200, data);
    publishEvent(SERVER_EVENTS.READER_PAPERS_IMPORTED, {
      source: "upload",
      imported: Array.isArray(data.imported) ? data.imported.map((item) => ({
        paper_id: eventNumber(item.paper_id || item.id),
        title: item.title || null
      })).filter((item) => item.paper_id) : [],
      imported_count: Array.isArray(data.imported) ? data.imported.length : 0,
      error_count: Array.isArray(data.errors) ? data.errors.length : 0
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reader/papers/urls") {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-reader-urls"], JSON.stringify(body));
    sendJson(res, 200, data);
    publishEvent(SERVER_EVENTS.READER_PAPERS_IMPORTED, {
      source: "url",
      imported: Array.isArray(data.imported) ? data.imported.map((item) => ({
        paper_id: eventNumber(item.paper_id || item.id),
        title: item.title || null
      })).filter((item) => item.paper_id) : [],
      imported_count: Array.isArray(data.imported) ? data.imported.length : 0,
      error_count: Array.isArray(data.errors) ? data.errors.length : 0
    });
    return;
  }

  const readerPaperMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)$/);
  if (req.method === "GET" && readerPaperMatch) {
    const data = await jsonFromWorker(["api-reader-paper", readerPaperMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  const readerPdfMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/pdf$/);
  if (req.method === "GET" && readerPdfMatch) {
    const data = await jsonFromWorker(["api-reader-paper", readerPdfMatch[1]]);
    const rawPath = String(data?.paper?.pdf_path || "");
    if (!rawPath) {
      sendJson(res, 404, { error: "PDF not available" });
      return;
    }
    const pdfPath = isAbsolute(rawPath) ? rawPath : resolve(__dirname, rawPath);
    if (!existsSync(pdfPath)) {
      sendJson(res, 404, { error: "PDF file is missing" });
      return;
    }
    res.writeHead(200, {
      "content-type": "application/pdf",
      "cache-control": "no-store"
    });
    createReadStream(pdfPath).pipe(res);
    return;
  }

  const readerChatMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/chat$/);
  if (req.method === "POST" && readerChatMatch) {
    const body = await readRequestJson(req);
    if (body.stream === true) {
      res.socket?.setNoDelay?.(true);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders?.();
      await streamWorkerEvents([
        "api-reader-chat-stream",
        readerChatMatch[1]
      ], JSON.stringify(body), res);
      publishPaperChanged(SERVER_EVENTS.READER_MESSAGE_UPDATED, {}, readerChatMatch[1], { action: "chat_stream" });
      return;
    }
    const data = await jsonFromWorker([
      "api-reader-chat",
      readerChatMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    publishPaperChanged(SERVER_EVENTS.READER_MESSAGE_UPDATED, data, readerChatMatch[1], { action: "chat" });
    return;
  }

  const readerSaveMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/save$/);
  if (req.method === "POST" && readerSaveMatch) {
    const data = await jsonFromWorker(["api-reader-save", readerSaveMatch[1]]);
    sendJson(res, 200, data);
    publishPaperChanged(SERVER_EVENTS.READER_PAPER_UPDATED, data, readerSaveMatch[1], { action: "save_obsidian" });
    return;
  }

  const readerFollowupsMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/follow-up-questions$/);
  if (req.method === "POST" && readerFollowupsMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker([
      "api-reader-followups",
      readerFollowupsMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    return;
  }

  const readerMessageMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/messages\/(\d+)$/);
  if (req.method === "DELETE" && readerMessageMatch) {
    const data = await jsonFromWorker([
      "api-reader-delete-message",
      readerMessageMatch[1],
      readerMessageMatch[2]
    ]);
    sendJson(res, 200, data);
    publishPaperChanged(SERVER_EVENTS.READER_MESSAGE_DELETED, data, readerMessageMatch[1], {
      message_id: eventNumber(readerMessageMatch[2])
    });
    return;
  }

  const readerCancelMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/cancel$/);
  if (req.method === "POST" && readerCancelMatch) {
    const data = await jsonFromWorker(["api-reader-cancel", readerCancelMatch[1]]);
    sendJson(res, 200, data);
    publishPaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, readerCancelMatch[1], { action: "cancel" });
    return;
  }

  const readerRetryMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/retry$/);
  if (req.method === "POST" && readerRetryMatch) {
    const data = await jsonFromWorker(["api-reader-retry", readerRetryMatch[1]]);
    sendJson(res, 200, data);
    publishPaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, readerRetryMatch[1], { action: "retry" });
    return;
  }

  const readerReportMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/report$/);
  if (req.method === "DELETE" && readerReportMatch) {
    const data = await jsonFromWorker(["api-delete-paper-report", readerReportMatch[1]]);
    sendJson(res, 200, data);
    publishPaperReportChanged(SERVER_EVENTS.PAPER_REPORT_DELETED, data, readerReportMatch[1]);
    return;
  }

  const paperMatch = url.pathname.match(/^\/api\/papers\/(\d+)$/);
  if (req.method === "GET" && paperMatch) {
    const data = await jsonFromWorker(["api-paper", paperMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  const feedbackMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/feedback$/);
  if (req.method === "POST" && feedbackMatch) {
    const body = await readRequestJson(req);
    const status = String(body.status || "").trim();
    const note = String(body.note || "");
    const data = await jsonFromWorker([
      "api-feedback",
      feedbackMatch[1],
      "--status",
      status,
      "--note",
      note
    ]);
    sendJson(res, 200, data);
    publishPaperChanged(SERVER_EVENTS.PAPER_FEEDBACK_UPDATED, data, feedbackMatch[1], { status });
    return;
  }

  const paperRecommendationMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/recommendation$/);
  if (req.method === "POST" && paperRecommendationMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker([
      "api-paper-recommendation",
      paperRecommendationMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    publishPaperChanged(SERVER_EVENTS.PAPER_RECOMMENDATION_UPDATED, data, paperRecommendationMatch[1], {
      action: body.action || null,
      project_ids: Array.isArray(body.project_ids) ? body.project_ids.map(eventNumber).filter(Boolean) : projectIdsFromData(data)
    });
    publishPaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, paperRecommendationMatch[1], {
      action: "recommendation_state"
    });
    return;
  }

  const paperReportMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/report$/);
  if (req.method === "DELETE" && paperReportMatch) {
    const data = await jsonFromWorker([
      "api-delete-paper-report",
      paperReportMatch[1]
    ]);
    sendJson(res, 200, data);
    publishPaperReportChanged(SERVER_EVENTS.PAPER_REPORT_DELETED, data, paperReportMatch[1]);
    return;
  }

  if (req.method === "POST" && paperReportMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker([
      "api-paper-report",
      paperReportMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    publishPaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, paperReportMatch[1], {
      force: Boolean(body.force)
    });
    return;
  }

  const jobMap = {
    "/api/jobs/sync-obsidian": "sync-obsidian",
    "/api/jobs/fetch-arxiv": "fetch-arxiv",
    "/api/jobs/cache-arxiv-text": "cache-arxiv-text",
    "/api/jobs/generate-paper-reports": "generate-paper-reports",
    "/api/jobs/generate-reports": "generate-reports",
    "/api/jobs/run-daily": "run-daily",
    "/api/jobs/retry-daily": "retry-daily"
  };
  if (req.method === "POST" && jobMap[url.pathname]) {
    const data = await runManagedJob(jobMap[url.pathname], "manual");
    sendJson(res, 200, { ok: true, ...data, scheduler: schedulerStatus() });
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (await routeAuthApi(req, res, url)) {
        return;
      }
      const agentAuthenticated = isAgentApiRequest(req, url.pathname) && isAgentAuthenticatedRequest(req);
      if (!isAuthApiRequest(req, url.pathname) && !isAuthenticatedRequest(req) && !agentAuthenticated) {
        sendJson(res, 401, { error: "Authentication required", code: "auth_required" });
        return;
      }
      await routeApi(req, res, url);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    console.error(error.stack || error.message || error);
    const statusCode = error.statusCode || (
      error.structuredCode === OBSIDIAN_NOT_CONFIGURED_CODE ? 409 : 500
    );
    sendJson(res, statusCode, errorResponseBody(error));
  }
});

server.listen(PORT, () => {
  console.log(`Research Intelligence dashboard listening on http://localhost:${PORT}`);
  schedulePaperReportQueue(1000);
  scheduleUpdateCheck(UPDATE_CHECK_INITIAL_DELAY_MS);
  readAppSettings()
    .then(async (settings) => {
      if (settings.scheduler_enabled) {
        return startScheduler({ persist: false, settings });
      }
      startupDailyRuntime.enabled = Boolean(settings.run_daily_on_startup_enabled);
      if (startupDailyRuntime.enabled) {
        startupDailyRuntime.lastSkipReason = "waiting_for_dashboard_visit";
      }
      return schedulerStatus();
    })
    .catch((error) => {
      schedulerRuntime.lastError = { message: error.message, at: new Date().toISOString() };
    });
});
