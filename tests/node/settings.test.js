import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, toJson, ValidationError } from "../../server/db.js";
import {
  DEFAULT_PAPER_READER_PROMPTS,
  getAppSettings,
  normalizeProviderBaseUrl,
  normalizeSettingsPayload,
  resolvePaperReaderPrompt,
  saveAppSettings,
  SETTING_SCHEMA
} from "../../server/settings.js";

const SETTINGS_ENV_KEYS = [
  "OBSIDIAN_VAULT_PATH",
  "OBSIDIAN_INCLUDE_DIRS",
  "OBSIDIAN_INCLUDE_TAGS",
  "OBSIDIAN_PROJECT_CENTER_TAGS",
  "OBSIDIAN_CLI_COMMAND",
  "OBSIDIAN_PAPER_REPOSITORY_DIR",
  "OBSIDIAN_PAPER_ATTACHMENT_DIR",
  "OBSIDIAN_PROJECT_PAPER_LIST_NAME",
  "ARXIV_CATEGORIES",
  "ARXIV_DAILY_LOOKBACK_DAYS",
  "ARXIV_MAX_RESULTS",
  "ARXIV_REQUEST_INTERVAL_SECONDS",
  "ARXIV_CACHE_FULL_TEXT",
  "ARXIV_PDF_DIR",
  "ARXIV_TEXT_DIR",
  "RETRY_DAILY_MAX_RESULTS",
  "RAG_SCORE_THRESHOLD",
  "RAG_TOP_K",
  "RAG_SEARCHERS",
  "RAG_PREFILTER_ENABLED",
  "RAG_PREFILTER_THRESHOLD",
  "RAG_PREFILTER_TOP_K",
  "RAG_PREFILTER_MIN_KEEP",
  "RAG_PREFILTER_MAX_KEEP",
  "LLM_PROVIDERS_JSON",
  "LLM_CHAT_PROVIDER_ID",
  "LLM_CHAT_MODEL",
  "LLM_EMBEDDING_PROVIDER_ID",
  "LLM_EMBEDDING_MODEL",
  "OBSIDIAN_STORAGE_BACKEND",
  "OBSIDIAN_REMOTE_ENDPOINT_URL",
  "OBSIDIAN_REMOTE_REGION",
  "OBSIDIAN_REMOTE_BUCKET",
  "OBSIDIAN_REMOTE_PREFIX",
  "OBSIDIAN_REMOTE_ACCESS_KEY_ID",
  "OBSIDIAN_REMOTE_SECRET_ACCESS_KEY",
  "OBSIDIAN_REMOTE_MIRROR_DIR",
  "OBSIDIAN_REMOTE_OUTPUT_PREFIX",
  "OBSIDIAN_REMOTE_APPEND_ONLY",
  "EMBEDDING_CONCURRENCY",
  "PAPER_READER_DEFAULT_PROMPT",
  "PAPER_READER_PROMPT_MODE",
  "PAPER_READER_PROMPT_LOCALE",
  "PAPER_REPORT_PROVIDER_ID",
  "PAPER_REPORT_MODEL",
  "PROJECT_CHAT_PROFILE_PROVIDER_ID",
  "PROJECT_CHAT_PROFILE_MODEL",
  "PROJECT_CHAT_PROFILE_CONCURRENCY",
  "PROJECT_JUDGMENT_CONCURRENCY",
  "READER_CHAT_PROVIDER_ID",
  "READER_CHAT_MODEL",
  "READER_SMART_SAVE_PROVIDER_ID",
  "READER_SMART_SAVE_MODEL",
  "READER_QUESTION_PROVIDER_ID",
  "READER_QUESTION_MODEL",
  "SCHEDULER_ENABLED",
  "RUN_DAILY_ON_STARTUP_ENABLED",
  "SCHEDULER_RUN_TIME",
  "SCHEDULER_INTERVAL_HOURS",
  "PAPER_REPORT_QUEUE_CONCURRENCY",
  "PAPER_REPORT_QUEUE_LIMIT"
];

async function withCleanSettingsEnv(fn) {
  const previous = new Map(SETTINGS_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of SETTINGS_ENV_KEYS) delete process.env[key];
    return await fn();
  } finally {
    for (const key of SETTINGS_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createSettingsPool(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, toJson(value)]));
  const txCalls = [];

  async function runQuery(sql, params = []) {
    const normalizedSql = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalizedSql)) {
      txCalls.push(normalizedSql);
      return { rows: [] };
    }
    if (normalizedSql.startsWith("SELECT KEY, VALUE_JSON FROM APP_SETTINGS")) {
      return {
        rows: Array.from(store.entries()).map(([key, value_json]) => ({ key, value_json }))
      };
    }
    if (normalizedSql.startsWith("INSERT INTO APP_SETTINGS")) {
      store.set(params[0], params[1]);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in settings test: ${sql}`);
  }

  return {
    txCalls,
    value(key) {
      return JSON.parse(store.get(key));
    },
    pool: {
      async query(sql, params) {
        return runQuery(sql, params);
      },
      async connect() {
        return {
          query: runQuery,
          release() {
            txCalls.push("RELEASE");
          }
        };
      }
    }
  };
}

test("getAppSettings hides secrets and preserves settings response shape", async () => {
  await withCleanSettingsEnv(async () => {
    const fake = createSettingsPool({
      obsidian_remote_secret_access_key: "stored-secret",
      obsidian_remote_append_only: false,
      llm_providers: [{
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1/chat/completions",
        api_key: "provider-secret",
        chat_models: ["gpt-4.1"],
        embedding_models: ["text-embedding-3-small"]
      }],
      scheduler_enabled: true
    });
    setPoolForTesting(fake.pool);
    try {
      const data = await getAppSettings();
      assert.ok(data.settings);
      assert.equal(data.ok, undefined);
      assert.equal(data.settings.obsidian_remote_secret_access_key, "");
      assert.equal(data.settings.obsidian_remote_secret_access_key_configured, true);
      assert.equal(data.settings.obsidian_remote_append_only, true);
      assert.equal(data.settings.scheduler_enabled, true);
      assert.equal(data.settings.paper_reader_prompt_mode, "default");
      assert.equal(data.settings.paper_reader_prompt_locale, "zh-CN");
      assert.equal(data.settings.paper_reader_default_prompt, "");
      assert.deepEqual(data.settings.paper_reader_prompt_defaults, DEFAULT_PAPER_READER_PROMPTS);
      assert.deepEqual(data.settings.llm_providers, [{
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        api_key_configured: true,
        chat_models: ["gpt-4.1"],
        embedding_models: ["text-embedding-3-small"],
        provider_type: "openai_compatible",
        openrouter_model_policies: {}
      }]);
    } finally {
      setPoolForTesting(null);
    }
  });
});

test("saveAppSettings preserves blank secrets and clears provider keys only by flag", async () => {
  await withCleanSettingsEnv(async () => {
    const fake = createSettingsPool({
      obsidian_remote_secret_access_key: "remote-secret",
      llm_providers: [{
        id: "default",
        name: "Default",
        base_url: "https://example.test/v1",
        api_key: "old-provider-secret",
        chat_models: ["chat-a"],
        embedding_models: ["embed-a"]
      }]
    });
    setPoolForTesting(fake.pool);
    try {
      const first = await saveAppSettings({
        obsidian_remote_secret_access_key: "",
        llm_providers: [{
          id: "default",
          name: "Default",
          base_url: "https://example.test/v1/embeddings",
          api_key: "",
          clear_api_key: false,
          chat_models: ["chat-b"],
          embedding_models: ["embed-b"]
        }]
      });
      assert.equal(fake.value("obsidian_remote_secret_access_key"), "remote-secret");
      assert.equal(fake.value("llm_providers")[0].api_key, "old-provider-secret");
      assert.equal(first.settings.obsidian_remote_secret_access_key_configured, true);
      assert.equal(first.settings.llm_providers[0].api_key_configured, true);
      assert.equal(first.settings.llm_providers[0].base_url, "https://example.test/v1");

      const second = await saveAppSettings({
        llm_providers: [{
          id: "default",
          name: "Default",
          base_url: "https://example.test/v1",
          api_key: "",
          clear_api_key: true,
          chat_models: ["chat-b"],
          embedding_models: ["embed-b"]
        }]
      });
      assert.equal(fake.value("llm_providers")[0].api_key, "");
      assert.equal(second.settings.llm_providers[0].api_key_configured, false);

      const third = await saveAppSettings({
        clear_obsidian_remote_secret_access_key: true
      });
      assert.equal(fake.value("obsidian_remote_secret_access_key"), "");
      assert.equal(third.settings.obsidian_remote_secret_access_key_configured, false);
    } finally {
      setPoolForTesting(null);
    }
  });
});

test("saveAppSettings keeps scheduler modes mutually exclusive", async () => {
  await withCleanSettingsEnv(async () => {
    const fake = createSettingsPool();
    setPoolForTesting(fake.pool);
    try {
      const startup = await saveAppSettings({ run_daily_on_startup_enabled: true });
      assert.equal(startup.settings.run_daily_on_startup_enabled, true);
      assert.equal(startup.settings.scheduler_enabled, false);
      assert.equal(fake.value("scheduler_enabled"), false);

      const scheduler = await saveAppSettings({ scheduler_enabled: true });
      assert.equal(scheduler.settings.scheduler_enabled, true);
      assert.equal(scheduler.settings.run_daily_on_startup_enabled, false);
      assert.equal(fake.value("run_daily_on_startup_enabled"), false);

      await assert.rejects(
        () => saveAppSettings({ scheduler_enabled: true, run_daily_on_startup_enabled: true }),
        ValidationError
      );
    } finally {
      setPoolForTesting(null);
    }
  });
});

test("saveAppSettings preserves project Chat profile model routing", async () => {
  await withCleanSettingsEnv(async () => {
    const fake = createSettingsPool();
    setPoolForTesting(fake.pool);
    try {
      const result = await saveAppSettings({
        project_chat_profile_provider_id: "openai",
        project_chat_profile_model: "gpt-4.1-mini",
        project_chat_profile_concurrency: 3,
        project_judgment_concurrency: 4
      });
      assert.equal(fake.value("project_chat_profile_provider_id"), "openai");
      assert.equal(fake.value("project_chat_profile_model"), "gpt-4.1-mini");
      assert.equal(fake.value("project_chat_profile_concurrency"), 3);
      assert.equal(fake.value("project_judgment_concurrency"), 4);
      assert.equal(result.settings.project_chat_profile_provider_id, "openai");
      assert.equal(result.settings.project_chat_profile_model, "gpt-4.1-mini");
      assert.equal(result.settings.project_chat_profile_concurrency, 3);
      assert.equal(result.settings.project_judgment_concurrency, 4);
    } finally {
      setPoolForTesting(null);
    }
  });
});

test("normalizeSettingsPayload matches csv tags, validation, and provider URL rules", () => {
  assert.equal(normalizeProviderBaseUrl("https://example.test/v1/chat/completions/"), "https://example.test/v1");
  assert.deepEqual(
    normalizeSettingsPayload({
      llm_providers: [{
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1/chat/completions",
        provider_type: "openrouter",
        chat_models: ["deepseek/deepseek-chat"],
        openrouter_model_policies: {
          "deepseek/deepseek-chat": {
            reasoning_effort: "HIGH",
            provider_only: "DeepInfra, Fireworks",
            provider_sort: "price"
          }
        }
      }]
    }).llm_providers[0],
    {
      id: "openrouter",
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      api_key: "",
      chat_models: ["deepseek/deepseek-chat"],
      embedding_models: [],
      provider_type: "openrouter",
      openrouter_model_policies: {
        "deepseek/deepseek-chat": {
          reasoning_effort: "high",
          provider_only: ["deepinfra", "fireworks"],
          provider_sort: "price"
        }
      }
    }
  );
  assert.deepEqual(
    normalizeSettingsPayload({
      obsidian_include_tags: "#AI, #Paper",
      unknown_configured: true,
      scheduler_run_time: "09:30"
    }),
    {
      obsidian_include_tags: ["ai", "paper"],
      scheduler_run_time: "09:30"
    }
  );
  assert.throws(
    () => normalizeSettingsPayload({ scheduler_run_time: "9:30" }),
    ValidationError
  );
  assert.throws(
    () => normalizeSettingsPayload({ embedding_concurrency: 0 }),
    ValidationError
  );
  assert.throws(
    () => normalizeSettingsPayload({ project_chat_profile_concurrency: 9 }),
    ValidationError
  );
  assert.throws(
    () => normalizeSettingsPayload({ project_judgment_concurrency: 9 }),
    ValidationError
  );
  assert.throws(
    () => normalizeSettingsPayload({ paper_reader_prompt_mode: "automatic" }),
    ValidationError
  );
  assert.throws(
    () => normalizeSettingsPayload({ paper_reader_prompt_locale: "fr" }),
    ValidationError
  );
  assert.throws(
    () => normalizeSettingsPayload({
      llm_providers: [
        { id: "openrouter", provider_type: "openrouter" },
        { id: "openrouter-backup", provider_type: "openrouter" }
      ]
    }),
    ValidationError
  );
});

test("legacy OpenRouter policy migrates only for a single-model catalog", () => {
  const single = normalizeSettingsPayload({
    llm_providers: [{
      id: "openrouter",
      provider_type: "openrouter",
      chat_models: ["deepseek/deepseek-chat"],
      reasoning_effort: "high",
      openrouter_provider_only: ["DeepInfra"],
      openrouter_provider_sort: "price"
    }]
  }).llm_providers[0];
  assert.deepEqual(single.openrouter_model_policies, {
    "deepseek/deepseek-chat": {
      reasoning_effort: "high",
      provider_only: ["deepinfra"],
      provider_sort: "price"
    }
  });

  const mixed = normalizeSettingsPayload({
    llm_providers: [{
      id: "openrouter",
      provider_type: "openrouter",
      chat_models: ["deepseek/deepseek-chat", "openai/gpt-5"],
      reasoning_effort: "high",
      openrouter_provider_only: ["DeepInfra"],
      openrouter_provider_sort: "price"
    }]
  }).llm_providers[0];
  assert.deepEqual(mixed.openrouter_model_policies, {});
});

test("paper reading prompt mode resolves localized defaults without overwriting custom text", () => {
  assert.equal(
    resolvePaperReaderPrompt({ paper_reader_prompt_mode: "default", paper_reader_prompt_locale: "en" }),
    DEFAULT_PAPER_READER_PROMPTS.en
  );
  assert.equal(
    resolvePaperReaderPrompt({
      paper_reader_prompt_mode: "custom",
      paper_reader_prompt_locale: "zh-CN",
      paper_reader_default_prompt: "Focus on the evaluation protocol."
    }, { locale: "en" }),
    "Focus on the evaluation protocol."
  );
  assert.equal(
    resolvePaperReaderPrompt({
      paper_reader_prompt_mode: "default",
      paper_reader_prompt_locale: "zh-CN",
      paper_reader_default_prompt: "An unused custom prompt"
    }, { locale: "en" }),
    DEFAULT_PAPER_READER_PROMPTS.en
  );
});

test("legacy stored prompts infer default or custom mode without data loss", async () => {
  await withCleanSettingsEnv(async () => {
    const customFake = createSettingsPool({ paper_reader_default_prompt: "Analyze only the methods." });
    setPoolForTesting(customFake.pool);
    try {
      const custom = await getAppSettings();
      assert.equal(custom.settings.paper_reader_prompt_mode, "custom");
      assert.equal(custom.settings.paper_reader_default_prompt, "Analyze only the methods.");
    } finally {
      setPoolForTesting(null);
    }

    const defaultFake = createSettingsPool({
      paper_reader_default_prompt: `请阅读这篇论文 PDF，输出结构化解读：

1. 研究问题和背景
2. 方法和实验设计
3. 主要发现
4. 局限性
5. 对后续研究或应用的启发

请尽量使用中文，保留关键英文术语。`
    });
    setPoolForTesting(defaultFake.pool);
    try {
      const defaults = await getAppSettings();
      assert.equal(defaults.settings.paper_reader_prompt_mode, "default");
      assert.equal(defaults.settings.paper_reader_default_prompt, "");
    } finally {
      setPoolForTesting(null);
    }
  });
});

test("SETTING_SCHEMA describes secret and worker-visible fields centrally", () => {
  assert.equal(SETTING_SCHEMA.obsidian_remote_secret_access_key.secret, true);
  assert.equal(SETTING_SCHEMA.obsidian_remote_secret_access_key.type, "string");
  assert.equal(SETTING_SCHEMA.paper_report_queue_concurrency.type, "int");
  assert.equal(SETTING_SCHEMA.paper_report_provider_id.worker_visible, true);
  assert.equal(SETTING_SCHEMA.paper_reader_prompt_mode.worker_visible, true);
  assert.equal(SETTING_SCHEMA.paper_reader_prompt_locale.worker_visible, true);
  assert.equal(SETTING_SCHEMA.project_chat_profile_model.worker_visible, true);
  assert.equal(SETTING_SCHEMA.project_chat_profile_concurrency.type, "int");
  assert.equal(SETTING_SCHEMA.project_chat_profile_concurrency.worker_visible, true);
  assert.equal(SETTING_SCHEMA.project_judgment_concurrency.type, "int");
  assert.equal(SETTING_SCHEMA.project_judgment_concurrency.worker_visible, true);
});
