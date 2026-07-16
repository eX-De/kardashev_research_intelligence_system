import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { envBoolean, envValue, loadDotEnv, positiveInteger } from "./server/env.js";
import {
  SERVER_EVENTS,
  compactArtifactChangedPayload,
  compactExperimentReportPayload,
  compactPaperChangedPayload,
  compactPaperReportChangedPayload,
  compactProjectChangedPayload,
  compactProjectPayload,
  compactSettingsChangedPayload,
  compactTaskEventPayload,
  compactUpdatePayload,
  createEventPublisher,
  eventNumber,
  projectIdsFromData
} from "./server/events.js";
import {
  getAppSettings as getNodeAppSettings,
  saveAppSettings as saveNodeAppSettings
} from "./server/settings.js";
import {
  getJobHistory as getNodeJobHistory,
  getJobSummary as getNodeJobSummary
} from "./server/jobs.js";
import {
  getHealth as getNodeHealth,
  getHealthSummary as getNodeHealthSummary
} from "./server/health.js";
import { getNotifications as getNodeNotifications } from "./server/notifications.js";
import { insertAppEvent, listUnpublishedAppEvents, markAppEventsPublished } from "./server/outbox.js";
import {
  getArtifactDetail as getNodeArtifactDetail,
  getArtifacts as getNodeArtifacts
} from "./server/artifacts.js";
import {
  getPaperLibrary as getNodePaperLibrary,
  getPaperLibraryDetail as getNodePaperLibraryDetail,
  updatePaperLibraryStatus as updateNodePaperLibraryStatus
} from "./server/library.js";
import {
  cancelReaderReport as cancelNodeReaderReport,
  deleteReaderMessage as deleteNodeReaderMessage,
  deleteReaderReport as deleteNodeReaderReport,
  getPaperReportsSummary as getNodePaperReportsSummary,
  getReaderPaperDetail as getNodeReaderPaperDetail,
  getReaderPaperPdfPath as getNodeReaderPaperPdfPath,
  getReaderPapers as getNodeReaderPapers,
  retryReaderReport as retryNodeReaderReport,
  saveReaderReferencePapers as saveNodeReaderReferencePapers,
  updateReaderPaperTitle as updateNodeReaderPaperTitle
} from "./server/reader.js";
import {
  getInbox as getNodeInbox,
  getLegacyPaperDetail as getNodeLegacyPaperDetail,
  savePaperFeedback as saveNodePaperFeedback,
  updatePaperRecommendation as updateNodePaperRecommendation
} from "./server/papers.js";
import {
  getProjectDetail as getNodeProjectDetail,
  getProjects as getNodeProjects,
  linkProjectNote as linkNodeProjectNote,
  linkProjectPaper as linkNodeProjectPaper,
  saveProject as saveNodeProject,
  unlinkProjectNote as unlinkNodeProjectNote,
  unlinkProjectPaper as unlinkNodeProjectPaper
} from "./server/projects.js";
import { cleanupStaleWorkerJobs, countActiveWorkerJobs, enqueueWorkerJob } from "./server/workerQueue.js";
import {
  DEFAULT_READER_UPLOAD_MAX_FILE_BYTES,
  DEFAULT_READER_UPLOAD_MAX_FILES,
  discardStagedReaderUploads,
  stageReaderPdfUploads
} from "./server/uploadStaging.js";

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
const REQUEST_TIMING_LOG_ENABLED = envBoolean("KRIS_REQUEST_TIMING_LOG", false);
const WORKER_TIMING_LOG_ENABLED = envBoolean("KRIS_WORKER_TIMING_LOG", false);
const JOB_BACKEND = String(envValue("KRIS_JOB_BACKEND", "queue") || "queue").trim().toLowerCase();
const OUTBOX_POLLER_ENABLED = envBoolean("KRIS_OUTBOX_POLLER_ENABLED", true);
const OUTBOX_POLL_INTERVAL_MS = Math.max(
  250,
  Number(process.env.KRIS_OUTBOX_POLL_INTERVAL_MS || 1000)
);
const STALE_JOB_CLEANUP_ENABLED = envBoolean("KRIS_STALE_JOB_CLEANUP_ENABLED", true);
const STALE_JOB_CLEANUP_INTERVAL_MS = Math.max(
  10 * 1000,
  Number(process.env.KRIS_STALE_JOB_CLEANUP_INTERVAL_MS || 60 * 1000)
);
const WORKER_JOB_STALE_AFTER_SECONDS = Math.max(
  60,
  Number(process.env.KRIS_WORKER_JOB_STALE_AFTER_SECONDS || 30 * 60)
);
const READER_FOLLOWUPS_SYNC_FALLBACK_ENABLED = envBoolean("KRIS_READER_FOLLOWUPS_SYNC_FALLBACK_ENABLED", true);
const READER_UPLOAD_MAX_FILE_BYTES = positiveInteger(
  process.env.READER_UPLOAD_MAX_FILE_BYTES,
  DEFAULT_READER_UPLOAD_MAX_FILE_BYTES
);
const READER_UPLOAD_MAX_FILES = positiveInteger(process.env.READER_UPLOAD_MAX_FILES, DEFAULT_READER_UPLOAD_MAX_FILES);
const WORKER_PROGRESS_EVENT_PREFIX = "KRIS_PROGRESS_EVENT ";
const DAILY_JOB_COMMANDS = new Set(["run-daily", "resume-daily", "retry-daily"]);
const PAPER_REPORT_QUEUE_COMMAND = "generate-paper-reports";
const requestTimingStorage = new AsyncLocalStorage();

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

const staleJobCleanupRuntime = {
  timer: null,
  inFlight: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastResult: null,
  lastError: null
};

const outboxRuntime = {
  timer: null,
  polling: false,
  lastPollAt: null,
  lastPublishedAt: null,
  lastError: null
};

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

function createRequestTimingContext(req, url) {
  return {
    enabled: REQUEST_TIMING_LOG_ENABLED && url.pathname.startsWith("/api/") && url.pathname !== "/api/events",
    method: req.method,
    path: `${url.pathname}${url.search || ""}`,
    start: performance.now(),
    workerCommands: [],
    responseSizeBytes: 0
  };
}

function currentRequestTimingContext() {
  return requestTimingStorage.getStore() || null;
}

function recordWorkerCommand(args) {
  const context = currentRequestTimingContext();
  if (!context?.enabled || !Array.isArray(args) || !args.length) return;
  const command = args.map((part) => String(part)).join(" ");
  if (command && !context.workerCommands.includes(command)) {
    context.workerCommands.push(command);
  }
}

function recordResponseSizeBytes(size) {
  const context = currentRequestTimingContext();
  if (!context?.enabled) return;
  context.responseSizeBytes = Number(size) || 0;
}

function logRequestTiming(context, res) {
  if (!context?.enabled) return;
  const payload = {
    method: context.method,
    path: context.path,
    status: res.statusCode || 0,
    duration_ms: Math.round((performance.now() - context.start) * 1000) / 1000,
    response_size_bytes: context.responseSizeBytes
  };
  if (context.workerCommands.length === 1) {
    payload.worker_command = context.workerCommands[0];
  } else if (context.workerCommands.length > 1) {
    payload.worker_command = context.workerCommands[0];
    payload.worker_commands = context.workerCommands;
  }
  console.log(`KRIS_REQUEST_TIMING ${JSON.stringify(payload)}`);
}

function forwardWorkerTimingStderr(stderr) {
  if (!WORKER_TIMING_LOG_ENABLED) return;
  const text = String(stderr || "").trimEnd();
  if (text) console.error(text);
}

function worker(args, input = null) {
  recordWorkerCommand(args);
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
        forwardWorkerTimingStderr(stderr);
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
  recordWorkerCommand(args);
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
        forwardWorkerTimingStderr(stderr);
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
  recordWorkerCommand(args);
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
      } else {
        forwardWorkerTimingStderr(stderr);
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

const {
  createDailyProgressPublisher,
  openEventStream,
  publishEvent,
  publishTaskEvent
} = createEventPublisher({
  heartbeatMs: SSE_HEARTBEAT_MS,
  dailyProgressThrottleMs: DAILY_PROGRESS_SSE_THROTTLE_MS,
  getSchedulerStatus: schedulerStatus
});

async function publishDurableEvent(type, payload = {}) {
  const eventPayload = payload && typeof payload === "object" ? payload : {};
  if (!OUTBOX_POLLER_ENABLED) {
    return publishEvent(type, eventPayload);
  }
  try {
    await insertAppEvent(type, eventPayload);
    await pollOutboxOnce();
    return null;
  } catch (error) {
    outboxRuntime.lastError = { message: error.message, at: new Date().toISOString() };
    console.error(error.stack || error.message || error);
    return publishEvent(type, eventPayload);
  }
}

async function publishDurableSettingsChanged(_settings, scheduler = schedulerStatus()) {
  return publishDurableEvent(SERVER_EVENTS.SETTINGS_CHANGED, compactSettingsChangedPayload(scheduler));
}

async function publishDurableProjectChanged(type, data = {}, fallbackId = null, extra = {}) {
  return publishDurableEvent(type, compactProjectChangedPayload(data, fallbackId, extra));
}

async function publishDurableArtifactChanged(type, data = {}, fallbackId = null, extra = {}) {
  return publishDurableEvent(type, compactArtifactChangedPayload(data, fallbackId, extra));
}

async function publishDurablePaperChanged(type, data = {}, fallbackId = null, extra = {}) {
  return publishDurableEvent(type, compactPaperChangedPayload(data, fallbackId, extra));
}

async function publishDurablePaperReportChanged(type, data = {}, fallbackId = null, extra = {}) {
  return publishDurableEvent(type, compactPaperReportChangedPayload(data, fallbackId, extra));
}

async function publishDurableTaskEvent(type, job, options = {}) {
  return publishDurableEvent(type, compactTaskEventPayload(job, options, schedulerStatus()));
}

function isDailyJobCommand(command) {
  return DAILY_JOB_COMMANDS.has(String(command || ""));
}

function isPaperReportQueueCommand(command) {
  return String(command || "") === PAPER_REPORT_QUEUE_COMMAND;
}

function isQueueJobBackend() {
  return JOB_BACKEND !== "cli";
}

function jobPriority(command) {
  if (isDailyJobCommand(command)) return 20;
  if (isPaperReportQueueCommand(command)) return 5;
  return 10;
}

function queuedTaskResponse(command, source, args, queued) {
  const workerJob = queued.worker_job || {};
  const jobRun = queued.job_run || {};
  return {
    ok: true,
    queued: true,
    message: `${command} queued`,
    command,
    source,
    args,
    job_id: jobRun.id || workerJob.job_run_id || null,
    worker_job_id: workerJob.id || null,
    job_run: jobRun,
    worker_job: workerJob
  };
}

function projectContextText(payload = {}) {
  return String(payload.raw_context || payload.context || payload.project_context || "").trim();
}

async function enqueueProjectWorkerJob(command, projectId, payload = {}, { source = "project" } = {}) {
  const normalizedProjectId = eventNumber(projectId);
  if (!normalizedProjectId) {
    const err = new Error("project_id is required");
    err.statusCode = 400;
    throw err;
  }
  const queued = await enqueueWorkerJob({
    jobType: command,
    payload: {
      command,
      source,
      args: [],
      project_id: normalizedProjectId,
      ...payload
    },
    priority: jobPriority(command),
    message: `${command} queued`
  });
  const response = {
    ...queuedTaskResponse(command, source, [], queued),
    project_id: normalizedProjectId
  };
  jobRuntime.lastJob = {
    id: response.job_id,
    command,
    source,
    args: [],
    status: "queued",
    started_at: queued.job_run?.started_at || new Date().toISOString(),
    finished_at: null,
    message: response.message,
    worker_job_id: response.worker_job_id,
    project_id: normalizedProjectId
  };
  await publishDurableTaskEvent(SERVER_EVENTS.TASK_STARTED, jobRuntime.lastJob, { status: "queued" });
  return response;
}

async function enqueueActionWorkerJob(command, payload = {}, { source = "action", args = [], priority = null, maxAttempts = 1 } = {}) {
  const queued = await enqueueWorkerJob({
    jobType: command,
    payload: {
      command,
      source,
      args,
      ...payload
    },
    priority: priority ?? jobPriority(command),
    maxAttempts,
    message: `${command} queued`
  });
  const response = queuedTaskResponse(command, source, args, queued);
  jobRuntime.lastJob = {
    id: response.job_id,
    command,
    source,
    args,
    status: "queued",
    started_at: queued.job_run?.started_at || new Date().toISOString(),
    finished_at: null,
    message: response.message,
    worker_job_id: response.worker_job_id,
    ...payload
  };
  await publishDurableTaskEvent(SERVER_EVENTS.TASK_STARTED, jobRuntime.lastJob, { status: "queued" });
  return response;
}

async function activeDatabaseJob({ ignoreDailyJobs = false, ignorePaperReportQueueJobs = false, includeQueued = false } = {}) {
  await cleanupStaleJobs({ source: "job-check" });
  const statuses = includeQueued ? new Set(["queued", "running"]) : new Set(["running"]);
  const history = await getJobsHistoryResponse(100);
  return (history.items || []).find((job) => {
    if (!statuses.has(job.status)) return false;
    if (ignoreDailyJobs && isDailyJobCommand(job.job_type)) return false;
    if (ignorePaperReportQueueJobs && isPaperReportQueueCommand(job.job_type)) return false;
    return true;
  }) || null;
}

function updateVersionKey(data = {}) {
  return String(data.latest_tag || data.latest_version || data.notification?.source?.update?.latest_tag || "").trim();
}

async function publishUpdateAvailable(data = {}, { force = false } = {}) {
  if (!data?.available || !data?.notification) return null;
  const versionKey = updateVersionKey(data);
  if (!force && versionKey && versionKey === updateCheckRuntime.lastNotifiedVersion) return null;
  if (versionKey) updateCheckRuntime.lastNotifiedVersion = versionKey;
  return publishDurableEvent(SERVER_EVENTS.APP_UPDATE_AVAILABLE, {
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
    await publishUpdateAvailable(data, { force: forceNotify });
    return data;
  } finally {
    updateCheckRuntime.checking = false;
    if (reschedule) scheduleUpdateCheck();
  }
}

async function getAppSettingsResponse() {
  return getNodeAppSettings();
}

async function readAppSettings() {
  const data = await getAppSettingsResponse();
  return data.settings || {};
}

async function saveAppSettings(payload) {
  return saveNodeAppSettings(payload);
}

async function getJobsSummaryResponse() {
  return getNodeJobSummary();
}

async function getJobsHistoryResponse(limit = 20) {
  return getNodeJobHistory(limit);
}

async function getHealthSummaryResponse() {
  return getNodeHealthSummary();
}

async function getHealthResponse() {
  return getNodeHealth();
}

async function getNotificationsResponse(limit = 5) {
  return getNodeNotifications(limit);
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

async function cleanupStaleJobs({ force = false, source = "manual" } = {}) {
  if (!STALE_JOB_CLEANUP_ENABLED) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (staleJobCleanupRuntime.inFlight) {
    return staleJobCleanupRuntime.inFlight;
  }
  const now = Date.now();
  if (!force && staleJobCleanupRuntime.lastFinishedAt && !staleJobCleanupRuntime.lastError) {
    const ageMs = now - new Date(staleJobCleanupRuntime.lastFinishedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STALE_JOB_CLEANUP_INTERVAL_MS) {
      return {
        ok: true,
        skipped: true,
        reason: "recent",
        last_finished_at: staleJobCleanupRuntime.lastFinishedAt
      };
    }
  }

  staleJobCleanupRuntime.lastStartedAt = new Date().toISOString();
  staleJobCleanupRuntime.inFlight = (async () => {
    try {
      const workerJobResult = await cleanupStaleWorkerJobs({
        staleAfterSeconds: WORKER_JOB_STALE_AFTER_SECONDS
      });
      const legacyResult = await jsonFromWorker(["api-jobs-cleanup"]);
      const result = { ...legacyResult, ...workerJobResult };
      staleJobCleanupRuntime.lastResult = { ...result, source };
      staleJobCleanupRuntime.lastError = null;
      if (
        workerJobResult.stale_worker_jobs_requeued
        || workerJobResult.stale_worker_jobs_failed
      ) {
        await pollOutboxOnce();
      }
      return result;
    } catch (error) {
      staleJobCleanupRuntime.lastError = { message: error.message, at: new Date().toISOString(), source };
      schedulerRuntime.lastError = { message: error.message, at: new Date().toISOString() };
      return { ok: false, error: error.message };
    } finally {
      staleJobCleanupRuntime.lastFinishedAt = new Date().toISOString();
      staleJobCleanupRuntime.inFlight = null;
    }
  })();
  return staleJobCleanupRuntime.inFlight;
}

function scheduleStaleJobCleanup(delayMs = STALE_JOB_CLEANUP_INTERVAL_MS) {
  if (!STALE_JOB_CLEANUP_ENABLED) return;
  if (staleJobCleanupRuntime.timer) clearTimeout(staleJobCleanupRuntime.timer);
  staleJobCleanupRuntime.timer = setTimeout(() => {
    staleJobCleanupRuntime.timer = null;
    cleanupStaleJobs({ force: true, source: "timer" })
      .finally(() => scheduleStaleJobCleanup());
  }, Math.max(1000, Number(delayMs) || STALE_JOB_CLEANUP_INTERVAL_MS));
  staleJobCleanupRuntime.timer.unref?.();
}

function startStaleJobCleanup() {
  if (!STALE_JOB_CLEANUP_ENABLED) return;
  cleanupStaleJobs({ force: true, source: "startup" })
    .finally(() => scheduleStaleJobCleanup());
}

async function pollOutboxOnce() {
  if (!OUTBOX_POLLER_ENABLED || outboxRuntime.polling) return;
  outboxRuntime.polling = true;
  outboxRuntime.lastPollAt = new Date().toISOString();
  try {
    const events = await listUnpublishedAppEvents(100);
    const publishedIds = [];
    for (const event of events) {
      publishEvent(event.event_type, event.payload || {});
      publishedIds.push(event.id);
    }
    if (publishedIds.length) {
      await markAppEventsPublished(publishedIds);
      outboxRuntime.lastPublishedAt = new Date().toISOString();
    }
    outboxRuntime.lastError = null;
  } catch (error) {
    outboxRuntime.lastError = { message: error.message, at: new Date().toISOString() };
    console.error(error.stack || error.message || error);
  } finally {
    outboxRuntime.polling = false;
  }
}

function scheduleOutboxPoller(delayMs = OUTBOX_POLL_INTERVAL_MS) {
  if (!OUTBOX_POLLER_ENABLED) return;
  if (outboxRuntime.timer) clearTimeout(outboxRuntime.timer);
  outboxRuntime.timer = setTimeout(() => {
    outboxRuntime.timer = null;
    pollOutboxOnce()
      .finally(() => scheduleOutboxPoller());
  }, Math.max(250, Number(delayMs) || OUTBOX_POLL_INTERVAL_MS));
  outboxRuntime.timer.unref?.();
}

function startOutboxPoller() {
  if (!OUTBOX_POLLER_ENABLED) return;
  pollOutboxOnce()
    .finally(() => scheduleOutboxPoller());
}

function jobAgeMs(job) {
  const startedAt = new Date(job?.started_at || 0).getTime();
  return Number.isFinite(startedAt) ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
}

async function runningDatabaseJob({ ignoreDailyJobs = false, ignorePaperReportQueueJobs = false } = {}) {
  return activeDatabaseJob({ ignoreDailyJobs, ignorePaperReportQueueJobs, includeQueued: false });
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
  if (persist) await publishDurableSettingsChanged(activeSettings, status);
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
  if (persist) await publishDurableSettingsChanged(activeSettings, status);
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
  await publishDurableSettingsChanged(data.settings, scheduler);
  return { ok: true, mode, settings: data.settings, scheduler };
}

async function runManagedJob(command, source = "manual", args = []) {
  if (isQueueJobBackend()) {
    return enqueueManagedJob(command, source, args);
  }
  return runManagedCliJob(command, source, args);
}

async function enqueueManagedJob(command, source = "manual", args = []) {
  const isDailyJob = isDailyJobCommand(command);
  const active = await activeDatabaseJob({
    ignorePaperReportQueueJobs: isDailyJob,
    includeQueued: true
  });
  if (active) {
    const err = new Error(`Database job is already active: ${active.job_type} #${active.id}`);
    err.statusCode = 409;
    throw err;
  }
  const queued = await enqueueWorkerJob({
    jobType: command,
    payload: { command, source, args },
    priority: jobPriority(command),
    message: `${command} queued`
  });
  const response = queuedTaskResponse(command, source, args, queued);
  jobRuntime.lastJob = {
    id: response.job_id,
    command,
    source,
    args,
    status: "queued",
    started_at: queued.job_run?.started_at || new Date().toISOString(),
    finished_at: null,
    message: response.message,
    worker_job_id: response.worker_job_id
  };
  await publishDurableTaskEvent(SERVER_EVENTS.TASK_STARTED, jobRuntime.lastJob, { status: "queued" });
  return response;
}

async function runManagedCliJob(command, source = "manual", args = []) {
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
  const activeWorkerJobs = isQueueJobBackend() ? await countActiveWorkerJobs(PAPER_REPORT_QUEUE_COMMAND) : 0;
  if (isQueueJobBackend()) {
    paperReportQueueRuntime.active = activeWorkerJobs;
    paperReportQueueRuntime.activeJobs = [];
  }
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

  const data = await getNodePaperReportsSummary();
  const queued = Number(data?.stats?.queued || 0);
  if (!queued) {
    paperReportQueueRuntime.lastSkipReason = "empty";
    schedulePaperReportQueue();
    return schedulerStatus();
  }

  const available = Math.max(0, concurrency - paperReportQueueRuntime.active);
  const launchCount = Math.min(queued, available);
  if (isQueueJobBackend()) {
    for (let index = 0; index < launchCount; index += 1) {
      const queuedJob = await enqueueWorkerJob({
        jobType: PAPER_REPORT_QUEUE_COMMAND,
        payload: {
          command: PAPER_REPORT_QUEUE_COMMAND,
          source: "paper-report-queue",
          args: ["--limit", "1"],
          limit: 1
        },
        priority: jobPriority(PAPER_REPORT_QUEUE_COMMAND),
        message: `${PAPER_REPORT_QUEUE_COMMAND} queued`
      });
      await publishDurableTaskEvent(SERVER_EVENTS.TASK_STARTED, {
        id: queuedJob.job_run?.id || null,
        command: PAPER_REPORT_QUEUE_COMMAND,
        source: "paper-report-queue",
        args: ["--limit", "1"],
        status: "queued",
        started_at: queuedJob.job_run?.started_at || new Date().toISOString(),
        message: `${PAPER_REPORT_QUEUE_COMMAND} queued`
      }, { status: "queued" });
    }
    paperReportQueueRuntime.active += launchCount;
    paperReportQueueRuntime.lastSkipReason = `queued:${launchCount}`;
    schedulePaperReportQueue(1000);
    return schedulerStatus();
  }
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
  await cleanupStaleJobs({ source: "daily-state" });
  const today = localDateKey(new Date());
  const history = await getJobsHistoryResponse(500);
  for (const job of history.items || []) {
    const finishedAt = job.finished_at || job.started_at;
    if (job.job_type !== "run-daily" || localDateKey(finishedAt) !== today) continue;
    if (job.status === "running") return "running";
    if (job.status === "completed") return "completed";
  }
  return "none";
}

async function dailyRunRecoveryState() {
  const data = await getNotificationsResponse(20);
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
    .then((data) => {
      startupDailyRuntime.lastRunAt = new Date().toISOString();
      startupDailyRuntime.lastSkipReason = data?.queued ? "queued" : "completed";
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
  recordResponseSizeBytes(Buffer.byteLength(payload));
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
    const data = await getNodeProjects();
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/experiments/reports") {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-experiment-report"], JSON.stringify(body));
    sendJson(res, 200, data);
    await publishDurableEvent(SERVER_EVENTS.EXPERIMENT_REPORT_UPSERTED, compactExperimentReportPayload(data));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readRequestJson(req);
    const data = await saveNodeProject(body);
    const rawContext = projectContextText(body);
    if (rawContext && data?.project?.id) {
      data.context_job = await enqueueProjectWorkerJob(
        "project-context",
        data.project.id,
        {
          raw_context: rawContext,
          title: `${data.project.name || "Project"} context`
        },
        { source: "project-save" }
      );
    }
    sendJson(res, 200, data);
    await publishDurableProjectChanged(body.id ? SERVER_EVENTS.PROJECT_UPDATED : SERVER_EVENTS.PROJECT_CREATED, data, body.id);
    return;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (req.method === "GET" && projectMatch) {
    const data = await getNodeProjectDetail(projectMatch[1]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && projectMatch) {
    const body = await readRequestJson(req);
    const payload = { ...body, id: Number(projectMatch[1]) };
    const data = await saveNodeProject(payload);
    const rawContext = projectContextText(body);
    if (rawContext && data?.project?.id) {
      data.context_job = await enqueueProjectWorkerJob(
        "project-context",
        data.project.id,
        {
          raw_context: rawContext,
          title: `${data.project.name || "Project"} context`
        },
        { source: "project-save" }
      );
    }
    sendJson(res, 200, data);
    await publishDurableProjectChanged(SERVER_EVENTS.PROJECT_UPDATED, data, projectMatch[1]);
    return;
  }

  const projectExportMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/export-obsidian$/);
  if (req.method === "POST" && projectExportMatch) {
    if (isQueueJobBackend()) {
      const data = await enqueueProjectWorkerJob(
        "project-export-obsidian",
        projectExportMatch[1],
        {},
        { source: "project-export" }
      );
      sendJson(res, 200, data);
      return;
    }
    const data = await jsonFromWorker(["api-project-export", projectExportMatch[1]]);
    sendJson(res, 200, data);
    await publishDurableProjectChanged(SERVER_EVENTS.PROJECT_UPDATED, data, projectExportMatch[1], { reason: "export_obsidian" });
    return;
  }

  const projectIndexMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/artifacts\/project-index$/);
  if (req.method === "POST" && projectIndexMatch) {
    const body = await readRequestJson(req);
    if (isQueueJobBackend()) {
      const data = await enqueueProjectWorkerJob(
        "project-index",
        projectIndexMatch[1],
        {
          export_to_obsidian: Boolean(body.export_to_obsidian),
          relative_path: body.relative_path || ""
        },
        { source: "project-index" }
      );
      sendJson(res, 200, data);
      return;
    }
    const data = await jsonFromWorker(["api-project-index", projectIndexMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
    await publishDurableProjectChanged(SERVER_EVENTS.PROJECT_UPDATED, data, projectIndexMatch[1], { reason: "project_index" });
    await publishDurableArtifactChanged(SERVER_EVENTS.ARTIFACT_CREATED, data, data?.generated_artifact?.id);
    return;
  }

  const projectPaperMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/papers$/);
  if (req.method === "POST" && projectPaperMatch) {
    const body = await readRequestJson(req);
    const data = await linkNodeProjectPaper(projectPaperMatch[1], body);
    sendJson(res, 200, data);
    await publishDurableEvent(SERVER_EVENTS.PROJECT_PAPER_LINKED, {
      project_id: eventNumber(projectPaperMatch[1]),
      paper_id: eventNumber(body.paper_id),
      relation: body.relation || null,
      project: compactProjectPayload(data, projectPaperMatch[1])
    });
    return;
  }

  const projectPaperDeleteMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/papers\/(\d+)$/);
  if (req.method === "DELETE" && projectPaperDeleteMatch) {
    const data = await unlinkNodeProjectPaper(projectPaperDeleteMatch[1], projectPaperDeleteMatch[2]);
    sendJson(res, 200, data);
    await publishDurableEvent(SERVER_EVENTS.PROJECT_PAPER_UNLINKED, {
      project_id: eventNumber(projectPaperDeleteMatch[1]),
      paper_id: eventNumber(projectPaperDeleteMatch[2]),
      project: compactProjectPayload(data, projectPaperDeleteMatch[1])
    });
    return;
  }

  const projectNoteMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/notes$/);
  if (req.method === "POST" && projectNoteMatch) {
    const body = await readRequestJson(req);
    const data = await linkNodeProjectNote(projectNoteMatch[1], body);
    sendJson(res, 200, data);
    await publishDurableEvent(SERVER_EVENTS.PROJECT_NOTE_LINKED, {
      project_id: eventNumber(projectNoteMatch[1]),
      note_id: eventNumber(body.note_id),
      relation: body.relation || null,
      project: compactProjectPayload(data, projectNoteMatch[1])
    });
    return;
  }

  const projectNoteDeleteMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/notes\/(\d+)$/);
  if (req.method === "DELETE" && projectNoteDeleteMatch) {
    const data = await unlinkNodeProjectNote(projectNoteDeleteMatch[1], projectNoteDeleteMatch[2]);
    sendJson(res, 200, data);
    await publishDurableEvent(SERVER_EVENTS.PROJECT_NOTE_UNLINKED, {
      project_id: eventNumber(projectNoteDeleteMatch[1]),
      note_id: eventNumber(projectNoteDeleteMatch[2]),
      project: compactProjectPayload(data, projectNoteDeleteMatch[1])
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    const data = await getAppSettingsResponse();
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
    await publishDurableSettingsChanged(data.settings, responseBody.scheduler);
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
    const data = await getHealthResponse();
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health/summary") {
    const data = await getHealthSummaryResponse();
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/status") {
    sendJson(res, 200, { scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/summary") {
    const data = await getJobsSummaryResponse();
    sendJson(res, 200, { ...data, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/history") {
    const limit = url.searchParams.get("limit") || "20";
    const data = await getJobsHistoryResponse(limit);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const limit = url.searchParams.get("limit") || "5";
    const data = await getNotificationsResponse(limit);
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
    const data = await getNodeInbox();
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/paper-reports/summary") {
    const data = await getNodePaperReportsSummary();
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/paper-reports") {
    const data = await getNodeReaderPapers({
      limit: url.searchParams.get("limit") || "300",
      offset: url.searchParams.get("offset") || "0",
      q: url.searchParams.get("q") || "",
      status: url.searchParams.get("status") || "",
      project_id: url.searchParams.get("project_id") || "",
      source: url.searchParams.get("source") || ""
    });
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/library") {
    const data = await getNodePaperLibrary({
      status: url.searchParams.get("status") || "",
      source_type: url.searchParams.get("source_type") || "",
      report_presence: url.searchParams.get("report_presence") || "",
      project_id: url.searchParams.get("project_id") || "",
      q: url.searchParams.get("q") || "",
      date_from: url.searchParams.get("date_from") || "",
      date_to: url.searchParams.get("date_to") || "",
      limit: url.searchParams.get("limit") || "100",
      offset: url.searchParams.get("offset") || "0"
    });
    sendJson(res, 200, data);
    return;
  }

  const libraryPaperMatch = url.pathname.match(/^\/api\/library\/(\d+)$/);
  if (req.method === "GET" && libraryPaperMatch) {
    const data = await getNodePaperLibraryDetail(libraryPaperMatch[1]);
    sendJson(res, 200, data);
    return;
  }

  const libraryStatusMatch = url.pathname.match(/^\/api\/library\/(\d+)\/status$/);
  if (req.method === "POST" && libraryStatusMatch) {
    const body = await readRequestJson(req);
    const data = await updateNodePaperLibraryStatus(libraryStatusMatch[1], body);
    sendJson(res, 200, data);
    await publishDurablePaperChanged(SERVER_EVENTS.PAPER_LIBRARY_STATUS_UPDATED, data, libraryStatusMatch[1], {
      library_status: data?.paper?.library_status || body.status || body.library_status || null
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts") {
    const data = await getNodeArtifacts({
      scope_type: url.searchParams.get("scope_type") || "",
      scope_id: url.searchParams.get("scope_id") || "",
      artifact_type: url.searchParams.get("artifact_type") || "",
      status: url.searchParams.get("status") || "",
      limit: url.searchParams.get("limit") || "100",
      offset: url.searchParams.get("offset") || "0"
    });
    sendJson(res, 200, data);
    return;
  }

  const artifactMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)$/);
  if (req.method === "GET" && artifactMatch) {
    const data = await getNodeArtifactDetail(artifactMatch[1]);
    sendJson(res, 200, data);
    return;
  }

  const artifactExportMatch = url.pathname.match(/^\/api\/artifacts\/(\d+)\/export-obsidian$/);
  if (req.method === "POST" && artifactExportMatch) {
    const body = await readRequestJson(req);
    if (isQueueJobBackend()) {
      const data = await enqueueActionWorkerJob(
        "artifact-export-obsidian",
        { artifact_id: eventNumber(artifactExportMatch[1]), body },
        { source: "artifact-export", args: [artifactExportMatch[1]] }
      );
      sendJson(res, 202, data);
      return;
    }
    const data = await jsonFromWorker(["api-artifact-export", artifactExportMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
    await publishDurableArtifactChanged(SERVER_EVENTS.ARTIFACT_UPDATED, data, artifactExportMatch[1], { reason: "export_obsidian" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/reader/papers") {
    const data = await getNodeReaderPapers({
      limit: url.searchParams.get("limit") || "300",
      offset: url.searchParams.get("offset") || "0",
      q: url.searchParams.get("q") || "",
      status: url.searchParams.get("status") || "",
      project_id: url.searchParams.get("project_id") || "",
      source: url.searchParams.get("source") || ""
    });
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reader/papers/upload") {
    const settings = await readAppSettings();
    const stagedUpload = await stageReaderPdfUploads(req, {
      pdfDirectory: settings.arxiv_pdf_dir,
      maxFileBytes: READER_UPLOAD_MAX_FILE_BYTES,
      maxFiles: READER_UPLOAD_MAX_FILES
    });
    const body = { files: stagedUpload.files };
    try {
      if (isQueueJobBackend()) {
        const data = await enqueueActionWorkerJob(
          "reader-import-upload",
          { body },
          { source: "reader-upload", maxAttempts: 2 }
        );
        sendJson(res, 202, data);
        return;
      }
      const data = await jsonFromWorker(["api-reader-upload"], JSON.stringify(body));
      sendJson(res, 200, data);
      await publishDurableEvent(SERVER_EVENTS.READER_PAPERS_IMPORTED, {
        source: "upload",
        imported: Array.isArray(data.imported) ? data.imported.map((item) => ({
          paper_id: eventNumber(item.paper_id || item.id),
          title: item.title || null
        })).filter((item) => item.paper_id) : [],
        imported_count: Array.isArray(data.imported) ? data.imported.length : 0,
        error_count: Array.isArray(data.errors) ? data.errors.length : 0
      });
      return;
    } catch (error) {
      await discardStagedReaderUploads(stagedUpload.files).catch((cleanupError) => {
        console.error("Failed to discard staged PDF upload", cleanupError);
      });
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/reader/papers/urls") {
    const body = await readRequestJson(req);
    if (isQueueJobBackend()) {
      const data = await enqueueActionWorkerJob(
        "reader-import-url",
        { body },
        { source: "reader-url", maxAttempts: 2 }
      );
      sendJson(res, 202, data);
      return;
    }
    const data = await jsonFromWorker(["api-reader-urls"], JSON.stringify(body));
    sendJson(res, 200, data);
    await publishDurableEvent(SERVER_EVENTS.READER_PAPERS_IMPORTED, {
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
    const data = await getNodeReaderPaperDetail(readerPaperMatch[1]);
    sendJson(res, 200, data);
    return;
  }

  const readerPdfMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/pdf$/);
  if (req.method === "GET" && readerPdfMatch) {
    const data = await getNodeReaderPaperPdfPath(readerPdfMatch[1]);
    const rawPath = String(data?.paper?.pdf_path || data?.pdf_path || "");
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

  const readerReferencesMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/reference-papers$/);
  if (req.method === "PUT" && readerReferencesMatch) {
    const body = await readRequestJson(req);
    const data = await saveNodeReaderReferencePapers(readerReferencesMatch[1], body);
    sendJson(res, 200, data);
    await publishDurablePaperChanged(
      SERVER_EVENTS.READER_PAPER_UPDATED,
      data,
      readerReferencesMatch[1],
      { action: "reference_papers_updated" }
    );
    return;
  }
  if (req.method === "PATCH" && readerPaperMatch) {
    const body = await readRequestJson(req);
    const data = await updateNodeReaderPaperTitle(readerPaperMatch[1], body);
    sendJson(res, 200, data);
    await publishDurablePaperChanged(SERVER_EVENTS.READER_PAPER_UPDATED, data, readerPaperMatch[1], {
      action: "update_title"
    });
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
      await publishDurablePaperChanged(SERVER_EVENTS.READER_MESSAGE_UPDATED, {}, readerChatMatch[1], { action: "chat_stream" });
      return;
    }
    sendJson(res, 400, {
      error: "Reader chat requires streaming. Send stream: true and consume text/event-stream.",
      code: "stream_required"
    });
    return;
  }

  const readerSaveMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/save$/);
  if (req.method === "POST" && readerSaveMatch) {
    if (isQueueJobBackend()) {
      const data = await enqueueActionWorkerJob(
        "reader-save-obsidian",
        { paper_id: eventNumber(readerSaveMatch[1]) },
        { source: "reader-save", args: [readerSaveMatch[1]] }
      );
      sendJson(res, 202, data);
      return;
    }
    const data = await jsonFromWorker(["api-reader-save", readerSaveMatch[1]]);
    sendJson(res, 200, data);
    await publishDurablePaperChanged(SERVER_EVENTS.READER_PAPER_UPDATED, data, readerSaveMatch[1], { action: "save_obsidian" });
    return;
  }

  const readerFollowupsMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/follow-up-questions$/);
  if (req.method === "POST" && readerFollowupsMatch) {
    const body = await readRequestJson(req);
    if (!READER_FOLLOWUPS_SYNC_FALLBACK_ENABLED) {
      sendJson(res, 501, {
        error: "Reader follow-up questions require the synchronous interactive fallback until async suggestions are implemented.",
        code: "reader_followups_sync_fallback_disabled"
      });
      return;
    }
    // TODO: replace this with an async suggestion flow backed by worker_jobs result polling.
    // Interactive generation must return question suggestions to the current selection UI.
    const data = await jsonFromWorker([
      "api-reader-followups",
      readerFollowupsMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    return;
  }

  const readerMessageMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/messages\/(\d+)$/);
  if (req.method === "DELETE" && readerMessageMatch) {
    const data = await deleteNodeReaderMessage(readerMessageMatch[1], readerMessageMatch[2]);
    sendJson(res, 200, data);
    await publishDurablePaperChanged(SERVER_EVENTS.READER_MESSAGE_DELETED, data, readerMessageMatch[1], {
      message_id: eventNumber(readerMessageMatch[2])
    });
    return;
  }

  const readerCancelMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/cancel$/);
  if (req.method === "POST" && readerCancelMatch) {
    const data = await cancelNodeReaderReport(readerCancelMatch[1]);
    sendJson(res, 200, data);
    await publishDurablePaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, readerCancelMatch[1], { action: "cancel" });
    return;
  }

  const readerRetryMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/retry$/);
  if (req.method === "POST" && readerRetryMatch) {
    const data = await retryNodeReaderReport(readerRetryMatch[1]);
    sendJson(res, 200, data);
    await publishDurablePaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, readerRetryMatch[1], { action: "retry" });
    return;
  }

  const readerReportMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/report$/);
  if (req.method === "DELETE" && readerReportMatch) {
    const data = await deleteNodeReaderReport(readerReportMatch[1]);
    sendJson(res, 200, data);
    await publishDurablePaperReportChanged(SERVER_EVENTS.PAPER_REPORT_DELETED, data, readerReportMatch[1]);
    return;
  }

  const paperMatch = url.pathname.match(/^\/api\/papers\/(\d+)$/);
  if (req.method === "GET" && paperMatch) {
    const data = await getNodeLegacyPaperDetail(paperMatch[1]);
    sendJson(res, 200, data);
    return;
  }

  const feedbackMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/feedback$/);
  if (req.method === "POST" && feedbackMatch) {
    const body = await readRequestJson(req);
    const status = String(body.status || "").trim();
    const note = String(body.note || "");
    const data = await saveNodePaperFeedback(feedbackMatch[1], status, note);
    sendJson(res, 200, data);
    await publishDurablePaperChanged(SERVER_EVENTS.PAPER_FEEDBACK_UPDATED, data, feedbackMatch[1], { status });
    return;
  }

  const paperRecommendationMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/recommendation$/);
  if (req.method === "POST" && paperRecommendationMatch) {
    const body = await readRequestJson(req);
    const data = await updateNodePaperRecommendation(paperRecommendationMatch[1], body);
    sendJson(res, 200, data);
    await publishDurablePaperChanged(SERVER_EVENTS.PAPER_RECOMMENDATION_UPDATED, data, paperRecommendationMatch[1], {
      action: body.action || null,
      project_ids: Array.isArray(body.project_ids) ? body.project_ids.map(eventNumber).filter(Boolean) : projectIdsFromData(data)
    });
    await publishDurablePaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, paperRecommendationMatch[1], {
      action: "recommendation_state"
    });
    return;
  }

  const paperReportMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/report$/);
  if (req.method === "DELETE" && paperReportMatch) {
    const data = await deleteNodeReaderReport(paperReportMatch[1]);
    sendJson(res, 200, data);
    await publishDurablePaperReportChanged(SERVER_EVENTS.PAPER_REPORT_DELETED, data, paperReportMatch[1]);
    return;
  }

  if (req.method === "POST" && paperReportMatch) {
    const body = await readRequestJson(req);
    if (isQueueJobBackend()) {
      const data = await enqueueActionWorkerJob(
        "paper-report",
        { paper_id: eventNumber(paperReportMatch[1]), force: Boolean(body.force), body },
        { source: "paper-report", args: [paperReportMatch[1]], priority: jobPriority(PAPER_REPORT_QUEUE_COMMAND) }
      );
      sendJson(res, 202, data);
      return;
    }
    const data = await jsonFromWorker([
      "api-paper-report",
      paperReportMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    await publishDurablePaperReportChanged(SERVER_EVENTS.PAPER_REPORT_UPDATED, data, paperReportMatch[1], {
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

async function handleHttpRequest(req, res, url) {
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
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const timingContext = createRequestTimingContext(req, url);
  requestTimingStorage.run(timingContext, () => {
    handleHttpRequest(req, res, url)
      .finally(() => logRequestTiming(timingContext, res));
  });
});

server.listen(PORT, () => {
  console.log(`Research Intelligence dashboard listening on http://localhost:${PORT}`);
  startStaleJobCleanup();
  startOutboxPoller();
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
