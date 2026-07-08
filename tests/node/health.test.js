import assert from "node:assert/strict";
import test from "node:test";

import { setPoolForTesting, toJson } from "../../server/db.js";
import {
  getHealth,
  getHealthSummary,
  obsidianRemoteBackend,
  obsidianRemoteConfigured,
  obsidianRemoteStatus
} from "../../server/health.js";

function createHealthPool({
  settings = {},
  tableCounts = {},
  paperReportArtifacts = "0",
  paperTexts = "0",
  latestJob = null,
  runningCount = "0"
} = {}) {
  const calls = [];
  const storedSettings = Object.entries(settings).map(([key, value]) => ({ key, value_json: toJson(value) }));
  return {
    calls,
    pool: {
      async query(sql, params = []) {
        calls.push({ sql: String(sql), params });
        const normalized = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        if (normalized === "SELECT KEY, VALUE_JSON FROM APP_SETTINGS") {
          return { rows: storedSettings };
        }
        if (normalized.includes("INFORMATION_SCHEMA.TABLES")) {
          return Object.hasOwn(tableCounts, params[0]) ? { rows: [{ name: params[0] }] } : { rows: [] };
        }
        if (normalized.includes("FROM ARTIFACTS") && normalized.includes("ARTIFACT_TYPE = $1")) {
          return { rows: [{ count: paperReportArtifacts }] };
        }
        if (normalized === "SELECT COUNT(*) AS COUNT FROM ARXIV_PAPERS WHERE TEXT_STATUS = 'COMPLETE'") {
          return { rows: [{ count: paperTexts }] };
        }
        if (normalized.includes("FROM JOB_RUNS") && normalized.includes("ORDER BY ID DESC") && normalized.includes("LIMIT 1")) {
          return { rows: latestJob ? [latestJob] : [] };
        }
        if (normalized.includes("COUNT(*) AS COUNT FROM JOB_RUNS WHERE STATUS = 'RUNNING'")) {
          return { rows: [{ count: runningCount }] };
        }
        for (const [table, count] of Object.entries(tableCounts)) {
          if (normalized === `SELECT COUNT(*) AS COUNT FROM ${table.toUpperCase()}`) {
            return { rows: [{ count }] };
          }
        }
        throw new Error(`Unexpected SQL in health test: ${sql}`);
      }
    }
  };
}

async function withDatabaseUrl(value, fn) {
  const previous = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = value;
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

test("Obsidian remote helpers match Python backend and configured semantics", () => {
  assert.equal(obsidianRemoteBackend({ obsidian_storage_backend: "object" }), "s3");
  assert.equal(obsidianRemoteConfigured({
    obsidian_storage_backend: "s3",
    obsidian_remote_bucket: "papers"
  }), true);
  assert.equal(obsidianRemoteConfigured({
    obsidian_storage_backend: "oss",
    obsidian_remote_bucket: "papers",
    obsidian_remote_endpoint_url: "https://oss.test"
  }), false);
  assert.deepEqual(obsidianRemoteStatus({
    obsidian_storage_backend: "r2",
    obsidian_remote_bucket: "vault",
    obsidian_remote_endpoint_url: "https://r2.test",
    obsidian_remote_access_key_id: "key",
    obsidian_remote_secret_access_key: "secret",
    obsidian_remote_prefix: "\\team/research/",
    obsidian_remote_output_prefix: "",
    obsidian_remote_mirror_dir: "./mirror"
  }), {
    enabled: true,
    configured: true,
    backend: "r2",
    bucket: "vault",
    prefix: "team/research",
    output_prefix: "Research Intelligence",
    mirror_dir: "./mirror",
    append_only: true
  });
});

test("getHealthSummary returns Python-compatible local Obsidian and counts shape", async () => {
  await withDatabaseUrl("postgresql://user:secret@db:5432/app", async () => {
    const fake = createHealthPool({
      settings: {
        obsidian_vault_path: "Z:/definitely/missing/vault"
      },
      tableCounts: {
        obsidian_notes: "4",
        knowledge_documents: "5",
        research_projects: "6",
        artifacts: "7",
        papers: "8"
      },
      paperReportArtifacts: "3",
      runningCount: "1",
      latestJob: {
        id: "12",
        job_type: "run-daily",
        status: "running",
        started_at: "2026-07-06T10:00:00+00:00",
        finished_at: null,
        message: "Daily run",
        heartbeat_at: "2026-07-06T10:00:30+00:00"
      }
    });
    setPoolForTesting(fake.pool);
    try {
      assert.deepEqual(await getHealthSummary(), {
        database: {
          ok: true,
          dialect: "postgres",
          target: "postgresql://user:***@db:5432/app",
          path: "postgresql://user:***@db:5432/app"
        },
        obsidian: {
          configured: true,
          path: "Z:/definitely/missing/vault",
          exists: false,
          status: "missing",
          storage_backend: "local",
          remote: {
            enabled: false,
            configured: false,
            backend: "local",
            bucket: "",
            prefix: "",
            output_prefix: "Research Intelligence",
            mirror_dir: "./data/obsidian_remote_vault",
            append_only: true
          }
        },
        counts: {
          notes: 4,
          knowledge_documents: 5,
          projects: 6,
          artifacts: 7,
          paper_report_artifacts: 3,
          papers: 8
        },
        running_count: 1,
        latest_job: {
          id: 12,
          job_type: "run-daily",
          status: "running",
          started_at: "2026-07-06T10:00:00+00:00",
          finished_at: null,
          message: "Daily run",
          heartbeat_at: "2026-07-06T10:00:30+00:00"
        }
      });
    } finally {
      setPoolForTesting(null);
    }
  });
});

test("getHealthSummary reports remote incomplete without local vault path", async () => {
  const fake = createHealthPool({
    settings: {
      obsidian_storage_backend: "oss",
      obsidian_remote_bucket: "vault"
    },
    tableCounts: {
      obsidian_notes: "0",
      knowledge_documents: "0",
      research_projects: "0",
      artifacts: "0",
      papers: "0"
    }
  });
  setPoolForTesting(fake.pool);
  try {
    const summary = await getHealthSummary();
    assert.equal(summary.obsidian.configured, false);
    assert.equal(summary.obsidian.status, "remote_incomplete");
    assert.equal(summary.obsidian.remote.enabled, true);
    assert.equal(summary.obsidian.remote.configured, false);
    assert.equal(summary.latest_job, null);
  } finally {
    setPoolForTesting(null);
  }
});

test("getHealth returns full Node health shape without Python CLI fields leaking secrets", async () => {
  const fake = createHealthPool({
    settings: {
      obsidian_vault_path: "Z:/definitely/missing/vault",
      obsidian_cli_command: "obsidian",
      obsidian_paper_repository_dir: "Papers",
      obsidian_paper_attachment_dir: "Papers/attachments",
      llm_providers: [{
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        api_key: "secret-key",
        chat_models: ["gpt-test"],
        embedding_models: ["embed-test"]
      }],
      llm_chat_provider_id: "openai",
      llm_chat_model: "gpt-test",
      llm_embedding_provider_id: "openai",
      llm_embedding_model: "embed-test"
    },
    tableCounts: {
      obsidian_notes: "4",
      knowledge_documents: "5",
      research_projects: "6",
      artifacts: "7",
      papers: "8",
      project_artifacts: "9",
      project_paper_matches: "10",
      project_paper_judgments: "11",
      project_paper_recommendations: "12",
      paper_reading_reports: "13",
      research_chunks: "14",
      arxiv_papers: "15",
      arxiv_paper_embeddings: "16",
      paper_chunks: "17",
      arxiv_text_chunks: "18",
      arxiv_chunk_embeddings: "19",
      paper_prefilter_runs: "20",
      matches: "21",
      user_feedback: "22"
    },
    paperReportArtifacts: "3",
    paperTexts: "2"
  });
  setPoolForTesting(fake.pool);
  try {
    const health = await getHealth();
    assert.equal(health.obsidian.cli_command, "obsidian");
    assert.equal(health.obsidian.paper_repository_dir, "Papers");
    assert.equal(health.obsidian.paper_attachment_dir, "Papers/attachments");
    assert.equal(health.llm.configured, true);
    assert.deepEqual(health.llm.providers, [{
      id: "openai",
      name: "OpenAI",
      base_url: "https://api.openai.com/v1",
      api_key_configured: true,
      chat_models: ["gpt-test"],
      embedding_models: ["embed-test"]
    }]);
    assert.equal(health.llm.chat_provider_id, "openai");
    assert.equal(health.llm.chat_model, "gpt-test");
    assert.equal(health.counts.paper_texts, 2);
    assert.equal(health.counts.legacy_project_artifacts, 9);
    assert.equal(health.counts.feedback, 22);
    assert.equal(JSON.stringify(health).includes("secret-key"), false);
  } finally {
    setPoolForTesting(null);
  }
});
