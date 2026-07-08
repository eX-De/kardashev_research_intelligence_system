import { readFileSync } from "node:fs";

import { envValue } from "./env.js";
import { parseJson, query, ValidationError } from "./db.js";

export const UPDATE_NOTIFICATION_TYPE = "app_update_available";

const UPDATE_STATUS_SETTING = "app_update_status";
const DEFAULT_REPOSITORY = "exde1968/kardashev-research-intelligence-system";
const ARXIV_RATE_LIMITED = "arxiv_rate_limited";
const DAILY_JOB_TYPES = new Set(["run-daily", "resume-daily", "retry-daily"]);
const ACTIVE_NOTIFICATION_TYPES = new Set([
  ARXIV_RATE_LIMITED,
  UPDATE_NOTIFICATION_TYPE,
  "daily_run_recoverable",
  "daily_run_progress",
  "job_running",
  "paper_report_queue_processing"
]);
const SEVERITY_RANK = {
  bad: 3,
  warn: 2,
  ok: 1,
  info: 1,
  neutral: 0
};
const JOB_TITLES = {
  "run-daily": "每日流程",
  "resume-daily": "恢复每日流程",
  "retry-daily": "历史论文补跑",
  "fetch-arxiv": "arXiv 抓取",
  "cache-arxiv-text": "论文正文缓存",
  "generate-paper-reports": "全文报告生成",
  "generate-reports": "每日总报告生成",
  "sync-obsidian": "Obsidian 同步",
  "rank-papers": "论文匹配",
  "project-index": "项目索引生成",
  "project-export-obsidian": "项目导出",
  "project-context": "项目上下文入库"
};

const notificationBuilders = [];

function registerNotificationBuilder(type, description, builder) {
  notificationBuilders.push({ type, description, builder });
}

export function registeredNotificationBuilders() {
  return notificationBuilders.map(({ type, description }) => ({ type, description }));
}

export function normalizeNotificationLimit(value, fallback = 5) {
  const raw = value === null || value === undefined || String(value).trim() === ""
    ? fallback
    : value;
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new ValidationError("limit must be an integer");
  }
  return Math.max(1, Number.parseInt(text, 10));
}

function safeInt(value) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return parsed > 0 ? parsed : null;
}

function jobTitle(jobType) {
  return JOB_TITLES[jobType] || jobType || "任务";
}

function metaNumber(meta, keys) {
  for (const key of keys) {
    const parsed = Number.parseInt(meta?.[key] || 0, 10);
    if (parsed) return parsed;
  }
  return 0;
}

function notification(
  id,
  type,
  severity,
  title,
  detail,
  {
    createdAt = null,
    source = {},
    channels = ["list"],
    requiresAction = false,
    progress = null
  } = {}
) {
  const item = {
    id,
    type,
    severity,
    title,
    detail,
    created_at: createdAt,
    source: source || {},
    channels: channels || ["list"],
    requires_action: Boolean(requiresAction)
  };
  if (progress) item.progress = progress;
  return item;
}

function activityTime(item = {}) {
  return String(item.finished_at || item.started_at || "");
}

function notificationSortKey(item) {
  return [
    ACTIVE_NOTIFICATION_TYPES.has(item?.type) ? 1 : 0,
    String(item?.created_at || ""),
    SEVERITY_RANK[String(item?.severity || "")] || 0
  ];
}

function compareNotificationsDesc(left, right) {
  const leftKey = notificationSortKey(left);
  const rightKey = notificationSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] > rightKey[index]) return -1;
    if (leftKey[index] < rightKey[index]) return 1;
  }
  return 0;
}

async function activityRows(limit = 20) {
  const result = await query(
    `
      SELECT id, job_type, status, started_at, finished_at, message, meta_json
      FROM job_runs
      ORDER BY id DESC
      LIMIT $1
    `,
    [limit]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    job_type: row.job_type,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    message: row.message,
    meta: parseJson(row.meta_json, {})
  }));
}

async function paperReportStats() {
  const stats = { queued: 0, processing: 0, done: 0, failed: 0, total: 0 };
  const result = await query(`
    SELECT status, COUNT(*) AS count
    FROM artifacts
    WHERE scope_type = 'paper'
      AND artifact_type = 'paper_report'
      AND status != 'removed'
    GROUP BY status
  `);
  for (const row of result.rows) {
    const status = String(row.status || "");
    const count = Number(row.count || 0);
    stats[status] = count;
    stats.total += count;
  }
  return stats;
}

async function experimentReportRows(limit = 5) {
  const result = await query(
    `
      SELECT id, scope_id, title, source_json, updated_at
      FROM artifacts
      WHERE artifact_type = 'experiment_report'
        AND status != 'removed'
      ORDER BY updated_at DESC, id DESC
      LIMIT $1
    `,
    [normalizeNotificationLimit(limit, 5)]
  );
  return result.rows.map((row) => {
    const parsedSource = parseJson(row.source_json, {});
    const source = parsedSource && typeof parsedSource === "object" && !Array.isArray(parsedSource)
      ? parsedSource
      : {};
    return {
      id: Number(row.id),
      project_id: safeInt(source.project_id) || safeInt(row.scope_id),
      title: row.title,
      source_agent: String(source.source_agent || source.source || "").trim(),
      updated_at: row.updated_at
    };
  });
}

function completed(activities, predicate) {
  return activities.find((item) => item.status === "completed" && predicate(item.meta || {}, item)) || null;
}

async function recoverableDailyRun() {
  const latestCompletedResult = await query(`
    SELECT COALESCE(MAX(id), 0) AS id
    FROM job_runs
    WHERE job_type IN ('run-daily', 'resume-daily', 'retry-daily')
      AND status = 'completed'
  `);
  const latestCompletedId = Number(latestCompletedResult.rows?.[0]?.id || 0);
  const result = await query(
    `
      SELECT jr.id, jr.job_type, jr.status, jr.started_at, jr.finished_at, jr.message,
             jr.meta_json, drm.mode, drm.source_job_id, drm.arxiv_batch_id
      FROM job_runs jr
      JOIN daily_run_meta drm ON drm.job_id = jr.id
      WHERE jr.job_type IN ('run-daily', 'resume-daily', 'retry-daily')
        AND jr.status = 'failed'
        AND jr.id > $1
        AND EXISTS (
          SELECT 1 FROM daily_run_papers drp
          WHERE drp.job_id = jr.id AND drp.selected = 1
        )
      ORDER BY jr.id DESC
      LIMIT 1
    `,
    [latestCompletedId]
  );
  const row = result.rows?.[0];
  if (!row) return null;
  const meta = parseJson(row.meta_json, {});
  return {
    id: Number(row.id),
    job_type: row.job_type,
    started_at: row.started_at,
    finished_at: row.finished_at,
    message: row.message,
    meta: meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}
  };
}

function dailyRecoveryPayload(job) {
  const progress = job?.meta?.daily_progress && typeof job.meta.daily_progress === "object"
    ? job.meta.daily_progress
    : {};
  const steps = Array.isArray(progress.steps) ? progress.steps : [];
  const failedStep = steps.find((step) => step && typeof step === "object" && step.status === "failed") || {};
  const completedCount = Number.parseInt(
    progress.completed || steps.filter((step) => step && typeof step === "object" && step.status === "completed").length,
    10
  ) || 0;
  const total = Number.parseInt(progress.total || steps.length || 0, 10) || 0;
  return {
    resumable: true,
    job_id: Number(job.id),
    failed_step: String(failedStep.key || progress.current_key || ""),
    failed_label: String(failedStep.label || progress.current_label || "未知阶段"),
    completed: completedCount,
    total,
    recommended_action: "resume-daily"
  };
}

function jobStructuredError(item = {}) {
  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  const progress = meta.daily_progress && typeof meta.daily_progress === "object" ? meta.daily_progress : {};
  const error = progress.error && typeof progress.error === "object" ? progress.error : null;
  if (error?.type) return error;

  const message = String(item.message || "");
  if (
    (DAILY_JOB_TYPES.has(item.job_type) || item.job_type === "fetch-arxiv")
    && (message.includes("HTTP Error 429") || message.includes("Too Many Requests"))
  ) {
    return {
      type: ARXIV_RATE_LIMITED,
      title: "arXiv 暂时限流",
      message: "arXiv 请求被限流（HTTP 429），请稍后重试，或调大 arXiv 请求间隔秒数。",
      detail: "抓取 arXiv 时被限流，系统已重试但仍未成功。",
      suggested_action: "稍后重新执行每日流程，或在设置中调大 arXiv 请求间隔秒数。",
      technical_message: message,
      status_code: 429
    };
  }
  return null;
}

function arxivRateLimitedNotification(failed = {}) {
  const error = jobStructuredError(failed);
  if (!error || error.type !== ARXIV_RATE_LIMITED) return null;
  const progress = failed.meta?.daily_progress && typeof failed.meta.daily_progress === "object"
    ? failed.meta.daily_progress
    : {};
  const failedStep = String(progress.current_label || "抓取 arXiv");
  const retryAfter = safeInt(error.retry_after_seconds);
  const retryNote = retryAfter
    ? `arXiv 建议等待 ${retryAfter} 秒后再试。`
    : "建议稍后再试。";
  return notification(
    `arxiv-rate-limited-${failed.id}`,
    ARXIV_RATE_LIMITED,
    "warn",
    String(error.title || "arXiv 暂时限流"),
    `${failedStep} 时触发 arXiv 限流，系统已重试但仍失败。${retryNote}也可以在设置中调大 arXiv 请求间隔秒数。`,
    {
      createdAt: activityTime(failed),
      source: {
        job_id: failed.id,
        job_type: failed.job_type,
        error_type: ARXIV_RATE_LIMITED,
        failed_step: failedStep,
        retry_after_seconds: retryAfter,
        suggested_action: String(error.suggested_action || ""),
        technical_message: String(error.technical_message || failed.message || "")
      },
      requiresAction: true
    }
  );
}

async function readUpdateStatus() {
  const result = await query("SELECT value_json FROM app_settings WHERE key = $1", [UPDATE_STATUS_SETTING]);
  const row = result.rows?.[0];
  const parsed = row ? parseJson(row.value_json, {}) : {};
  const status = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  if (!Object.hasOwn(status, "available")) status.available = false;
  if (!Object.hasOwn(status, "current_version")) status.current_version = currentAppVersion();
  return status;
}

function currentAppVersion() {
  const override = envValue("KRIS_APP_VERSION", "").trim();
  if (override) return override.replace(/^v/, "");
  try {
    const data = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(data.version || "").trim().replace(/^v/, "");
  } catch {
    return "";
  }
}

function repository() {
  return envValue("KRIS_UPDATE_REPOSITORY", DEFAULT_REPOSITORY).trim().replace(/^\/+|\/+$/g, "") || DEFAULT_REPOSITORY;
}

function updateNotification(status = {}) {
  if (!status?.available) return null;
  const current = String(status.current_version || "当前版本");
  const latest = String(status.latest_version || status.latest_tag || "新版本");
  const tag = String(status.latest_tag || latest);
  const update = {
    current_version: current,
    latest_version: latest,
    latest_tag: tag,
    release_name: String(status.release_name || tag),
    release_notes: String(status.release_notes || ""),
    release_url: String(status.release_url || ""),
    published_at: String(status.published_at || ""),
    checked_at: String(status.checked_at || ""),
    repository: String(status.repository || repository()),
    source: String(status.source || "")
  };
  return {
    id: `app-update-${tag || latest}`,
    type: UPDATE_NOTIFICATION_TYPE,
    severity: "warn",
    title: "有新版本可用",
    detail: `当前 ${current}，最新 ${latest}。可以查看更新说明，或复制适合当前部署方式的更新命令。`,
    created_at: update.checked_at || update.published_at,
    source: { update },
    channels: ["list", "toast"],
    requires_action: true
  };
}

registerNotificationBuilder("daily_run_progress", "每日流程运行中的步骤进度", async (context) => {
  const runningDaily = context.activities.find(
    (item) => DAILY_JOB_TYPES.has(item.job_type) && item.status === "running"
  );
  const progress = runningDaily?.meta?.daily_progress;
  if (!runningDaily || !progress) return [];
  return [
    notification(
      "daily-run-progress",
      "daily_run_progress",
      "info",
      "每日流程运行中",
      String(progress.current_label || "准备中"),
      {
        createdAt: runningDaily.started_at,
        source: { job_id: runningDaily.id, job_type: runningDaily.job_type },
        progress
      }
    )
  ];
});

registerNotificationBuilder("daily_run_recoverable", "可恢复的失败每日流程", async (context) => {
  if (context.items.some((item) => item.type === "daily_run_progress")) return [];
  const recoverable = await recoverableDailyRun();
  if (!recoverable) return [];
  const recovery = dailyRecoveryPayload(recoverable);
  const count = recovery.total ? `${recovery.completed}/${recovery.total}` : `${recovery.completed} 步`;
  return [
    notification(
      `daily-run-recoverable-${recoverable.id}`,
      "daily_run_recoverable",
      "warn",
      "每日流程可继续",
      `上次流程失败在：${recovery.failed_label}，已完成 ${count}，建议继续上次流程。`,
      {
        createdAt: activityTime(recoverable),
        source: {
          job_id: recoverable.id,
          job_type: recoverable.job_type,
          recovery
        },
        requiresAction: true
      }
    )
  ];
});

registerNotificationBuilder("arxiv_rate_limited", "arXiv 限流导致任务失败", async (context) => {
  if (context.items.some((item) => item.type === "daily_run_progress" || item.type === "daily_run_recoverable")) {
    return [];
  }
  const failed = context.activities.find((item) => (
    item.status === "failed"
    && !context.activities.some((later) => (
      later.job_type === item.job_type
      && later.status === "completed"
      && later.id > item.id
    ))
  ));
  const built = arxivRateLimitedNotification(failed);
  return built ? [built] : [];
});

registerNotificationBuilder("job_running", "非每日流程任务运行中", async (context) => {
  if (context.items.some((item) => item.type === "daily_run_progress")) return [];
  const running = context.activities.find((item) => item.status === "running");
  if (!running) return [];
  return [
    notification(
      `job-running-${running.id}`,
      "job_running",
      "info",
      "任务运行中",
      jobTitle(running.job_type),
      {
        createdAt: running.started_at,
        source: { job_id: running.id, job_type: running.job_type }
      }
    )
  ];
});

registerNotificationBuilder("job_failed", "最近失败任务", async (context) => {
  if (context.items.some((item) => item.type === "daily_run_recoverable" || item.type === ARXIV_RATE_LIMITED)) {
    return [];
  }
  const failed = context.activities.find((item) => (
    item.status === "failed"
    && !context.activities.some((later) => (
      later.job_type === item.job_type
      && later.status === "completed"
      && later.id > item.id
    ))
  ));
  if (!failed) return [];
  return [
    notification(
      `job-failed-${failed.id}`,
      "job_failed",
      "bad",
      "任务失败",
      `${jobTitle(failed.job_type)} · ${failed.message || "未记录错误信息"}`,
      {
        createdAt: activityTime(failed),
        source: { job_id: failed.id, job_type: failed.job_type }
      }
    )
  ];
});

registerNotificationBuilder("daily_run_completed", "每日流程完成摘要", async (context) => {
  const completedDaily = completed(context.activities, (_meta, item) => DAILY_JOB_TYPES.has(item.job_type));
  if (!completedDaily) return [];
  const meta = completedDaily.meta || {};
  const parts = [];
  const newPapers = metaNumber(meta, ["arxiv_papers_inserted", "papers_inserted"]);
  const projectMatches = metaNumber(meta, ["project_paper_matches_created", "daily_report_project_matches"]);
  const paperReports = metaNumber(meta, ["paper_reports_done"]);
  const archived = metaNumber(meta, ["zero_match_papers_archived"]);
  const filtered = metaNumber(meta, ["project_judgments_filtered"]);
  if (newPapers) parts.push(`${newPapers} 篇新论文`);
  if (projectMatches) parts.push(`${projectMatches} 条项目候选`);
  if (paperReports) parts.push(`${paperReports} 篇全文报告`);
  if (archived) parts.push(`${archived} 篇 0 命中归档`);
  if (filtered) parts.push(`${filtered} 条项目判定筛掉`);
  if (meta.daily_report_path) parts.push(`日报 ${meta.daily_report_path}`);
  return [
    notification(
      `daily-run-completed-${completedDaily.id}`,
      "daily_run_completed",
      "ok",
      "每日流程已完成",
      parts.length ? parts.join("，") : completedDaily.message || "流程已完成",
      {
        createdAt: completedDaily.finished_at,
        source: { job_id: completedDaily.id, job_type: completedDaily.job_type }
      }
    )
  ];
});

registerNotificationBuilder("arxiv_papers_arrived", "新 arXiv 论文入库", async (context) => {
  const paperJob = completed(
    context.activities,
    (meta) => metaNumber(meta, ["arxiv_papers_inserted", "papers_inserted"]) > 0
  );
  if (!paperJob) return [];
  const count = metaNumber(paperJob.meta, ["arxiv_papers_inserted", "papers_inserted"]);
  return [
    notification(
      `arxiv-papers-arrived-${paperJob.id}`,
      "arxiv_papers_arrived",
      "info",
      "新论文到了",
      `${count} 篇新 arXiv 论文已入库`,
      {
        createdAt: paperJob.finished_at,
        source: { job_id: paperJob.id, job_type: paperJob.job_type }
      }
    )
  ];
});

registerNotificationBuilder("obsidian_sync_completed", "Obsidian 同步完成", async (context) => {
  const syncJob = completed(
    context.activities,
    (meta, item) => metaNumber(meta, ["sync_indexed", "indexed"]) > 0 || item.job_type === "sync-obsidian"
  );
  if (!syncJob) return [];
  const indexed = metaNumber(syncJob.meta, ["sync_indexed", "indexed"]);
  const chunks = metaNumber(syncJob.meta, ["sync_chunks_created", "chunks_created"]);
  return [
    notification(
      `obsidian-sync-completed-${syncJob.id}`,
      "obsidian_sync_completed",
      "ok",
      "Obsidian 已同步",
      indexed ? `${indexed} 篇笔记更新，${chunks} 个 chunk 入库` : "Obsidian 同步完成",
      {
        createdAt: syncJob.finished_at,
        source: { job_id: syncJob.id, job_type: syncJob.job_type }
      }
    )
  ];
});

registerNotificationBuilder("paper_text_cached", "PDF/TXT 缓存完成", async (context) => {
  const textJob = completed(
    context.activities,
    (meta) => metaNumber(meta, ["text_pdfs_downloaded", "pdfs_downloaded", "text_texts_extracted", "texts_extracted"]) > 0
  );
  if (!textJob) return [];
  const parts = [];
  const pdfCount = metaNumber(textJob.meta, ["text_pdfs_downloaded", "pdfs_downloaded"]);
  const textCount = metaNumber(textJob.meta, ["text_texts_extracted", "texts_extracted"]);
  const failedCount = metaNumber(textJob.meta, ["text_texts_failed", "texts_failed"]);
  if (pdfCount) parts.push(`${pdfCount} 个 PDF 已缓存`);
  if (textCount) parts.push(`${textCount} 篇已转 TXT`);
  if (failedCount) parts.push(`${failedCount} 篇失败`);
  return [
    notification(
      `paper-text-cached-${textJob.id}`,
      "paper_text_cached",
      "ok",
      "论文正文已缓存",
      parts.join("，"),
      {
        createdAt: textJob.finished_at,
        source: { job_id: textJob.id, job_type: textJob.job_type }
      }
    )
  ];
});

registerNotificationBuilder("paper_matching_completed", "论文匹配完成", async (context) => {
  const rankJob = completed(
    context.activities,
    (meta) => metaNumber(meta, ["matched_papers"]) > 0 || metaNumber(meta, ["project_paper_matches_created"]) > 0
  );
  if (!rankJob) return [];
  const count = metaNumber(rankJob.meta, ["matched_papers", "project_paper_matches_created"]);
  return [
    notification(
      `paper-matching-completed-${rankJob.id}`,
      "paper_matching_completed",
      "info",
      "论文匹配完成",
      `${count} 条匹配结果`,
      {
        createdAt: rankJob.finished_at,
        source: { job_id: rankJob.id, job_type: rankJob.job_type }
      }
    )
  ];
});

registerNotificationBuilder("paper_report_queue_processing", "全文报告队列处理中", async (context) => {
  const stats = context.paper_report_stats;
  if (!stats.processing) return [];
  return [
    notification(
      "paper-report-queue-processing",
      "paper_report_queue_processing",
      "info",
      "全文报告生成中",
      `${stats.processing} 篇处理中，${stats.queued} 篇排队中`
    )
  ];
});

registerNotificationBuilder("paper_report_queue_failed", "全文报告生成失败积压", async (context) => {
  const failed = context.paper_report_stats.failed || 0;
  if (!failed) return [];
  return [
    notification(
      "paper-report-queue-failed",
      "paper_report_queue_failed",
      "bad",
      "全文报告生成失败",
      `${failed} 篇报告失败，需要在报告队列中重试或检查 LLM/PDF/TXT 配置。`
    )
  ];
});

registerNotificationBuilder("paper_report_queue_backlog", "全文报告队列排队积压", async (context) => {
  const queued = context.paper_report_stats.queued || 0;
  if (!queued) return [];
  return [
    notification(
      "paper-report-queue-backlog",
      "paper_report_queue_backlog",
      "warn",
      "全文报告等待生成",
      `${queued} 篇论文正在排队，server 运行时会按配置并发自动生成。`
    )
  ];
});

registerNotificationBuilder("paper_report_completed", "最近全文报告生成完成", async (context) => {
  const reportJob = completed(
    context.activities,
    (meta, item) => item.job_type === "generate-paper-reports" && metaNumber(meta, ["paper_reports_done"]) > 0
  );
  if (!reportJob) return [];
  const count = metaNumber(reportJob.meta, ["paper_reports_done"]);
  return [
    notification(
      `paper-report-completed-${reportJob.id}`,
      "paper_report_completed",
      "ok",
      "全文报告已生成",
      `${count} 篇全文报告完成`,
      {
        createdAt: reportJob.finished_at,
        source: { job_id: reportJob.id, job_type: reportJob.job_type }
      }
    )
  ];
});

registerNotificationBuilder("experiment_report_arrived", "KRIS agent 实验报告到达", async (context) => {
  return context.experiment_reports.map((report) => {
    const projectId = report.project_id;
    const sourceAgent = report.source_agent || "unknown";
    const updatedAt = report.updated_at || "";
    const detailParts = [String(report.title || "未命名实验报告")];
    if (projectId) detailParts.push(`项目 ${projectId}`);
    if (sourceAgent) detailParts.push(`来源 ${sourceAgent}`);
    if (updatedAt) detailParts.push(`更新于 ${updatedAt}`);
    return notification(
      `experiment-report-arrived-${report.id}`,
      "experiment_report_arrived",
      "info",
      "收到实验报告",
      detailParts.join(" · "),
      {
        createdAt: updatedAt,
        source: {
          artifact_id: report.id,
          project_id: projectId,
          source_agent: sourceAgent
        },
        channels: ["list"]
      }
    );
  });
});

registerNotificationBuilder("app_update_available", "应用新版本可用", async (context) => {
  const built = updateNotification(context.app_update_status || {});
  return built ? [built] : [];
});

export async function getNotifications(limit = 5) {
  const normalizedLimit = normalizeNotificationLimit(limit, 5);
  const context = {
    activities: await activityRows(20),
    paper_report_stats: await paperReportStats(),
    experiment_reports: await experimentReportRows(Math.min(normalizedLimit, 10)),
    app_update_status: await readUpdateStatus(),
    items: []
  };
  for (const entry of notificationBuilders) {
    const built = await entry.builder(context);
    context.items.push(...built);
  }
  let items = context.items.sort(compareNotificationsDesc).slice(0, normalizedLimit);
  if (!items.length) {
    items = [
      notification(
        "empty",
        "empty",
        "neutral",
        "暂无通知",
        "没有新的任务完成、论文到达或实验同步事件。"
      )
    ];
  }
  return {
    items,
    registered_builders: registeredNotificationBuilders()
  };
}
