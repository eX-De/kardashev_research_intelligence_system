import { createHash } from "node:crypto";

import { NotFoundError, parseJson, toJson, withTransaction } from "./db.js";
import { SERVER_EVENTS } from "./events.js";
import { insertAppEvent } from "./outbox.js";
import { enqueueWorkerJobInTransaction } from "./workerQueue.js";

const PROJECT_INDEX_LOCK_NAMESPACE = 724022;

function text(value) {
  return String(value ?? "").replace(/\u0000/g, "");
}

function markdownCell(value) {
  return text(value).replaceAll("|", "\\|");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function projectIndexInputHash(markdown, content = {}) {
  return sha256(toJson({ json: content || {}, markdown: text(markdown) }));
}

export function artifactIndexContentHash(title, markdown) {
  const indexedMarkdown = `${text(title).trim()}\n\n${text(markdown).trim()}`;
  return projectIndexInputHash(indexedMarkdown, {});
}

export function buildProjectIndexDocument({ project, papers = [], documents = [] }) {
  const keywords = Array.isArray(project.keywords)
    ? project.keywords
    : parseJson(project.keywords_json, []);
  const lines = [
    `# ${text(project.name)}`,
    "",
    `- Status: ${text(project.status)}`
  ];
  if (keywords.length) lines.push(`- Keywords: ${keywords.map((item) => text(item)).join(", ")}`);
  const summary = text(project.summary).trim();
  const goals = text(project.goals).trim();
  if (summary) lines.push("", "## Summary", "", summary);
  if (goals) lines.push("", "## Goals", "", goals);
  lines.push("", "## Papers", "", "| Relation | arXiv | Title |", "| --- | --- | --- |");
  if (papers.length) {
    for (const paper of papers) {
      const link = text(paper.link || paper.arxiv_id);
      const arxiv = text(paper.arxiv_id);
      lines.push(`| ${text(paper.relation)} | [${arxiv}](${link}) | ${markdownCell(paper.title)} |`);
    }
  } else {
    lines.push("|  |  |  |");
  }
  lines.push("", "## Context Sources", "", "| Relation | Source | Title |", "| --- | --- | --- |");
  if (documents.length) {
    for (const document of documents) {
      const source = text(document.source_type);
      const uri = text(document.source_uri);
      lines.push(`| ${text(document.relation)} | ${markdownCell(uri ? `${source}:${uri}` : source)} | ${markdownCell(document.title)} |`);
    }
  } else {
    lines.push("|  |  |  |");
  }
  const markdown = `${lines.join("\n").trimEnd()}\n`;
  const content = {
    project_id: Number(project.id),
    paper_count: papers.length,
    context_document_count: documents.length
  };
  return {
    title: `${text(project.name)} Project Index`,
    markdown,
    content,
    source: {
      project_updated_at: project.updated_at,
      source_key: `project_index:${Number(project.id)}`
    },
    input_hash: projectIndexInputHash(markdown, content)
  };
}

function artifactPayload(row) {
  return {
    id: Number(row.id),
    scope_type: row.scope_type,
    scope_id: row.scope_id === null || row.scope_id === undefined ? null : Number(row.scope_id),
    artifact_type: row.artifact_type,
    title: row.title,
    content_markdown: row.content_markdown || "",
    content_json: parseJson(row.content_json, {}),
    status: row.status,
    source: parseJson(row.source_json, {}),
    model_provider_id: row.model_provider_id || "",
    model: row.model || "",
    input_hash: row.input_hash || "",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function loadProjectIndexInputs(client, projectId) {
  const projectResult = await client.query(
    `SELECT id, name, status, summary, goals, keywords_json, updated_at
     FROM research_projects WHERE id = $1`,
    [projectId]
  );
  const project = projectResult.rows[0];
  if (!project) throw new NotFoundError(`Project not found: ${projectId}`);
  const papers = await client.query(
    `
      SELECT pp.relation, pp.note, p.arxiv_id, p.title,
             COALESCE(source.source_url, '') AS link, p.published_at
      FROM project_papers pp
      JOIN papers p ON p.id = pp.paper_id
      LEFT JOIN LATERAL (
        SELECT ps.source_url FROM paper_sources ps
        WHERE ps.paper_id = p.id ORDER BY ps.updated_at DESC, ps.id DESC LIMIT 1
      ) source ON TRUE
      WHERE pp.project_id = $1
      ORDER BY pp.updated_at DESC
    `,
    [projectId]
  );
  const documents = await client.query(
    `
      SELECT pcd.relation, pcd.weight, kd.source_type, kd.source_uri, kd.title
      FROM project_context_documents pcd
      JOIN knowledge_documents kd ON kd.id = pcd.document_id
      WHERE pcd.project_id = $1
      ORDER BY pcd.weight DESC, kd.updated_at DESC
    `,
    [projectId]
  );
  return {
    project: { ...project, keywords: parseJson(project.keywords_json, []) },
    papers: papers.rows,
    documents: documents.rows
  };
}

async function upsertProjectIndexArtifact(client, projectId, document, now) {
  const rows = await client.query(
    `SELECT * FROM artifacts
     WHERE scope_type = 'project' AND scope_id = $1 AND artifact_type = 'project_index'
     ORDER BY updated_at DESC, id DESC
     FOR UPDATE`,
    [projectId]
  );
  const sourceKey = `project_index:${projectId}`;
  const existing = rows.rows.find((row) => parseJson(row.source_json, {}).source_key === sourceKey);
  let result;
  let eventType;
  if (existing) {
    result = await client.query(
      `UPDATE artifacts
       SET title = $1, content_markdown = $2, content_json = $3, status = 'ready',
           source_json = $4, model_provider_id = '', model = '', input_hash = $5, updated_at = $6
       WHERE id = $7 RETURNING *`,
      [document.title, document.markdown, toJson(document.content), toJson(document.source), document.input_hash, now, existing.id]
    );
    eventType = SERVER_EVENTS.ARTIFACT_UPDATED;
  } else {
    result = await client.query(
      `INSERT INTO artifacts(
         scope_type, scope_id, artifact_type, title, content_markdown, content_json,
         status, source_json, model_provider_id, model, input_hash, created_at, updated_at
       ) VALUES ('project', $1, 'project_index', $2, $3, $4, 'ready', $5, '', '', $6, $7, $7)
       RETURNING *`,
      [projectId, document.title, document.markdown, toJson(document.content), toJson(document.source), document.input_hash, now]
    );
    eventType = SERVER_EVENTS.ARTIFACT_CREATED;
  }
  return { artifact: artifactPayload(result.rows[0]), eventType };
}

async function enqueueArtifactIndex(client, artifact, now) {
  const digest = artifactIndexContentHash(artifact.title, artifact.content_markdown);
  const active = await client.query(
    `SELECT id, status, payload_json FROM worker_jobs
     WHERE job_type = 'artifact-index' AND status IN ('queued', 'running')
       AND (payload_json::jsonb ->> 'artifact_id') = $1
     ORDER BY id DESC FOR UPDATE`,
    [String(artifact.id)]
  );
  const exact = active.rows.find((row) => parseJson(row.payload_json, {}).content_hash === digest);
  if (exact) return { queued: false, deduplicated: true, worker_job_id: Number(exact.id), artifact_id: artifact.id };
  const queued = active.rows.find((row) => row.status === "queued");
  const payload = {
    command: "artifact-index",
    source: "artifact-lifecycle",
    args: [],
    artifact_id: artifact.id,
    action: "index",
    content_hash: digest,
    model: ""
  };
  if (queued) {
    await client.query(
      "UPDATE worker_jobs SET payload_json = $1, updated_at = $2 WHERE id = $3",
      [toJson(payload), now, queued.id]
    );
    return { queued: true, reused: true, superseded: true, worker_job_id: Number(queued.id), artifact_id: artifact.id };
  }
  const created = await enqueueWorkerJobInTransaction(client, {
    jobType: "artifact-index",
    payload,
    priority: 15,
    maxAttempts: 3,
    message: "artifact-index queued",
    now
  });
  return { queued: true, worker_job_id: created.worker_job.id, artifact_id: artifact.id };
}

async function enqueueArtifactExport(client, artifact, relativePath, now) {
  const payload = {
    command: "artifact-export-obsidian",
    source: "artifact-export",
    args: [String(artifact.id)],
    artifact_id: artifact.id,
    body: { relative_path: text(relativePath).trim() }
  };
  const active = await client.query(
    `SELECT id, status, payload_json FROM worker_jobs
     WHERE job_type = 'artifact-export-obsidian' AND status IN ('queued', 'running')
       AND (payload_json::jsonb ->> 'artifact_id') = $1
     ORDER BY id DESC FOR UPDATE`,
    [String(artifact.id)]
  );
  const duplicate = active.rows.find((row) => {
    const existing = parseJson(row.payload_json, {});
    const body = existing.body && typeof existing.body === "object" ? existing.body : existing;
    return text(body.relative_path).trim() === text(relativePath).trim();
  });
  if (duplicate) {
    return { queued: false, deduplicated: true, worker_job_id: Number(duplicate.id), artifact_id: artifact.id };
  }
  const queued = active.rows.find((row) => row.status === "queued");
  if (queued) {
    await client.query(
      "UPDATE worker_jobs SET payload_json = $1, updated_at = $2 WHERE id = $3",
      [toJson(payload), now, queued.id]
    );
    return { queued: true, reused: true, superseded: true, worker_job_id: Number(queued.id), artifact_id: artifact.id };
  }
  const created = await enqueueWorkerJobInTransaction(client, {
    jobType: "artifact-export-obsidian",
    payload,
    priority: 10,
    maxAttempts: 1,
    message: "artifact-export-obsidian queued",
    now
  });
  return { queued: true, worker_job_id: created.worker_job.id, artifact_id: artifact.id };
}

export async function ensureProjectIndex(projectId, {
  exportToObsidian = false,
  relativePath = ""
} = {}) {
  const id = Number(projectId);
  return withTransaction(async (client) => {
    const now = new Date().toISOString();
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [PROJECT_INDEX_LOCK_NAMESPACE, id]);
    const inputs = await loadProjectIndexInputs(client, id);
    const document = buildProjectIndexDocument(inputs);
    const { artifact, eventType } = await upsertProjectIndexArtifact(client, id, document, now);
    await insertAppEvent(eventType, {
      artifact: {
        artifact_id: artifact.id,
        id: artifact.id,
        artifact_type: artifact.artifact_type,
        title: artifact.title,
        scope_type: artifact.scope_type,
        scope_id: artifact.scope_id,
        status: artifact.status,
        updated_at: artifact.updated_at
      },
      artifact_id: artifact.id,
      project_id: id,
      reason: "project_index"
    }, { client, createdAt: now });
    const indexJob = await enqueueArtifactIndex(client, artifact, now);
    const exportJob = exportToObsidian
      ? await enqueueArtifactExport(client, artifact, relativePath, now)
      : null;
    return { artifact, artifact_event: eventType, index_job: indexJob, export_job: exportJob };
  });
}
