import { randomUUID } from "node:crypto";

import { ConflictError, NotFoundError, ValidationError, parseJson, toJson, withTransaction } from "./db.js";
import { SERVER_EVENTS, compactTaskEventPayload } from "./events.js";
import { insertAppEvent } from "./outbox.js";
import { getAppSettings, resolvePaperReaderPrompt } from "./settings.js";
import { enqueueWorkerJobInTransaction } from "./workerQueue.js";

const PAPER_REPORT_ARTIFACT_TYPE = "paper_report";
const PAPER_READER_ANALYSIS_SYSTEM = "You are a research document reading assistant. Read the supplied cleaned document text and answer accurately from it.";
const PAPER_REPORT_LOCK_NAMESPACE = 724023;
const ACTIVE_JOB_STATUSES = ["queued", "running"];

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function positiveId(value, field = "paper_id") {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) throw new ValidationError(`${field} must be a positive integer`);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidationError(`${field} must be a positive integer`);
  return parsed;
}

export function paperReportConcurrencyKey(paperId) {
  return `paper:${positiveId(paperId)}:report`;
}

function reportContent(row) {
  return parseJson(row?.content_json, {});
}

function reportSource(row) {
  return parseJson(row?.source_json, {});
}

function reportPayload(row, paperId) {
  if (!row || row.status === "removed") return null;
  const content = reportContent(row);
  return {
    paper_id: Number(paperId),
    artifact_id: Number(row.id),
    status: row.status,
    prompt: content.prompt || "",
    system_prompt: content.system_prompt || "",
    model_provider_id: row.model_provider_id || "",
    model: row.model || "",
    source_project_ids: Array.isArray(content.source_project_ids) ? content.source_project_ids.map(Number).filter(Boolean) : [],
    report_markdown: row.content_markdown || "",
    error_message: content.error_message || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: content.started_at ?? null,
    finished_at: content.finished_at ?? null
  };
}

async function lockPaper(client, paperId) {
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [PAPER_REPORT_LOCK_NAMESPACE, paperId]);
}

async function paperRow(client, paperId) {
  const result = await client.query(
    `SELECT p.id, p.title, p.arxiv_id,
            COALESCE(source.source_url, '') AS link
     FROM papers p
     LEFT JOIN LATERAL (
       SELECT ps.source_url FROM paper_sources ps
       WHERE ps.paper_id = p.id ORDER BY ps.updated_at DESC, ps.id DESC LIMIT 1
     ) source ON TRUE
     WHERE p.id = $1`,
    [paperId]
  );
  if (!result.rows[0]) throw new NotFoundError(`Paper not found: ${paperId}`);
  return result.rows[0];
}

async function reportArtifactRow(client, paperId, { forUpdate = true } = {}) {
  const result = await client.query(
    `SELECT * FROM artifacts
     WHERE scope_type = 'paper' AND scope_id = $1 AND artifact_type = $2
     ORDER BY updated_at DESC, id DESC
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [paperId, PAPER_REPORT_ARTIFACT_TYPE]
  );
  return result.rows[0] || null;
}

async function sourceProjectIds(client, paperId) {
  const result = await client.query(
    `SELECT r.project_id
     FROM project_paper_recommendations r
     JOIN research_projects p ON p.id = r.project_id
     WHERE r.paper_id = $1 AND r.state IN ('pending', 'accepted')
       AND p.status NOT IN ('paused', 'archived')
     ORDER BY r.project_id`,
    [paperId]
  );
  return result.rows.map((row) => Number(row.project_id));
}

async function activeReportJobs(client, paperId) {
  const key = paperReportConcurrencyKey(paperId);
  const result = await client.query(
    `SELECT id, job_run_id, job_type, status, payload_json, created_at, updated_at,
            started_at, finished_at, error_message
     FROM worker_jobs
     WHERE job_type = 'paper-report' AND status = ANY($1::text[])
       AND (
         (payload_json::jsonb ->> 'dedupe_key') = $2
         OR (payload_json::jsonb ->> 'paper_id') = $3
       )
     ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, id DESC
     FOR UPDATE`,
    [ACTIVE_JOB_STATUSES, key, String(paperId)]
  );
  return result.rows;
}

function paperReportEventPayload(paperId, artifact, status, extra = {}) {
  return {
    paper: {
      paper_id: paperId,
      id: paperId,
      report_status: status,
      updated_at: artifact?.updated_at || null
    },
    paper_report: artifact ? reportPayload(artifact, paperId) : null,
    paper_id: paperId,
    artifact_id: artifact ? Number(artifact.id) : null,
    status,
    project_ids: [],
    ...extra
  };
}

async function publishReportEvent(client, paperId, artifact, status, now, extra = {}) {
  await insertAppEvent(
    SERVER_EVENTS.PAPER_REPORT_UPDATED,
    paperReportEventPayload(paperId, artifact, status, extra),
    { client, createdAt: now }
  );
}

async function saveQueuedArtifact(client, paper, existing, {
  prompt,
  projectIds,
  generationId,
  now
}) {
  const oldContent = reportContent(existing);
  const oldSource = reportSource(existing);
  const content = {
    paper_id: Number(paper.id),
    arxiv_id: paper.arxiv_id || "",
    link: paper.link || "",
    prompt,
    system_prompt: PAPER_READER_ANALYSIS_SYSTEM,
    source_project_ids: projectIds,
    generation_id: generationId,
    error_message: "",
    started_at: null,
    finished_at: null
  };
  const sourceTextHash = oldSource.source_text_hash || existing?.input_hash || "";
  const source = {
    ...oldSource,
    source_key: `paper_report:${Number(paper.id)}`,
    generated_from: "paper_report_job",
    source_text_hash: sourceTextHash
  };
  if (existing) {
    const result = await client.query(
      `UPDATE artifacts
       SET title = $1, content_markdown = '', content_json = $2, status = 'queued',
           source_json = $3, model_provider_id = '', model = '', input_hash = $4,
           updated_at = $5
       WHERE id = $6 RETURNING *`,
      [paper.title || `Paper ${paper.id} Full Report`, toJson(content), toJson(source), sourceTextHash, now, existing.id]
    );
    return result.rows[0];
  }
  const result = await client.query(
    `INSERT INTO artifacts(
       scope_type, scope_id, artifact_type, title, content_markdown, content_json,
       status, source_json, model_provider_id, model, input_hash, created_at, updated_at
     ) VALUES ('paper', $1, $2, $3, '', $4, 'queued', $5, '', '', $6, $7, $7)
     RETURNING *`,
    [paper.id, PAPER_REPORT_ARTIFACT_TYPE, paper.title || `Paper ${paper.id} Full Report`, toJson(content), toJson(source), sourceTextHash, now]
  );
  return result.rows[0];
}

async function materializeOneInTransaction(client, paperId, {
  prompt,
  body = {},
  force = false,
  source = "paper-report",
  projectIds = null,
  now = nowIso()
} = {}) {
  const id = positiveId(paperId);
  await lockPaper(client, id);
  const paper = await paperRow(client, id);
  let existing = await reportArtifactRow(client, id);
  let active = await activeReportJobs(client, id);
  if (active.length > 1) {
    const keeper = active.find((row) => row.status === "running") || active[0];
    const surplus = active.filter((row) => Number(row.id) !== Number(keeper.id));
    for (const row of surplus) {
      const cancelled = await client.query(
        `UPDATE worker_jobs
         SET status = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, $1),
             cancel_reason = CASE WHEN cancel_reason = '' THEN $2 ELSE cancel_reason END,
             locked_by = '', locked_at = NULL, finished_at = $1, updated_at = $1
         WHERE id = $3 AND status = ANY($4::text[]) RETURNING *`,
        [now, "Duplicate legacy paper-report job", row.id, ACTIVE_JOB_STATUSES]
      );
      if (!cancelled.rows[0]) continue;
      const eventJob = {
        ...cancelled.rows[0],
        payload: parseJson(cancelled.rows[0].payload_json, {})
      };
      await insertAppEvent(
        SERVER_EVENTS.TASK_CANCELLED,
        compactTaskEventPayload(eventJob, {
          status: "cancelled",
          message: "Duplicate legacy paper-report job"
        }),
        { client, createdAt: now }
      );
    }
    active = [keeper];
  }
  if (existing && projectIds !== null) {
    const content = reportContent(existing);
    const previousIds = Array.isArray(content.source_project_ids)
      ? [...new Set(content.source_project_ids.map(Number).filter(Boolean))].sort((a, b) => a - b)
      : [];
    const nextIds = [...new Set(projectIds.map(Number).filter(Boolean))].sort((a, b) => a - b);
    if (previousIds.length !== nextIds.length || previousIds.some((value, index) => value !== nextIds[index])) {
      const refreshed = await client.query(
        "UPDATE artifacts SET content_json = $1, updated_at = $2 WHERE id = $3 RETURNING *",
        [toJson({ ...content, source_project_ids: nextIds }), now, existing.id]
      );
      existing = refreshed.rows[0];
      await publishReportEvent(client, id, existing, existing.status, now, { action: "recommendation_sources_refreshed" });
    }
  }
  const running = active.find((row) => row.status === "running");
  const queued = active.find((row) => row.status === "queued");

  async function normalizeLegacyActiveJob(row) {
    if (!row) return null;
    const currentPayload = parseJson(row.payload_json, {});
    const key = paperReportConcurrencyKey(id);
    if (currentPayload.dedupe_key === key && currentPayload.concurrency_key === key) return currentPayload;
    const normalized = {
      command: "paper-report",
      source: currentPayload.source || source,
      args: Array.isArray(currentPayload.args) ? currentPayload.args : [String(id)],
      ...currentPayload,
      paper_id: id,
      concurrency_key: key,
      dedupe_key: key
    };
    await client.query("UPDATE worker_jobs SET payload_json = $1, updated_at = $2 WHERE id = $3", [toJson(normalized), now, row.id]);
    return normalized;
  }

  if (running) {
    const runningPayload = await normalizeLegacyActiveJob(running);
    let runningArtifact = existing;
    if (!runningArtifact) {
      const generationId = runningPayload.generation_id || randomUUID();
      runningPayload.generation_id = generationId;
      await client.query("UPDATE worker_jobs SET payload_json = $1, updated_at = $2 WHERE id = $3", [toJson(runningPayload), now, running.id]);
      runningArtifact = await saveQueuedArtifact(client, paper, null, {
        prompt: text(prompt) || text(runningPayload?.body?.prompt),
        projectIds: projectIds || await sourceProjectIds(client, id),
        generationId,
        now
      });
      await publishReportEvent(client, id, runningArtifact, "queued", now, {
        action: "legacy_running_materialized",
        worker_job_id: Number(running.id),
        generation_id: generationId
      });
    }
    return {
      created: false,
      deduplicated: true,
      worker_job_id: Number(running.id),
      artifact: reportPayload(runningArtifact, id),
      paper_report: reportPayload(runningArtifact, id),
      queued: true,
      status: existing?.status || "processing"
    };
  }
  const queuedPayload = queued ? parseJson(queued.payload_json, {}) : {};
  const existingGeneration = text(reportContent(existing).generation_id);
  if (queued && existing?.status === "queued" && existingGeneration
      && queuedPayload.generation_id === existingGeneration && !force) {
    await normalizeLegacyActiveJob(queued);
    return {
      created: false,
      deduplicated: true,
      worker_job_id: Number(queued.id),
      artifact: reportPayload(existing, id),
      paper_report: reportPayload(existing, id),
      queued: true,
      status: existing?.status || "queued"
    };
  }
  if (existing && existing.status !== "queued" && !force) {
    return {
      created: false,
      deduplicated: true,
      worker_job_id: null,
      artifact: reportPayload(existing, id),
      paper_report: reportPayload(existing, id),
      queued: false,
      status: existing.status
    };
  }

  const generationId = randomUUID();
  const content = reportContent(existing);
  const ids = projectIds || (Array.isArray(content.source_project_ids) && content.source_project_ids.length
    ? content.source_project_ids.map(Number).filter(Boolean)
    : await sourceProjectIds(client, id));
  const artifact = await saveQueuedArtifact(client, paper, existing, {
    prompt: text(prompt) || text(content.prompt),
    projectIds: ids,
    generationId,
    now
  });
  const key = paperReportConcurrencyKey(id);
  const payload = {
    command: "paper-report",
    source,
    args: [String(id)],
    paper_id: id,
    generation_id: generationId,
    concurrency_key: key,
    dedupe_key: key,
    force: Boolean(force),
    body: { ...body, prompt: text(prompt) || text(body.prompt), force: Boolean(force) }
  };
  let workerJobId;
  let created = false;
  if (queued) {
    await client.query(
      `UPDATE worker_jobs
       SET payload_json = $1, priority = GREATEST(priority, 10), updated_at = $2,
           cancel_requested_at = NULL, cancel_reason = ''
       WHERE id = $3`,
      [toJson(payload), now, queued.id]
    );
    workerJobId = Number(queued.id);
  } else {
    const enqueued = await enqueueWorkerJobInTransaction(client, {
      jobType: "paper-report",
      payload,
      priority: 10,
      maxAttempts: 2,
      message: `paper-report queued for paper ${id}`,
      now
    });
    workerJobId = Number(enqueued.worker_job.id);
    created = true;
  }
  await publishReportEvent(client, id, artifact, "queued", now, {
    action: existing ? "retry" : "create",
    worker_job_id: workerJobId,
    generation_id: generationId
  });
  return {
    created,
    deduplicated: !created,
    worker_job_id: workerJobId,
    artifact: reportPayload(artifact, id),
    paper_report: reportPayload(artifact, id),
    queued: true,
    status: "queued"
  };
}

async function resolvedPrompt(payload = {}) {
  const settingsData = await getAppSettings();
  return resolvePaperReaderPrompt(settingsData.settings || {}, {
    locale: payload.locale,
    prompt: payload.prompt
  });
}

export async function enqueuePaperReport(paperId, payload = {}, { source = "paper-report" } = {}) {
  const prompt = await resolvedPrompt(payload);
  const result = await withTransaction((client) => materializeOneInTransaction(client, paperId, {
    prompt,
    body: payload,
    force: Boolean(payload.force),
    source
  }));
  const workerJobId = result.worker_job_id || null;
  return {
    ok: true,
    command: "paper-report",
    source,
    job_id: workerJobId,
    worker_job_id: workerJobId,
    job_run_id: null,
    worker_job: workerJobId ? {
      id: workerJobId,
      job_run_id: null,
      job_type: "paper-report",
      status: result.status === "processing" ? "running" : "queued"
    } : null,
    ...result
  };
}

async function eligibleRecommendedPapers(client) {
  const result = await client.query(
    `SELECT r.paper_id,
            ARRAY_AGG(DISTINCT r.project_id ORDER BY r.project_id) AS project_ids,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.source_arxiv_paper_id), NULL) AS source_paper_ids
     FROM project_paper_recommendations r
     JOIN research_projects p ON p.id = r.project_id
     WHERE r.state IN ('pending', 'accepted') AND p.status NOT IN ('paused', 'archived')
     GROUP BY r.paper_id ORDER BY r.paper_id`
  );
  return result.rows.map((row) => ({
    paperId: Number(row.paper_id),
    projectIds: row.project_ids.map(Number),
    sourcePaperIds: (row.source_paper_ids || []).map(Number).filter(Boolean)
  }));
}

export async function materializeRecommendedPaperReports({ paperIds = null, source = "paper-report-materializer" } = {}) {
  const prompt = await resolvedPrompt({});
  const selected = paperIds === null ? null : new Set(paperIds.map((value) => positiveId(value)));
  return withTransaction(async (client) => {
    const eligible = (await eligibleRecommendedPapers(client)).filter((item) => (
      !selected || selected.has(item.paperId) || item.sourcePaperIds.some((id) => selected.has(id))
    ));
    let created = 0;
    let deduplicated = 0;
    for (const item of eligible) {
      const result = await materializeOneInTransaction(client, item.paperId, {
        prompt,
        projectIds: item.projectIds,
        source
      });
      if (result.created) created += 1;
      else deduplicated += 1;
    }
    return {
      ok: true,
      paper_reports_candidates: eligible.length,
      paper_reports_created: created,
      paper_reports_deduplicated: deduplicated,
      created,
      deduplicated
    };
  });
}

export async function materializeLegacyQueuedPaperReports() {
  const prompt = await resolvedPrompt({});
  return withTransaction(async (client) => {
    const now = nowIso();
    const legacyPumps = await client.query(
      `UPDATE worker_jobs
       SET status = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, $1),
           cancel_reason = CASE WHEN cancel_reason = '' THEN $2 ELSE cancel_reason END,
           locked_by = '', locked_at = NULL, finished_at = $1, updated_at = $1
       WHERE job_type = 'generate-paper-reports' AND status IN ('queued', 'running')
       RETURNING *`,
      [now, "Replaced by per-paper report jobs"]
    );
    for (const row of legacyPumps.rows) {
      if (row.job_run_id) {
        await client.query(
          `UPDATE job_runs SET status = 'cancelled', finished_at = $1,
             message = $2, heartbeat_at = $1 WHERE id = $3`,
          [now, "Replaced by per-paper report jobs", row.job_run_id]
        );
      }
      const eventJob = { ...row, payload: parseJson(row.payload_json, {}) };
      await insertAppEvent(
        SERVER_EVENTS.TASK_CANCELLED,
        compactTaskEventPayload(eventJob, {
          status: "cancelled",
          message: "Replaced by per-paper report jobs",
          migration: true
        }),
        { client, createdAt: now }
      );
    }
    const rows = await client.query(
      `SELECT DISTINCT candidates.paper_id
       FROM (
         SELECT a.scope_id AS paper_id
         FROM artifacts a
         WHERE a.scope_type = 'paper' AND a.artifact_type = $1 AND a.status = 'queued'
         UNION ALL
         SELECT (wj.payload_json::jsonb ->> 'paper_id')::bigint AS paper_id
         FROM worker_jobs wj
         WHERE wj.job_type = 'paper-report' AND wj.status = 'queued'
           AND (wj.payload_json::jsonb ->> 'paper_id') ~ '^[1-9][0-9]*$'
       ) candidates
       ORDER BY candidates.paper_id`,
      [PAPER_REPORT_ARTIFACT_TYPE]
    );
    let created = 0;
    let deduplicated = 0;
    for (const row of rows.rows) {
      const result = await materializeOneInTransaction(client, Number(row.paper_id), {
        prompt: text(reportContent(await reportArtifactRow(client, Number(row.paper_id), { forUpdate: false })).prompt) || prompt,
        source: "paper-report-legacy-scanner"
      });
      if (result.created) created += 1;
      else deduplicated += 1;
    }
    return {
      scanned: rows.rows.length,
      created,
      deduplicated,
      legacy_pump_jobs_cancelled: legacyPumps.rows.length
    };
  });
}

async function cancelActiveJobs(client, paperId, now, reason) {
  const rows = await activeReportJobs(client, paperId);
  const results = [];
  for (const row of rows) {
    if (row.status === "queued") {
      const updated = await client.query(
        `UPDATE worker_jobs
         SET status = 'cancelled', cancel_requested_at = $1, cancel_reason = $2,
             finished_at = $1, updated_at = $1
         WHERE id = $3 AND status = 'queued' RETURNING *`,
        [now, reason, row.id]
      );
      if (updated.rows[0]) {
        const eventJob = { ...updated.rows[0], payload: parseJson(updated.rows[0].payload_json, {}) };
        await insertAppEvent(SERVER_EVENTS.TASK_CANCELLED,
          compactTaskEventPayload(eventJob, { status: "cancelled", message: reason }),
          { client, createdAt: now });
        results.push({ id: Number(row.id), cancelled: true });
      }
    } else {
      const updated = await client.query(
        `UPDATE worker_jobs
         SET cancel_requested_at = COALESCE(cancel_requested_at, $1),
             cancel_reason = CASE WHEN cancel_reason = '' THEN $2 ELSE cancel_reason END,
             updated_at = $1
         WHERE id = $3 AND status = 'running' RETURNING *`,
        [now, reason, row.id]
      );
      if (updated.rows[0]) {
        const eventJob = { ...updated.rows[0], payload: parseJson(updated.rows[0].payload_json, {}) };
        await insertAppEvent(SERVER_EVENTS.TASK_CANCEL_REQUESTED,
          compactTaskEventPayload(eventJob, { status: "cancel_requested", message: reason }),
          { client, createdAt: now });
        results.push({ id: Number(row.id), cancellation_requested: true });
      }
    }
  }
  return results;
}

export async function cancelPaperReport(paperId, { remove = false } = {}) {
  const id = positiveId(paperId);
  return withTransaction(async (client) => {
    const now = nowIso();
    await lockPaper(client, id);
    const artifact = await reportArtifactRow(client, id);
    if (!artifact || artifact.status === "removed") {
      if (remove) return { ok: true, paper_id: id, paper_reports_removed: 0 };
      throw new NotFoundError("Report queue item was not found");
    }
    if (!remove && !["queued", "processing"].includes(artifact.status)) return { ok: true, paper_id: id, paper_report: reportPayload(artifact, id) };
    const reason = remove ? "Paper report removed" : "Paper report cancelled";
    const jobs = await cancelActiveJobs(client, id, now, reason);
    if (artifact.status === "processing" && jobs.length === 0) {
      throw new ConflictError("Paper report generation is currently running outside the worker queue");
    }
    const content = {
      ...reportContent(artifact),
      error_message: "",
      finished_at: now
    };
    const status = remove ? "removed" : "cancelled";
    const updated = await client.query(
      `UPDATE artifacts SET status = $1, content_json = $2, updated_at = $3 WHERE id = $4 RETURNING *`,
      [status, toJson(content), now, artifact.id]
    );
    await publishReportEvent(client, id, updated.rows[0], status, now, { action: remove ? "delete" : "cancel" });
    return {
      ok: true,
      paper_id: id,
      artifact_id: Number(artifact.id),
      paper_report: remove ? null : reportPayload(updated.rows[0], id),
      paper_reports_removed: remove ? 1 : 0,
      paper_reports_cancelled: remove ? 0 : 1,
      worker_jobs: jobs
    };
  });
}

export async function reconcilePaperReportRecommendationsInTransaction(client, paperId) {
  const id = positiveId(paperId);
  const now = nowIso();
  await lockPaper(client, id);
  const artifact = await reportArtifactRow(client, id);
  if (!artifact || artifact.status === "removed") {
    return { paper_reports_removed: 0, paper_reports_refreshed: 0 };
  }
  const remainingProjectIds = await sourceProjectIds(client, id);
  const content = reportContent(artifact);
  if (remainingProjectIds.length) {
    const updated = await client.query(
      "UPDATE artifacts SET content_json = $1, updated_at = $2 WHERE id = $3 RETURNING *",
      [toJson({ ...content, source_project_ids: remainingProjectIds }), now, artifact.id]
    );
    await publishReportEvent(client, id, updated.rows[0], artifact.status, now, { action: "recommendation_state" });
    return { paper_reports_removed: 0, paper_reports_refreshed: 1 };
  }
  const paper = await paperRow(client, id);
  const sourceResult = await client.query(
    `SELECT COALESCE(ps.source_type, '') AS source_type
     FROM paper_sources ps WHERE ps.paper_id = $1
     ORDER BY ps.updated_at DESC, ps.id DESC LIMIT 1`,
    [id]
  );
  const sourceType = text(sourceResult.rows[0]?.source_type).toLowerCase();
  const oldProjectIds = Array.isArray(content.source_project_ids) ? content.source_project_ids : [];
  if (["upload", "url", "web", "manual"].includes(sourceType) || text(paper.arxiv_id).startsWith("reader-") || !oldProjectIds.length) {
    return { paper_reports_removed: 0, paper_reports_refreshed: 0 };
  }
  await cancelActiveJobs(client, id, now, "Paper report recommendation removed");
  const updatedContent = { ...content, error_message: "", finished_at: now };
  const updated = await client.query(
    "UPDATE artifacts SET status = 'removed', content_json = $1, updated_at = $2 WHERE id = $3 RETURNING *",
    [toJson(updatedContent), now, artifact.id]
  );
  await publishReportEvent(client, id, updated.rows[0], "removed", now, { action: "recommendation_state" });
  return { paper_reports_removed: 1, paper_reports_refreshed: 0 };
}
