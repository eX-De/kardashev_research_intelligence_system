import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  dailyStepLabel,
  formatApiError,
  formatNotification
} from "../../src/lib/systemMessages.js";

function catalog(locale, namespace) {
  return JSON.parse(
    readFileSync(new URL(`../../src/locales/${locale}/${namespace}.json`, import.meta.url), "utf8")
  );
}

function lookup(object, path) {
  return String(path || "").split(".").reduce((value, key) => value?.[key], object);
}

function translator(locale, defaultNamespace = "system") {
  const catalogs = new Map();
  return (rawKey, values = {}) => {
    const [namespace, key] = String(rawKey).includes(":")
      ? String(rawKey).split(/:(.+)/)
      : [values.ns || defaultNamespace, rawKey];
    if (!catalogs.has(namespace)) catalogs.set(namespace, catalog(locale, namespace));
    const resource = catalogs.get(namespace);
    const count = Number(values.count);
    const pluralKey = Number.isFinite(count)
      ? `${key}_${locale === "en" && count === 1 ? "one" : "other"}`
      : "";
    const template = (pluralKey && lookup(resource, pluralKey))
      || lookup(resource, key)
      || values.defaultValue
      || "";
    return String(template).replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ""));
  };
}

function flattenedKeys(value, prefix = "", keys = []) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenedKeys(child, path, keys);
    } else {
      keys.push(path.replace(/_(one|other)$/, ""));
    }
  }
  return keys;
}

test("Chinese and English catalogs expose the same namespaces and translation keys", () => {
  const localeRoot = new URL("../../src/locales/", import.meta.url);
  const namespaces = (locale) => readdirSync(new URL(`${locale}/`, localeRoot))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const zhNamespaces = namespaces("zh-CN");
  const enNamespaces = namespaces("en");

  assert.deepEqual(enNamespaces, zhNamespaces);
  for (const filename of zhNamespaces) {
    const namespace = filename.replace(/\.json$/, "");
    const zhKeys = [...new Set(flattenedKeys(catalog("zh-CN", namespace)))].sort();
    const enKeys = [...new Set(flattenedKeys(catalog("en", namespace)))].sort();
    assert.deepEqual(enKeys, zhKeys, `locale key mismatch in ${namespace}`);
  }
});

test("semantic daily completion notifications render from the active locale", () => {
  const notification = {
    type: "daily_run_completed",
    data: {
      new_papers: 2,
      project_matches: 1,
      paper_reports: 0,
      archived: 0,
      filtered: 0,
      daily_report_path: ""
    }
  };

  assert.deepEqual(formatNotification(notification, translator("zh-CN")), {
    title: "每日流程已完成",
    detail: "2 篇新论文；1 条项目候选"
  });
  assert.deepEqual(formatNotification(notification, translator("en")), {
    title: "Daily run completed",
    detail: "2 new papers; 1 project candidate"
  });
});

test("daily progress uses its stable step key and keeps unknown labels as fallback", () => {
  const t = translator("en");
  assert.equal(dailyStepLabel("cache_text", "缓存 PDF/TXT", t), "Cache PDF/TXT");
  assert.equal(dailyStepLabel("third_party_stage", "Custom stage", t), "Custom stage");

  const rendered = formatNotification({
    type: "daily_run_progress",
    data: {
      current_key: "judge_project_papers",
      current_label: "项目级判定"
    }
  }, t);
  assert.equal(rendered.detail, "Project-level evaluation");
});

test("experiment SSE notifications use semantic data instead of their fallback sentence", () => {
  const rendered = formatNotification({
    type: "experiment_report_arrived",
    title: "收到实验报告",
    detail: "旧的中文 fallback",
    data: {
      project_id: 7,
      source_agent: "codex",
      title: "Run 42",
      updated_at: ""
    }
  }, translator("en"));

  assert.equal(rendered.title, "Experiment report received");
  assert.equal(rendered.detail, "Run 42 · Project 7 · Source codex");
});

test("known API error codes translate while unknown errors preserve diagnostics", () => {
  const t = translator("zh-CN");
  assert.equal(formatApiError({ code: "invalid_password", message: "Invalid password" }, t), "密码验证失败。");
  assert.match(formatApiError({ code: "worker_unavailable", message: "offline" }, t), /连接与服务/);
  assert.equal(formatApiError({ code: "database_timeout", message: "connection timed out" }, t), "connection timed out");
});

test("every semantic system notification type has a complete English rendering", () => {
  const examples = [
    { type: "empty", data: {} },
    { type: "daily_run_progress", data: { current_key: "fetch_arxiv" } },
    { type: "daily_run_recoverable", data: { completed: 2, failed_step: "cache_text", total: 5 } },
    { type: "arxiv_rate_limited", data: { failed_step: "fetch_arxiv", retry_after_seconds: 30 } },
    { type: "job_running", data: { job_type: "sync-obsidian" } },
    { type: "job_failed", data: { job_type: "rank-papers", message: "timeout" } },
    { type: "daily_run_completed", data: { new_papers: 1 } },
    { type: "arxiv_papers_arrived", data: { count: 2 } },
    { type: "obsidian_sync_completed", data: { chunks: 3, indexed: 1 } },
    { type: "paper_text_cached", data: { pdf_count: 1, text_count: 1 } },
    { type: "paper_matching_completed", data: { count: 4 } },
    { type: "paper_report_queue_processing", data: { processing: 1, queued: 2 } },
    { type: "paper_report_queue_failed", data: { failed: 1 } },
    { type: "paper_report_queue_backlog", data: { queued: 3 } },
    { type: "paper_report_completed", data: { count: 1 } },
    { type: "reader_import_completed", data: { import_type: "url", imported_count: 1, error_count: 0 } },
    { type: "reader_import_failed", data: { import_type: "upload", error_message: "Invalid PDF" } },
    { type: "worker_unavailable", data: { queued: 1, running: 0 } },
    { type: "experiment_report_arrived", data: { project_id: 7, source_agent: "codex", title: "Run 42" } },
    { type: "app_update_available", data: { current_version: "1.0.0", latest_version: "1.1.0" } }
  ];
  const t = translator("en");

  for (const notification of examples) {
    const rendered = formatNotification(notification, t);
    assert.ok(rendered.title.trim(), `${notification.type} title`);
    assert.ok(rendered.detail.trim(), `${notification.type} detail`);
    assert.doesNotMatch(`${rendered.title} ${rendered.detail}`, /\p{Script=Han}/u, notification.type);
  }
});
