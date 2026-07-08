import { existsSync } from "node:fs";

import { databaseTarget, query } from "./db.js";
import { getJobSummary } from "./jobs.js";
import { applyStoredSettings, readStoredSettings } from "./settings.js";

const PAPER_REPORT_ARTIFACT_TYPE = "paper_report";
const REMOTE_OBSIDIAN_BACKENDS = new Set(["oss", "s3", "r2"]);
const DEFAULT_REMOTE_OUTPUT_PREFIX = "Research Intelligence";

function cleanText(value) {
  return String(value || "").replace(/\u0000/g, "");
}

function cleanKeyPart(value) {
  return cleanText(value).replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "");
}

export function obsidianRemoteBackend(settings = {}) {
  const backend = cleanText(settings.obsidian_storage_backend || "local").trim().toLowerCase() || "local";
  return backend === "object" || backend === "remote" ? "s3" : backend;
}

export function obsidianRemoteEnabled(settings = {}) {
  return REMOTE_OBSIDIAN_BACKENDS.has(obsidianRemoteBackend(settings));
}

export function obsidianRemoteOutputPrefix(settings = {}) {
  return cleanKeyPart(settings.obsidian_remote_output_prefix) || DEFAULT_REMOTE_OUTPUT_PREFIX;
}

export function obsidianRemoteConfigured(settings = {}) {
  if (!obsidianRemoteEnabled(settings)) return false;
  const backend = obsidianRemoteBackend(settings);
  const bucket = cleanText(settings.obsidian_remote_bucket).trim();
  const endpoint = cleanText(settings.obsidian_remote_endpoint_url).trim();
  const accessKey = cleanText(settings.obsidian_remote_access_key_id).trim();
  const secret = cleanText(settings.obsidian_remote_secret_access_key).trim();
  if (!bucket) return false;
  if ((backend === "oss" || backend === "r2") && !endpoint) return false;
  if ((backend === "oss" || backend === "r2") && (!accessKey || !secret)) return false;
  return true;
}

export function obsidianRemoteStatus(settings = {}) {
  const backend = obsidianRemoteBackend(settings);
  return {
    enabled: obsidianRemoteEnabled(settings),
    configured: obsidianRemoteConfigured(settings),
    backend,
    bucket: cleanText(settings.obsidian_remote_bucket).trim(),
    prefix: cleanKeyPart(settings.obsidian_remote_prefix),
    output_prefix: obsidianRemoteOutputPrefix(settings),
    mirror_dir: String(settings.obsidian_remote_mirror_dir || "./data/obsidian_remote_vault"),
    append_only: true
  };
}

async function tableExists(table) {
  const result = await query(
    `
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = $1
    `,
    [table]
  );
  return Boolean(result.rows?.length);
}

async function tableCount(table) {
  if (!(await tableExists(table))) return 0;
  const result = await query(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows?.[0]?.count || 0);
}

async function paperReportArtifactCount() {
  const result = await query(
    `
      SELECT COUNT(*) AS count
      FROM artifacts
      WHERE scope_type = 'paper'
        AND artifact_type = $1
    `,
    [PAPER_REPORT_ARTIFACT_TYPE]
  );
  return Number(result.rows?.[0]?.count || 0);
}

async function completePaperTextCount() {
  if (!(await tableExists("arxiv_papers"))) return 0;
  const result = await query("SELECT COUNT(*) AS count FROM arxiv_papers WHERE text_status = 'complete'");
  return Number(result.rows?.[0]?.count || 0);
}

async function healthCounts({ detailed = false } = {}) {
  const counts = {
    notes: await tableCount("obsidian_notes"),
    knowledge_documents: await tableCount("knowledge_documents"),
    projects: await tableCount("research_projects"),
    artifacts: await tableCount("artifacts"),
    paper_report_artifacts: await paperReportArtifactCount(),
    papers: await tableCount("papers")
  };
  if (!detailed) return counts;
  return {
    ...counts,
    legacy_project_artifacts: await tableCount("project_artifacts"),
    project_paper_matches: await tableCount("project_paper_matches"),
    project_paper_judgments: await tableCount("project_paper_judgments"),
    project_paper_recommendations: await tableCount("project_paper_recommendations"),
    legacy_paper_reading_reports: await tableCount("paper_reading_reports"),
    chunks: await tableCount("research_chunks"),
    arxiv_papers: await tableCount("arxiv_papers"),
    paper_embeddings: await tableCount("arxiv_paper_embeddings"),
    paper_texts: await completePaperTextCount(),
    paper_chunks: await tableCount("paper_chunks"),
    legacy_paper_chunks: await tableCount("arxiv_text_chunks"),
    paper_chunk_embeddings: await tableCount("arxiv_chunk_embeddings"),
    prefilter_runs: await tableCount("paper_prefilter_runs"),
    matches: await tableCount("matches"),
    feedback: await tableCount("user_feedback")
  };
}

function llmHealth(settings = {}) {
  const providers = Array.isArray(settings.llm_providers) ? settings.llm_providers : [];
  return {
    configured: providers.some((provider) => Boolean(provider?.api_key)),
    providers: providers.map((provider) => ({
      id: cleanText(provider?.id),
      name: cleanText(provider?.name),
      base_url: cleanText(provider?.base_url),
      api_key_configured: Boolean(provider?.api_key),
      chat_models: Array.isArray(provider?.chat_models) ? provider.chat_models : [],
      embedding_models: Array.isArray(provider?.embedding_models) ? provider.embedding_models : []
    })),
    chat_provider_id: cleanText(settings.llm_chat_provider_id),
    chat_model: cleanText(settings.llm_chat_model),
    embedding_provider_id: cleanText(settings.llm_embedding_provider_id),
    embedding_model: cleanText(settings.llm_embedding_model)
  };
}

async function buildHealth({ detailed = false } = {}) {
  const stored = await readStoredSettings();
  const settings = applyStoredSettings(stored);
  const remote = obsidianRemoteStatus(settings);
  const remoteEnabled = obsidianRemoteEnabled(settings);
  const vaultPath = String(settings.obsidian_vault_path || "");
  const vaultExists = Boolean(vaultPath && existsSync(vaultPath));
  const remoteConfigured = obsidianRemoteConfigured(settings);
  const obsidianConfigured = remoteEnabled ? remoteConfigured : Boolean(vaultPath);
  const obsidianStatus = remoteEnabled
    ? remoteConfigured ? "remote_configured" : "remote_incomplete"
    : vaultExists ? "ok" : vaultPath ? "missing" : "not_configured";
  return {
    database: {
      ok: true,
      ...databaseTarget()
    },
    obsidian: {
      configured: obsidianConfigured,
      path: vaultPath,
      exists: vaultExists,
      status: obsidianStatus,
      storage_backend: remote.backend,
      remote,
      ...(detailed ? {
        cli_command: cleanText(settings.obsidian_cli_command),
        paper_repository_dir: cleanText(settings.obsidian_paper_repository_dir),
        paper_attachment_dir: cleanText(settings.obsidian_paper_attachment_dir)
      } : {})
    },
    ...(detailed ? { llm: llmHealth(settings) } : {}),
    counts: await healthCounts({ detailed }),
    ...(await getJobSummary())
  };
}

export async function getHealthSummary() {
  return buildHealth({ detailed: false });
}

export async function getHealth() {
  return buildHealth({ detailed: true });
}
