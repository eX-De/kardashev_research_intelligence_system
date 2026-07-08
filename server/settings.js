import { homedir } from "node:os";

import { envBoolean, envValue } from "./env.js";
import { parseJson, query, toJson, ValidationError, withTransaction } from "./db.js";

export const DEFAULT_PAPER_READER_PROMPT = `请阅读这篇论文 PDF，输出结构化解读：

1. 研究问题和背景
2. 方法和实验设计
3. 主要发现
4. 局限性
5. 对后续研究或应用的启发

请尽量使用中文，保留关键英文术语。`;

export const CSV_FIELDS = new Set([
  "obsidian_include_dirs",
  "obsidian_include_tags",
  "obsidian_project_center_tags",
  "arxiv_categories",
  "rag_searchers"
]);

export const PATH_FIELDS = new Set([
  "obsidian_vault_path",
  "obsidian_remote_mirror_dir",
  "arxiv_pdf_dir",
  "arxiv_text_dir"
]);

export const INT_FIELDS = new Set([
  "arxiv_daily_lookback_days",
  "arxiv_max_results",
  "retry_daily_max_results",
  "rag_top_k",
  "rag_prefilter_top_k",
  "rag_prefilter_min_keep",
  "rag_prefilter_max_keep",
  "scheduler_interval_hours",
  "paper_report_queue_concurrency",
  "embedding_concurrency"
]);

export const FLOAT_FIELDS = new Set([
  "arxiv_request_interval_seconds",
  "rag_score_threshold",
  "rag_prefilter_threshold"
]);

export const STRING_FIELDS = new Set([
  "obsidian_vault_path",
  "obsidian_storage_backend",
  "obsidian_remote_endpoint_url",
  "obsidian_remote_region",
  "obsidian_remote_bucket",
  "obsidian_remote_prefix",
  "obsidian_remote_access_key_id",
  "obsidian_remote_secret_access_key",
  "obsidian_remote_mirror_dir",
  "obsidian_remote_output_prefix",
  "obsidian_cli_command",
  "obsidian_paper_repository_dir",
  "obsidian_paper_attachment_dir",
  "obsidian_project_paper_list_name",
  "arxiv_pdf_dir",
  "arxiv_text_dir",
  "llm_chat_provider_id",
  "llm_chat_model",
  "llm_embedding_provider_id",
  "llm_embedding_model",
  "paper_reader_default_prompt",
  "paper_report_provider_id",
  "paper_report_model",
  "reader_chat_provider_id",
  "reader_chat_model",
  "reader_smart_save_provider_id",
  "reader_smart_save_model",
  "reader_question_provider_id",
  "reader_question_model",
  "scheduler_run_time",
  "onboarding_project_source"
]);

export const BOOL_FIELDS = new Set([
  "scheduler_enabled",
  "run_daily_on_startup_enabled",
  "arxiv_cache_full_text",
  "rag_prefilter_enabled",
  "onboarding_completed",
  "obsidian_remote_append_only"
]);

export const JSON_FIELDS = new Set(["llm_providers"]);
export const SECRET_FIELDS = new Set(["obsidian_remote_secret_access_key"]);
export const SECRET_CLEAR_FLAGS = Object.freeze({
  clear_obsidian_remote_secret_access_key: "obsidian_remote_secret_access_key"
});

const TAG_FIELDS = new Set(["obsidian_include_tags", "obsidian_project_center_tags"]);
const ALLOWED_FIELDS = new Set([
  ...CSV_FIELDS,
  ...INT_FIELDS,
  ...FLOAT_FIELDS,
  ...STRING_FIELDS,
  ...BOOL_FIELDS,
  ...JSON_FIELDS
]);
const DATACLASS_SETTING_FIELDS = new Set([
  "obsidian_vault_path",
  "obsidian_include_dirs",
  "obsidian_include_tags",
  "obsidian_project_center_tags",
  "obsidian_cli_command",
  "obsidian_paper_repository_dir",
  "obsidian_paper_attachment_dir",
  "obsidian_project_paper_list_name",
  "arxiv_categories",
  "arxiv_daily_lookback_days",
  "arxiv_max_results",
  "arxiv_request_interval_seconds",
  "arxiv_cache_full_text",
  "arxiv_pdf_dir",
  "arxiv_text_dir",
  "retry_daily_max_results",
  "rag_score_threshold",
  "rag_top_k",
  "rag_searchers",
  "rag_prefilter_enabled",
  "rag_prefilter_threshold",
  "rag_prefilter_top_k",
  "rag_prefilter_min_keep",
  "rag_prefilter_max_keep",
  "llm_providers",
  "llm_chat_provider_id",
  "llm_chat_model",
  "llm_embedding_provider_id",
  "llm_embedding_model",
  "obsidian_storage_backend",
  "obsidian_remote_endpoint_url",
  "obsidian_remote_region",
  "obsidian_remote_bucket",
  "obsidian_remote_prefix",
  "obsidian_remote_access_key_id",
  "obsidian_remote_secret_access_key",
  "obsidian_remote_mirror_dir",
  "obsidian_remote_output_prefix",
  "obsidian_remote_append_only",
  "embedding_concurrency",
  "paper_reader_default_prompt",
  "paper_report_provider_id",
  "paper_report_model",
  "reader_chat_provider_id",
  "reader_chat_model",
  "reader_smart_save_provider_id",
  "reader_smart_save_model",
  "reader_question_provider_id",
  "reader_question_model"
]);

function settingType(key) {
  if (CSV_FIELDS.has(key)) return "csv";
  if (INT_FIELDS.has(key)) return "int";
  if (FLOAT_FIELDS.has(key)) return "float";
  if (BOOL_FIELDS.has(key)) return "bool";
  if (JSON_FIELDS.has(key)) return "json";
  return "string";
}

export const SETTING_SCHEMA = Object.freeze(Object.fromEntries(
  [...ALLOWED_FIELDS].sort().map((key) => [key, Object.freeze({
    key,
    type: settingType(key),
    default_source: "environment_or_builtin",
    secret: SECRET_FIELDS.has(key),
    worker_visible: DATACLASS_SETTING_FIELDS.has(key)
  })])
));

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function storedOr(stored, key, fallback) {
  return hasOwn(stored, key) ? stored[key] : fallback;
}

function pythonOr(value, fallback) {
  return value ? value : fallback;
}

function csvValue(value, { tags = false } = {}) {
  const raw = Array.isArray(value) ? value.map((item) => String(item)) : String(value || "").split(",");
  const items = raw.map((item) => item.trim()).filter(Boolean);
  return tags ? items.map((item) => item.replace(/^#+/, "").toLowerCase()) : items;
}

function boolValue(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on", "enabled"].includes(String(value).trim().toLowerCase());
}

function stringOrEmpty(value) {
  return value ? String(value).trim() : "";
}

function parseInteger(value, field) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} must be an integer`);
    return Math.trunc(value);
  }
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new ValidationError(`${field} must be an integer`);
  return Number.parseInt(text, 10);
}

function parseFloatValue(value, field) {
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ValidationError(`${field} must be a number`);
  return parsed;
}

function integerOrDefault(value, defaultValue, field) {
  return parseInteger(pythonOr(value, defaultValue), field);
}

function positiveInteger(value, defaultValue, field) {
  const source = value === null || value === undefined || String(value).trim() === "" ? defaultValue : value;
  const parsed = parseInteger(source, field);
  if (parsed < 1) throw new ValidationError(`${field} must be at least 1`);
  return parsed;
}

function envInteger(name, defaultValue) {
  return parseInteger(envValue(name, String(defaultValue)), name);
}

function envFloat(name, defaultValue) {
  return parseFloatValue(envValue(name, String(defaultValue)), name);
}

function slashPath(value, fallback = "") {
  const text = stringOrEmpty(value) || fallback;
  const normalized = text.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return normalized || fallback;
}

function expandUserPath(value, { trim = true } = {}) {
  const text = trim ? stringOrEmpty(value) : String(value || "");
  if (!text) return "";
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return `${homedir()}${text.slice(1)}`;
  }
  return text;
}

export function normalizeProviderBaseUrl(value) {
  let baseUrl = String(value || "").trim().replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/embeddings"]) {
    if (baseUrl.endsWith(suffix)) {
      baseUrl = baseUrl.slice(0, -suffix.length);
    }
  }
  return baseUrl.replace(/\/+$/, "");
}

function providerToPayload(provider) {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    api_key_configured: Boolean(provider.api_key),
    chat_models: provider.chat_models,
    embedding_models: provider.embedding_models
  };
}

function providerToStore(provider) {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    api_key: provider.api_key,
    chat_models: provider.chat_models,
    embedding_models: provider.embedding_models
  };
}

export function providersFromValue(value, existing = new Map()) {
  const providers = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object") continue;
    const providerId = String(item.id || "").trim();
    if (!providerId) continue;
    const previous = existing.get(providerId);
    let apiKey = String(item.api_key || "");
    if (item.clear_api_key) {
      apiKey = "";
    } else if (!apiKey && previous) {
      apiKey = previous.api_key;
    }
    providers.push({
      id: providerId,
      name: stringOrEmpty(item.name) || providerId,
      base_url: normalizeProviderBaseUrl(item.base_url),
      api_key: apiKey,
      chat_models: csvValue(item.chat_models || []),
      embedding_models: csvValue(item.embedding_models || [])
    });
  }
  return providers;
}

function providersFromEnv() {
  const raw = envValue("LLM_PROVIDERS_JSON", "").trim();
  if (!raw) return [];
  try {
    return providersFromValue(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function loadBaseSettingsFromEnv() {
  const vault = envValue("OBSIDIAN_VAULT_PATH", "").trim();
  return {
    obsidian_vault_path: vault ? expandUserPath(vault) : "",
    obsidian_include_dirs: csvValue(envValue("OBSIDIAN_INCLUDE_DIRS", "Research,Papers")),
    obsidian_include_tags: csvValue(envValue("OBSIDIAN_INCLUDE_TAGS", "research,paper,direction"), { tags: true }),
    obsidian_project_center_tags: csvValue(envValue("OBSIDIAN_PROJECT_CENTER_TAGS", ""), { tags: true }),
    obsidian_cli_command: envValue("OBSIDIAN_CLI_COMMAND", "obsidian").trim() || "obsidian",
    obsidian_paper_repository_dir: slashPath(
      envValue("OBSIDIAN_PAPER_REPOSITORY_DIR", "人工智能/论文仓库")
    ),
    obsidian_paper_attachment_dir: slashPath(
      envValue("OBSIDIAN_PAPER_ATTACHMENT_DIR", "人工智能/论文仓库/附件")
    ),
    obsidian_project_paper_list_name: envValue("OBSIDIAN_PROJECT_PAPER_LIST_NAME", "论文列表.md").trim() || "论文列表.md",
    arxiv_categories: csvValue(envValue("ARXIV_CATEGORIES", "cs.AI,cs.CL,cs.IR")),
    arxiv_daily_lookback_days: envInteger("ARXIV_DAILY_LOOKBACK_DAYS", 1),
    arxiv_max_results: envInteger("ARXIV_MAX_RESULTS", 50),
    arxiv_request_interval_seconds: envFloat("ARXIV_REQUEST_INTERVAL_SECONDS", 3),
    arxiv_cache_full_text: envBoolean("ARXIV_CACHE_FULL_TEXT", true),
    arxiv_pdf_dir: String(envValue("ARXIV_PDF_DIR", "./data/arxiv_pdfs")),
    arxiv_text_dir: String(envValue("ARXIV_TEXT_DIR", "./data/arxiv_text")),
    retry_daily_max_results: envInteger("RETRY_DAILY_MAX_RESULTS", 100),
    rag_score_threshold: envFloat("RAG_SCORE_THRESHOLD", 0.35),
    rag_top_k: envInteger("RAG_TOP_K", 6),
    rag_searchers: csvValue(envValue("RAG_SEARCHERS", "embedding_search,keyword_search,front_page_search")),
    rag_prefilter_enabled: envBoolean("RAG_PREFILTER_ENABLED", true),
    rag_prefilter_threshold: envFloat("RAG_PREFILTER_THRESHOLD", 0.18),
    rag_prefilter_top_k: envInteger("RAG_PREFILTER_TOP_K", 20),
    rag_prefilter_min_keep: envInteger("RAG_PREFILTER_MIN_KEEP", 30),
    rag_prefilter_max_keep: envInteger("RAG_PREFILTER_MAX_KEEP", 50),
    llm_providers: providersFromEnv(),
    llm_chat_provider_id: envValue("LLM_CHAT_PROVIDER_ID", ""),
    llm_chat_model: envValue("LLM_CHAT_MODEL", ""),
    llm_embedding_provider_id: envValue("LLM_EMBEDDING_PROVIDER_ID", ""),
    llm_embedding_model: envValue("LLM_EMBEDDING_MODEL", ""),
    obsidian_storage_backend: envValue("OBSIDIAN_STORAGE_BACKEND", "local").trim().toLowerCase() || "local",
    obsidian_remote_endpoint_url: envValue("OBSIDIAN_REMOTE_ENDPOINT_URL", "").trim(),
    obsidian_remote_region: envValue("OBSIDIAN_REMOTE_REGION", "").trim(),
    obsidian_remote_bucket: envValue("OBSIDIAN_REMOTE_BUCKET", "").trim(),
    obsidian_remote_prefix: slashPath(envValue("OBSIDIAN_REMOTE_PREFIX", "")),
    obsidian_remote_access_key_id: envValue("OBSIDIAN_REMOTE_ACCESS_KEY_ID", "").trim(),
    obsidian_remote_secret_access_key: envValue("OBSIDIAN_REMOTE_SECRET_ACCESS_KEY", "").trim(),
    obsidian_remote_mirror_dir: expandUserPath(envValue("OBSIDIAN_REMOTE_MIRROR_DIR", "./data/obsidian_remote_vault")),
    obsidian_remote_output_prefix: slashPath(
      envValue("OBSIDIAN_REMOTE_OUTPUT_PREFIX", "Research Intelligence"),
      "Research Intelligence"
    ),
    obsidian_remote_append_only: envBoolean("OBSIDIAN_REMOTE_APPEND_ONLY", true),
    embedding_concurrency: positiveInteger(envValue("EMBEDDING_CONCURRENCY", "2"), 2, "embedding_concurrency"),
    paper_reader_default_prompt: envValue("PAPER_READER_DEFAULT_PROMPT", ""),
    paper_report_provider_id: envValue("PAPER_REPORT_PROVIDER_ID", ""),
    paper_report_model: envValue("PAPER_REPORT_MODEL", ""),
    reader_chat_provider_id: envValue("READER_CHAT_PROVIDER_ID", ""),
    reader_chat_model: envValue("READER_CHAT_MODEL", ""),
    reader_smart_save_provider_id: envValue("READER_SMART_SAVE_PROVIDER_ID", ""),
    reader_smart_save_model: envValue("READER_SMART_SAVE_MODEL", ""),
    reader_question_provider_id: envValue("READER_QUESTION_PROVIDER_ID", ""),
    reader_question_model: envValue("READER_QUESTION_MODEL", "")
  };
}

export function applyStoredSettings(stored, baseSettings = loadBaseSettingsFromEnv()) {
  const settings = { ...baseSettings };
  if (hasOwn(stored, "obsidian_vault_path")) {
    settings.obsidian_vault_path = expandUserPath(stored.obsidian_vault_path);
  }
  if (hasOwn(stored, "arxiv_pdf_dir")) {
    settings.arxiv_pdf_dir = expandUserPath(stored.arxiv_pdf_dir || "./data/arxiv_pdfs");
  }
  if (hasOwn(stored, "arxiv_text_dir")) {
    settings.arxiv_text_dir = expandUserPath(stored.arxiv_text_dir || "./data/arxiv_text");
  }
  if (hasOwn(stored, "obsidian_remote_mirror_dir")) {
    settings.obsidian_remote_mirror_dir = expandUserPath(
      stored.obsidian_remote_mirror_dir || "./data/obsidian_remote_vault"
    );
  }
  for (const field of CSV_FIELDS) {
    if (hasOwn(stored, field)) {
      settings[field] = csvValue(stored[field], { tags: TAG_FIELDS.has(field) });
    }
  }
  if (hasOwn(stored, "llm_providers")) {
    settings.llm_providers = providersFromValue(stored.llm_providers);
  }
  for (const field of INT_FIELDS) {
    if (hasOwn(stored, field) && DATACLASS_SETTING_FIELDS.has(field)) {
      settings[field] = field === "embedding_concurrency"
        ? positiveInteger(stored[field], settings.embedding_concurrency || 2, field)
        : parseInteger(stored[field], field);
    }
  }
  for (const field of FLOAT_FIELDS) {
    if (hasOwn(stored, field)) settings[field] = parseFloatValue(stored[field], field);
  }
  for (const field of BOOL_FIELDS) {
    if (hasOwn(stored, field) && DATACLASS_SETTING_FIELDS.has(field)) {
      settings[field] = boolValue(stored[field]);
    }
  }
  for (const field of STRING_FIELDS) {
    if (!PATH_FIELDS.has(field) && hasOwn(stored, field) && DATACLASS_SETTING_FIELDS.has(field)) {
      settings[field] = String(stored[field]);
    }
  }
  return settings;
}

export function settingsPayloadFromStored(stored = {}) {
  const settings = applyStoredSettings(stored);
  return {
    obsidian_vault_path: String(settings.obsidian_vault_path || ""),
    obsidian_storage_backend: settings.obsidian_storage_backend,
    obsidian_remote_endpoint_url: settings.obsidian_remote_endpoint_url,
    obsidian_remote_region: settings.obsidian_remote_region,
    obsidian_remote_bucket: settings.obsidian_remote_bucket,
    obsidian_remote_prefix: settings.obsidian_remote_prefix,
    obsidian_remote_access_key_id: settings.obsidian_remote_access_key_id,
    obsidian_remote_secret_access_key: "",
    obsidian_remote_secret_access_key_configured: Boolean(settings.obsidian_remote_secret_access_key),
    obsidian_remote_mirror_dir: String(settings.obsidian_remote_mirror_dir),
    obsidian_remote_output_prefix: settings.obsidian_remote_output_prefix,
    obsidian_remote_append_only: true,
    obsidian_include_dirs: settings.obsidian_include_dirs,
    obsidian_include_tags: settings.obsidian_include_tags,
    obsidian_project_center_tags: settings.obsidian_project_center_tags,
    obsidian_cli_command: settings.obsidian_cli_command,
    obsidian_paper_repository_dir: settings.obsidian_paper_repository_dir,
    obsidian_paper_attachment_dir: settings.obsidian_paper_attachment_dir,
    obsidian_project_paper_list_name: settings.obsidian_project_paper_list_name,
    arxiv_categories: settings.arxiv_categories,
    arxiv_daily_lookback_days: settings.arxiv_daily_lookback_days,
    arxiv_max_results: settings.arxiv_max_results,
    arxiv_request_interval_seconds: settings.arxiv_request_interval_seconds,
    arxiv_cache_full_text: settings.arxiv_cache_full_text,
    arxiv_pdf_dir: String(settings.arxiv_pdf_dir),
    arxiv_text_dir: String(settings.arxiv_text_dir),
    retry_daily_max_results: integerOrDefault(
      pythonOr(storedOr(stored, "retry_daily_max_results", envValue("RETRY_DAILY_MAX_RESULTS", settings.retry_daily_max_results)), 100),
      100,
      "retry_daily_max_results"
    ),
    rag_score_threshold: settings.rag_score_threshold,
    rag_top_k: settings.rag_top_k,
    rag_searchers: settings.rag_searchers,
    rag_prefilter_enabled: settings.rag_prefilter_enabled,
    rag_prefilter_threshold: settings.rag_prefilter_threshold,
    rag_prefilter_top_k: settings.rag_prefilter_top_k,
    rag_prefilter_min_keep: settings.rag_prefilter_min_keep,
    rag_prefilter_max_keep: settings.rag_prefilter_max_keep,
    llm_providers: settings.llm_providers.map((provider) => providerToPayload(provider)),
    llm_chat_provider_id: settings.llm_chat_provider_id,
    llm_chat_model: settings.llm_chat_model,
    llm_embedding_provider_id: settings.llm_embedding_provider_id,
    llm_embedding_model: settings.llm_embedding_model,
    paper_reader_default_prompt: String(
      storedOr(stored, "paper_reader_default_prompt", settings.paper_reader_default_prompt || DEFAULT_PAPER_READER_PROMPT)
    ),
    paper_report_provider_id: String(storedOr(stored, "paper_report_provider_id", settings.paper_report_provider_id || "")),
    paper_report_model: String(storedOr(stored, "paper_report_model", settings.paper_report_model || "")),
    reader_chat_provider_id: String(storedOr(stored, "reader_chat_provider_id", settings.reader_chat_provider_id || "")),
    reader_chat_model: String(storedOr(stored, "reader_chat_model", settings.reader_chat_model || "")),
    reader_smart_save_provider_id: String(
      storedOr(stored, "reader_smart_save_provider_id", settings.reader_smart_save_provider_id || "")
    ),
    reader_smart_save_model: String(
      storedOr(stored, "reader_smart_save_model", settings.reader_smart_save_model || "")
    ),
    reader_question_provider_id: String(
      storedOr(stored, "reader_question_provider_id", settings.reader_question_provider_id || "")
    ),
    reader_question_model: String(storedOr(stored, "reader_question_model", settings.reader_question_model || "")),
    embedding_concurrency: positiveInteger(
      storedOr(stored, "embedding_concurrency", envValue("EMBEDDING_CONCURRENCY", String(settings.embedding_concurrency || 2))),
      settings.embedding_concurrency || 2,
      "embedding_concurrency"
    ),
    scheduler_enabled: boolValue(storedOr(stored, "scheduler_enabled", envValue("SCHEDULER_ENABLED", false))),
    run_daily_on_startup_enabled: boolValue(
      storedOr(stored, "run_daily_on_startup_enabled", envValue("RUN_DAILY_ON_STARTUP_ENABLED", false))
    ),
    scheduler_run_time: String(storedOr(stored, "scheduler_run_time", envValue("SCHEDULER_RUN_TIME", "09:00"))),
    scheduler_interval_hours: integerOrDefault(
      pythonOr(storedOr(stored, "scheduler_interval_hours", envValue("SCHEDULER_INTERVAL_HOURS", 24)), 24),
      24,
      "scheduler_interval_hours"
    ),
    paper_report_queue_concurrency: Math.max(
      1,
      integerOrDefault(
        pythonOr(
          storedOr(
            stored,
            "paper_report_queue_concurrency",
            envValue("PAPER_REPORT_QUEUE_CONCURRENCY", envValue("PAPER_REPORT_QUEUE_LIMIT", 1))
          ),
          1
        ),
        1,
        "paper_report_queue_concurrency"
      )
    ),
    onboarding_completed: boolValue(storedOr(stored, "onboarding_completed", false)),
    onboarding_project_source: String(storedOr(stored, "onboarding_project_source", ""))
  };
}

export async function readStoredSettings(client = null) {
  const result = await (client
    ? client.query("SELECT key, value_json FROM app_settings")
    : query("SELECT key, value_json FROM app_settings"));
  return Object.fromEntries(
    (result.rows || []).map((row) => [row.key, parseJson(row.value_json, null)])
  );
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

async function storeSetting(client, key, value, now) {
  await client.query(
    `
      INSERT INTO app_settings(key, value_json, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `,
    [key, toJson(value), now]
  );
}

export function normalizeSettingsPayload(payload = {}, currentSettings = {}) {
  const existingProviders = new Map(
    providersFromValue(currentSettings.llm_providers || []).map((provider) => [provider.id, provider])
  );
  const normalized = {};
  for (const [key, rawValue] of Object.entries(payload || {})) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (SECRET_FIELDS.has(key) && !stringOrEmpty(rawValue)) continue;

    let value = rawValue;
    if (CSV_FIELDS.has(key)) {
      value = csvValue(rawValue, { tags: TAG_FIELDS.has(key) });
    } else if (key === "llm_providers") {
      value = providersFromValue(rawValue, existingProviders).map((provider) => providerToStore(provider));
    } else if (INT_FIELDS.has(key)) {
      value = parseInteger(rawValue || 0, key);
      if (key === "embedding_concurrency" && value < 1) {
        throw new ValidationError("embedding_concurrency must be at least 1");
      }
    } else if (FLOAT_FIELDS.has(key)) {
      value = parseFloatValue(rawValue || 0, key);
    } else if (BOOL_FIELDS.has(key)) {
      value = boolValue(rawValue);
    } else if (key === "scheduler_run_time") {
      value = String(rawValue || "09:00");
      if (!/^\d{2}:\d{2}$/.test(value)) {
        throw new ValidationError("scheduler_run_time must use HH:MM");
      }
    } else {
      value = stringOrEmpty(rawValue);
    }
    normalized[key] = value;
  }

  for (const [flag, secretKey] of Object.entries(SECRET_CLEAR_FLAGS)) {
    if (boolValue(payload?.[flag])) normalized[secretKey] = "";
  }

  if (normalized.scheduler_enabled && normalized.run_daily_on_startup_enabled) {
    throw new ValidationError("scheduler_enabled and run_daily_on_startup_enabled are mutually exclusive");
  }
  if (normalized.scheduler_enabled) normalized.run_daily_on_startup_enabled = false;
  if (normalized.run_daily_on_startup_enabled) normalized.scheduler_enabled = false;
  return normalized;
}

export async function getAppSettings() {
  const stored = await readStoredSettings();
  return { settings: settingsPayloadFromStored(stored) };
}

export async function saveAppSettings(payload = {}) {
  return withTransaction(async (client) => {
    const current = await readStoredSettings(client);
    const normalized = normalizeSettingsPayload(payload, current);
    const now = utcNow();
    for (const [key, value] of Object.entries(normalized)) {
      await storeSetting(client, key, value, now);
    }
    return { settings: settingsPayloadFromStored({ ...current, ...normalized }) };
  });
}
