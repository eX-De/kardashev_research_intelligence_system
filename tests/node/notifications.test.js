import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, toJson, ValidationError } from "../../server/db.js";
import {
  getNotifications,
  normalizeNotificationLimit,
  registeredNotificationBuilders
} from "../../server/notifications.js";

function createNotificationsPool({
  activities = [],
  paperStats = {},
  experimentReports = [],
  updateStatus = null,
  latestCompletedDailyId = "0",
  recoverableDaily = null
} = {}) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({ sql: String(sql), params });
        const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        if (normalized.includes("JOIN DAILY_RUN_META")) {
          return { rows: recoverableDaily ? [recoverableDaily] : [] };
        }
        if (normalized.includes("SELECT COALESCE(MAX(ID), 0) AS ID FROM JOB_RUNS")) {
          return { rows: [{ id: latestCompletedDailyId }] };
        }
        if (normalized.includes("FROM JOB_RUNS") && normalized.includes("META_JSON") && normalized.includes("ORDER BY ID DESC")) {
          return { rows: activities.slice(0, Number(params[0] || 0)) };
        }
        if (normalized.includes("FROM ARTIFACTS") && normalized.includes("ARTIFACT_TYPE = 'PAPER_REPORT'")) {
          return {
            rows: Object.entries(paperStats)
              .filter(([, count]) => Number(count) > 0)
              .map(([status, count]) => ({ status, count: String(count) }))
          };
        }
        if (normalized.includes("FROM ARTIFACTS") && normalized.includes("ARTIFACT_TYPE = 'EXPERIMENT_REPORT'")) {
          return { rows: experimentReports.slice(0, Number(params[0] || 0)) };
        }
        if (normalized === "SELECT VALUE_JSON FROM APP_SETTINGS WHERE KEY = $1") {
          return { rows: updateStatus ? [{ value_json: toJson(updateStatus) }] : [] };
        }
        throw new Error(`Unexpected SQL in notifications test: ${sql}`);
      }
    }
  };
}

async function withNotificationsPool(options, fn) {
  const fake = createNotificationsPool(options);
  setPoolForTesting(fake.pool);
  try {
    return await fn(fake);
  } finally {
    setPoolForTesting(null);
  }
}

test("getNotifications returns Python-compatible empty fallback and registry", async () => {
  await withNotificationsPool({}, async () => {
    const result = await getNotifications(5);
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], {
      id: "empty",
      type: "empty",
      severity: "neutral",
      title: "暂无通知",
      detail: "没有新的任务完成、论文到达或实验同步事件。",
      created_at: null,
      source: {},
      channels: ["list"],
      requires_action: false
    });
    assert.equal(result.registered_builders[0].type, "daily_run_progress");
    assert.equal(result.registered_builders.at(-1).type, "app_update_available");
    assert.deepEqual(result.registered_builders, registeredNotificationBuilders());
  });
});

test("running daily progress is surfaced and suppresses generic running job", async () => {
  const progress = {
    status: "running",
    total: 3,
    current: 2,
    completed: 1,
    current_key: "fetch_arxiv",
    current_label: "抓取 arXiv",
    steps: [
      { key: "sync_context_sources", label: "同步上下文来源", status: "completed" },
      { key: "fetch_arxiv", label: "抓取 arXiv", status: "running" }
    ]
  };
  await withNotificationsPool({
    activities: [
      {
        id: "9",
        job_type: "run-daily",
        status: "running",
        started_at: "2026-06-06T01:00:00+00:00",
        finished_at: null,
        message: "Daily run 2/3",
        meta_json: toJson({ daily_progress: progress })
      }
    ]
  }, async () => {
    const result = await getNotifications(5);
    const itemTypes = result.items.map((item) => item.type);
    assert.equal(result.items[0].type, "daily_run_progress");
    assert.deepEqual(result.items[0].progress, progress);
    assert.deepEqual(result.items[0].source, { job_id: 9, job_type: "run-daily" });
    assert.equal(itemTypes.includes("job_running"), false);
  });
});

test("arXiv rate limit failure is actionable and suppresses generic failure", async () => {
  await withNotificationsPool({
    activities: [
      {
        id: "10",
        job_type: "fetch-arxiv",
        status: "failed",
        started_at: "2026-06-06T02:00:00+00:00",
        finished_at: "2026-06-06T02:03:00+00:00",
        message: "HTTP Error 429: Too Many Requests",
        meta_json: "{}"
      }
    ]
  }, async () => {
    const result = await getNotifications(5);
    const itemTypes = result.items.map((item) => item.type);
    const rateLimited = result.items[0];
    assert.equal(rateLimited.type, "arxiv_rate_limited");
    assert.equal(rateLimited.severity, "warn");
    assert.equal(rateLimited.requires_action, true);
    assert.equal(rateLimited.source.error_type, "arxiv_rate_limited");
    assert.match(rateLimited.source.technical_message, /HTTP Error 429/);
    assert.equal(itemTypes.includes("job_failed"), false);
  });
});

test("update availability is built from app_settings status", async () => {
  await withNotificationsPool({
    updateStatus: {
      ok: true,
      available: true,
      current_version: "0.2.3",
      latest_version: "0.2.4",
      latest_tag: "v0.2.4",
      release_name: "v0.2.4",
      release_notes: "Release notes",
      release_url: "https://example.test/release",
      published_at: "2026-06-06T02:00:00+00:00",
      checked_at: "2026-06-06T03:00:00+00:00",
      repository: "owner/repo",
      source: "github_release"
    }
  }, async () => {
    const result = await getNotifications(5);
    const update = result.items[0];
    assert.equal(update.type, "app_update_available");
    assert.deepEqual(update.channels, ["list", "toast"]);
    assert.equal(update.requires_action, true);
    assert.equal(update.created_at, "2026-06-06T03:00:00+00:00");
    assert.equal(update.source.update.latest_tag, "v0.2.4");
    assert.equal(update.source.update.release_url, "https://example.test/release");
  });
});

test("paper report queue stats create processing, failed, and backlog notifications", async () => {
  await withNotificationsPool({
    paperStats: {
      processing: 1,
      failed: 2,
      queued: 3
    }
  }, async () => {
    const result = await getNotifications(10);
    const itemTypes = new Set(result.items.map((item) => item.type));
    assert.equal(itemTypes.has("paper_report_queue_processing"), true);
    assert.equal(itemTypes.has("paper_report_queue_failed"), true);
    assert.equal(itemTypes.has("paper_report_queue_backlog"), true);
  });
});

test("recoverable daily run is recommended ahead of generic failure", async () => {
  await withNotificationsPool({
    activities: [
      {
        id: "14",
        job_type: "run-daily",
        status: "failed",
        started_at: "2026-05-26T04:24:26+00:00",
        finished_at: "2026-05-26T05:15:25+00:00",
        message: "LLM daily report generation failed",
        meta_json: "{}"
      }
    ],
    recoverableDaily: {
      id: "14",
      job_type: "run-daily",
      status: "failed",
      started_at: "2026-05-26T04:24:26+00:00",
      finished_at: "2026-05-26T05:15:25+00:00",
      message: "LLM daily report generation failed",
      meta_json: toJson({
        daily_progress: {
          completed: 10,
          current: 11,
          current_key: "generate_daily_report_artifact",
          current_label: "生成日报产物",
          status: "failed",
          total: 11,
          steps: [
            { key: "sync_context_sources", label: "同步上下文来源", status: "completed" },
            { key: "generate_daily_report_artifact", label: "生成日报产物", status: "failed" }
          ]
        }
      }),
      mode: "run-daily",
      source_job_id: null,
      arxiv_batch_id: null
    }
  }, async () => {
    const result = await getNotifications(5);
    const itemTypes = result.items.map((item) => item.type);
    const recovery = result.items.find((item) => item.type === "daily_run_recoverable");
    assert.equal(itemTypes[0], "daily_run_recoverable");
    assert.equal(itemTypes.includes("job_failed"), false);
    assert.equal(recovery.requires_action, true);
    assert.equal(recovery.source.recovery.recommended_action, "resume-daily");
    assert.equal(recovery.source.recovery.failed_label, "生成日报产物");
  });
});

test("recent experiment reports include artifact project and source metadata", async () => {
  await withNotificationsPool({
    experimentReports: [
      {
        id: "21",
        scope_id: "7",
        title: "KRIS run 42",
        source_json: toJson({ source: "kris-agent", source_agent: "codex", project_id: 7 }),
        updated_at: "2026-06-07T09:00:00+00:00"
      }
    ]
  }, async () => {
    const result = await getNotifications(10);
    const report = result.items.find((item) => item.type === "experiment_report_arrived");
    assert.equal(report.title, "收到实验报告");
    assert.deepEqual(report.channels, ["list"]);
    assert.equal(report.source.artifact_id, 21);
    assert.equal(report.source.project_id, 7);
    assert.equal(report.source.source_agent, "codex");
  });
});

test("normalizeNotificationLimit validates route limits while preserving Python minimum one", () => {
  assert.equal(normalizeNotificationLimit(null, 5), 5);
  assert.equal(normalizeNotificationLimit("", 5), 5);
  assert.equal(normalizeNotificationLimit("0", 5), 1);
  assert.equal(normalizeNotificationLimit("-1", 5), 1);
  assert.equal(normalizeNotificationLimit("12", 5), 12);
  assert.throws(() => normalizeNotificationLimit("abc", 5), ValidationError);
});
