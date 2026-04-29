import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ENV_PATH = join(__dirname, ".env");
loadDotEnv(ENV_PATH);

const PORT = Number(process.env.PORT || 3000);
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const DIST_DIR = join(__dirname, "dist");
const PUBLIC_DIR = existsSync(DIST_DIR) ? DIST_DIR : join(__dirname, "public");

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
  lastCheckAt: null,
  lastRunAt: null,
  lastSkipReason: null
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
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
          let message = error.message;
          try {
            const parsed = JSON.parse(stdout || "{}");
            if (parsed.error) message = parsed.error;
          } catch {
            message = stderr || stdout || error.message;
          }
          const err = new Error(message);
          err.statusCode = 500;
          reject(err);
          return;
        }
        resolvePromise(stdout);
      }
    );
  if (input !== null) child.stdin.end(input, "utf8");
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

function schedulerStatus() {
  return {
    enabled: schedulerRuntime.enabled,
    next_run_at: toIso(schedulerRuntime.nextRunAt),
    current_job: jobRuntime.currentJob,
    last_job: jobRuntime.lastJob,
    last_error: schedulerRuntime.lastError,
    startup_daily: {
      enabled: startupDailyRuntime.enabled,
      last_check_at: startupDailyRuntime.lastCheckAt,
      last_run_at: startupDailyRuntime.lastRunAt,
      last_skip_reason: startupDailyRuntime.lastSkipReason
    }
  };
}

async function readAppSettings() {
  const data = await jsonFromWorker(["api-settings"]);
  return data.settings || {};
}

async function saveAppSettings(payload) {
  return jsonFromWorker(["api-settings-save"], JSON.stringify(payload));
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
    const data = await saveAppSettings({ scheduler_enabled: true });
    activeSettings = data.settings;
  }
  if (!activeSettings) activeSettings = await readAppSettings();
  schedulerRuntime.enabled = true;
  startupDailyRuntime.enabled = false;
  schedulerRuntime.lastError = null;
  scheduleNext(activeSettings);
  return schedulerStatus();
}

async function stopScheduler({ persist = true } = {}) {
  clearSchedulerTimer();
  schedulerRuntime.enabled = false;
  schedulerRuntime.nextRunAt = null;
  if (persist) await saveAppSettings({ scheduler_enabled: false });
  return schedulerStatus();
}

async function runManagedJob(command, source = "manual") {
  if (jobRuntime.currentJob) {
    const err = new Error(`Another job is already running: ${jobRuntime.currentJob.command}`);
    err.statusCode = 409;
    throw err;
  }
  const startedAt = new Date().toISOString();
  jobRuntime.currentJob = { command, source, started_at: startedAt };
  try {
    const data = await jsonFromWorker([command]);
    const finishedAt = new Date().toISOString();
    jobRuntime.lastJob = {
      command,
      source,
      status: "completed",
      started_at: startedAt,
      finished_at: finishedAt,
      message: data.message || `${command} completed`,
      result: data
    };
    return data;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    jobRuntime.lastJob = {
      command,
      source,
      status: "failed",
      started_at: startedAt,
      finished_at: finishedAt,
      message: error.message
    };
    schedulerRuntime.lastError = { message: error.message, at: finishedAt };
    throw error;
  } finally {
    jobRuntime.currentJob = null;
  }
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

async function completedRunDailyToday() {
  const today = localDateKey(new Date());
  const history = await jsonFromWorker(["api-jobs-history", "--limit", "500"]);
  return (history.items || []).some((job) => {
    const finishedAt = job.finished_at || job.started_at;
    return job.job_type === "run-daily" && job.status === "completed" && localDateKey(finishedAt) === today;
  });
}

async function runDailyOnStartupIfNeeded(settings) {
  startupDailyRuntime.enabled = Boolean(settings.run_daily_on_startup_enabled);
  startupDailyRuntime.lastCheckAt = new Date().toISOString();
  startupDailyRuntime.lastSkipReason = null;
  if (!startupDailyRuntime.enabled) return schedulerStatus();
  if (settings.scheduler_enabled) {
    startupDailyRuntime.enabled = false;
    startupDailyRuntime.lastSkipReason = "scheduler_enabled";
    return schedulerStatus();
  }
  if (await completedRunDailyToday()) {
    startupDailyRuntime.lastSkipReason = "already_completed_today";
    return schedulerStatus();
  }
  await runManagedJob("run-daily", "startup");
  startupDailyRuntime.lastRunAt = new Date().toISOString();
  return schedulerStatus();
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

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream"
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/projects") {
    const data = await jsonFromWorker(["api-projects"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-save"], JSON.stringify(body));
    sendJson(res, 200, data);
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
    return;
  }

  const projectExportMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/export-obsidian$/);
  if (req.method === "POST" && projectExportMatch) {
    const data = await jsonFromWorker(["api-project-export", projectExportMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  const projectPaperMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/papers$/);
  if (req.method === "POST" && projectPaperMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-link-paper", projectPaperMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
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
    return;
  }

  const projectNoteMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/notes$/);
  if (req.method === "POST" && projectNoteMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-link-note", projectNoteMatch[1]], JSON.stringify(body));
    sendJson(res, 200, data);
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
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    const data = await jsonFromWorker(["api-settings"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readRequestJson(req);
    const data = await saveAppSettings(body);
    if (data.settings?.scheduler_enabled) {
      await startScheduler({ persist: false, settings: data.settings });
    } else {
      await stopScheduler({ persist: false });
      startupDailyRuntime.enabled = Boolean(data.settings?.run_daily_on_startup_enabled);
      if (startupDailyRuntime.enabled) {
        startupDailyRuntime.lastSkipReason = "will_run_on_next_dashboard_start";
      }
    }
    sendJson(res, 200, { ...data, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const data = await jsonFromWorker(["api-health"]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/status") {
    sendJson(res, 200, { scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs/history") {
    const limit = url.searchParams.get("limit") || "20";
    const data = await jsonFromWorker(["api-jobs-history", "--limit", limit]);
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

  if (req.method === "POST" && url.pathname === "/api/jobs/run-now") {
    const data = await runManagedJob("run-daily", "manual");
    sendJson(res, 200, { ok: true, ...data, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inbox") {
    const data = await jsonFromWorker(["api-inbox"]);
    sendJson(res, 200, data);
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
    return;
  }

  const jobMap = {
    "/api/jobs/sync-obsidian": "sync-obsidian",
    "/api/jobs/fetch-arxiv": "fetch-arxiv",
    "/api/jobs/cache-arxiv-text": "cache-arxiv-text",
    "/api/jobs/generate-reports": "generate-reports",
    "/api/jobs/run-daily": "run-daily"
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
      await routeApi(req, res, url);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    console.error(error.stack || error.message || error);
    sendJson(res, error.statusCode || 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Research Intelligence dashboard listening on http://localhost:${PORT}`);
  readAppSettings()
    .then(async (settings) => {
      if (settings.scheduler_enabled) {
        return startScheduler({ persist: false, settings });
      }
      return runDailyOnStartupIfNeeded(settings);
    })
    .catch((error) => {
      schedulerRuntime.lastError = { message: error.message, at: new Date().toISOString() };
    });
});
