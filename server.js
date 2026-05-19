import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ENV_PATH = join(__dirname, ".env");
loadDotEnv(ENV_PATH);

const PORT = Number(process.env.PORT || 3000);
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const DIST_DIR = join(__dirname, "dist");
const PUBLIC_DIR = existsSync(DIST_DIR) ? DIST_DIR : join(__dirname, "public");
const PAPER_REPORT_QUEUE_INTERVAL_MS = Math.max(2000, Number(process.env.PAPER_REPORT_QUEUE_INTERVAL_MS || 5000));
const PAPER_REPORT_QUEUE_DEFAULT_CONCURRENCY = Math.max(
  1,
  Number(process.env.PAPER_REPORT_QUEUE_CONCURRENCY || process.env.PAPER_REPORT_QUEUE_LIMIT || 1)
);
const IN_MEMORY_JOB_RECONCILE_GRACE_MS = Math.max(
  5000,
  Number(process.env.IN_MEMORY_JOB_RECONCILE_GRACE_MS || 60000)
);

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
          const stderrText = String(stderr || "").trim();
          const stdoutText = String(stdout || "").trim();
          try {
            const parsed = JSON.parse(stdout || "{}");
            if (parsed.error) message = parsed.error;
          } catch {
            message = stderrText || stdoutText || error.message;
          }
          if (stderrText && !String(message).includes(stderrText)) {
            message = `${message}\n${stderrText}`.trim();
          }
          const err = new Error(message);
          err.statusCode = 500;
          err.stdout = stdoutText;
          err.stderr = stderrText;
          reject(err);
          return;
        }
        resolvePromise(stdout);
      }
    );
  if (input !== null) child.stdin.end(input, "utf8");
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

async function readAppSettings() {
  const data = await jsonFromWorker(["api-settings"]);
  return data.settings || {};
}

async function saveAppSettings(payload) {
  return jsonFromWorker(["api-settings-save"], JSON.stringify(payload));
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

async function runningDatabaseJob() {
  await cleanupStaleJobs();
  const history = await jsonFromWorker(["api-jobs-history", "--limit", "100"]);
  return (history.items || []).find((job) => job.status === "running") || null;
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

async function runManagedJob(command, source = "manual", args = []) {
  if (jobRuntime.currentJob) {
    await reconcileCurrentJobWithDatabase();
  }
  if (jobRuntime.currentJob) {
    const err = new Error(`Another job is already running: ${jobRuntime.currentJob.command}`);
    err.statusCode = 409;
    throw err;
  }
  if (source !== "paper-report-queue" && paperReportQueueRuntime.active > 0) {
    const err = new Error(`Paper report queue is running: ${paperReportQueueRuntime.active} active`);
    err.statusCode = 409;
    throw err;
  }
  if (source !== "paper-report-queue") {
    const running = await runningDatabaseJob();
    if (running) {
      const err = new Error(`Database job is already running: ${running.job_type} #${running.id}`);
      err.statusCode = 409;
      throw err;
    }
  }
  const startedAt = new Date().toISOString();
  jobRuntime.currentJob = { command, source, args, started_at: startedAt };
  try {
    const data = await jsonFromWorker([command, ...args]);
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
    return data;
  } catch (error) {
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
    throw error;
  } finally {
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
    command: "generate-paper-reports",
    source: "paper-report-queue",
    args: ["--limit", "1"],
    started_at: startedAt
  };
  paperReportQueueRuntime.active += 1;
  paperReportQueueRuntime.activeJobs = [...paperReportQueueRuntime.activeJobs, activeJob];
  try {
    const data = await jsonFromWorker(["generate-paper-reports", "--limit", "1"]);
    paperReportQueueRuntime.lastRunAt = new Date().toISOString();
    paperReportQueueRuntime.lastError = null;
    return data;
  } catch (error) {
    paperReportQueueRuntime.lastError = {
      message: error.message,
      at: new Date().toISOString()
    };
    return null;
  } finally {
    paperReportQueueRuntime.active = Math.max(0, paperReportQueueRuntime.active - 1);
    paperReportQueueRuntime.activeJobs = paperReportQueueRuntime.activeJobs.filter((job) => job.id !== workerId);
    schedulePaperReportQueue(1000);
  }
}

async function runPaperReportQueueOnce() {
  paperReportQueueRuntime.lastCheckAt = new Date().toISOString();
  paperReportQueueRuntime.lastSkipReason = null;
  if (jobRuntime.currentJob) {
    await reconcileCurrentJobWithDatabase();
  }
  const running = jobRuntime.currentJob ? null : await runningDatabaseJob();
  if (jobRuntime.currentJob) {
    paperReportQueueRuntime.lastSkipReason = `busy:${jobRuntime.currentJob.command}`;
    schedulePaperReportQueue();
    return schedulerStatus();
  }
  if (running) {
    paperReportQueueRuntime.lastSkipReason = `busy:${running.job_type}`;
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

  const data = await jsonFromWorker(["api-paper-reports", "--limit", String(concurrency)]);
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
  const running = jobRuntime.currentJob ? null : await runningDatabaseJob();
  if (jobRuntime.currentJob) {
    startupDailyRuntime.lastSkipReason = `busy:${jobRuntime.currentJob.command}`;
    return { triggered: false, reason: startupDailyRuntime.lastSkipReason, scheduler: schedulerStatus() };
  }
  if (running) {
    startupDailyRuntime.lastSkipReason = `busy:${running.job_type}`;
    return { triggered: false, reason: startupDailyRuntime.lastSkipReason, scheduler: schedulerStatus() };
  }
  if (paperReportQueueRuntime.active > 0) {
    startupDailyRuntime.lastSkipReason = `busy:paper_report_queue:${paperReportQueueRuntime.active}`;
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

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function localPathError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
    throw localPathError("请先选择或填写 Obsidian vault 路径，再选择 vault 内部路径。", 400);
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

  const projectIndexMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/artifacts\/project-index$/);
  if (req.method === "POST" && projectIndexMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-project-index", projectIndexMatch[1]], JSON.stringify(body));
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
    paperReportQueueRuntime.concurrency = paperReportQueueConcurrency(data.settings || {});
    schedulePaperReportQueue(1000);
    if (data.settings?.scheduler_enabled) {
      await startScheduler({ persist: false, settings: data.settings });
    } else {
      await stopScheduler({ persist: false });
      startupDailyRuntime.enabled = Boolean(data.settings?.run_daily_on_startup_enabled);
      if (startupDailyRuntime.enabled) {
        startupDailyRuntime.lastSkipReason = "will_run_on_next_dashboard_visit";
      }
    }
    sendJson(res, 200, { ...data, scheduler: schedulerStatus() });
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

  if (req.method === "GET" && url.pathname === "/api/reminders") {
    const limit = url.searchParams.get("limit") || "5";
    const data = await jsonFromWorker(["api-reminders", "--limit", limit]);
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

  if (req.method === "POST" && url.pathname === "/api/jobs/startup-daily/check") {
    const settings = await readAppSettings();
    const result = await runDailyOnDashboardOpenIfNeeded(settings);
    sendJson(res, 200, { ok: true, startup_daily_trigger: result, scheduler: schedulerStatus() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs/run-now") {
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
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reader/papers/urls") {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker(["api-reader-urls"], JSON.stringify(body));
    sendJson(res, 200, data);
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
      return;
    }
    const data = await jsonFromWorker([
      "api-reader-chat",
      readerChatMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    return;
  }

  const readerSaveMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/save$/);
  if (req.method === "POST" && readerSaveMatch) {
    const data = await jsonFromWorker(["api-reader-save", readerSaveMatch[1]]);
    sendJson(res, 200, data);
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
    return;
  }

  const readerCancelMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/cancel$/);
  if (req.method === "POST" && readerCancelMatch) {
    const data = await jsonFromWorker(["api-reader-cancel", readerCancelMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  const readerRetryMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/retry$/);
  if (req.method === "POST" && readerRetryMatch) {
    const data = await jsonFromWorker(["api-reader-retry", readerRetryMatch[1]]);
    sendJson(res, 200, data);
    return;
  }

  const readerReportMatch = url.pathname.match(/^\/api\/reader\/papers\/(\d+)\/report$/);
  if (req.method === "DELETE" && readerReportMatch) {
    const data = await jsonFromWorker(["api-delete-paper-report", readerReportMatch[1]]);
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

  const paperRecommendationMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/recommendation$/);
  if (req.method === "POST" && paperRecommendationMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker([
      "api-paper-recommendation",
      paperRecommendationMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
    return;
  }

  const paperReportMatch = url.pathname.match(/^\/api\/papers\/(\d+)\/report$/);
  if (req.method === "DELETE" && paperReportMatch) {
    const data = await jsonFromWorker([
      "api-delete-paper-report",
      paperReportMatch[1]
    ]);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && paperReportMatch) {
    const body = await readRequestJson(req);
    const data = await jsonFromWorker([
      "api-paper-report",
      paperReportMatch[1]
    ], JSON.stringify(body));
    sendJson(res, 200, data);
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
  schedulePaperReportQueue(1000);
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
