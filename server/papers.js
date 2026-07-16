import { createHash } from "node:crypto";

import { NotFoundError, ValidationError, maybeOne, parseJson, query, toJson, withTransaction } from "./db.js";
import { DEFAULT_PAPER_READER_PROMPT } from "./settings.js";
import { ensureLibraryPaperIdForLegacyPaper, getReaderPaperDetail } from "./reader.js";

const PAPER_REPORT_ARTIFACT_TYPE = "paper_report";
const PAPER_READER_ANALYSIS_SYSTEM = "You are a research paper reading assistant. Read the supplied full PDF text and answer accurately from it.";
const REPORT_RELATIONS = ["direct", "indirect"];
const REPORT_CONFIDENCE_THRESHOLD = 0.65;
const REPORT_USEFULNESS_THRESHOLD = 0.6;
const VALID_FEEDBACK = new Set(["read_later", "favorite", "read", "not_relevant"]);
const VALID_IMPORTANCE = new Set(["high", "medium", "low"]);

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function positiveId(value, field = "id") {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) throw new ValidationError(`${field} must be a positive integer`);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ValidationError(`${field} must be a positive integer`);
  return parsed;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntegerList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
}

function reportContent(row) {
  const content = parseJson(row?.content_json, {});
  return content && typeof content === "object" && !Array.isArray(content) ? content : {};
}

function reportSource(row) {
  const source = parseJson(row?.source_json, {});
  return source && typeof source === "object" && !Array.isArray(source) ? source : {};
}

function sourceProjectIdsFromContent(content) {
  return parseIntegerList(content?.source_project_ids);
}

function contentHash(markdown, content) {
  return createHash("sha256")
    .update(text(markdown))
    .update("\n")
    .update(toJson(content))
    .digest("hex");
}

function readingStateForStatus(status, existing = "") {
  if (status === "reading") return "reading";
  if (status === "read") return "read";
  if (status === "candidate" || status === "saved") return "unread";
  return text(existing) || "unread";
}

async function legacyPaper(db, legacyPaperId) {
  const result = await db.query("SELECT * FROM arxiv_papers WHERE id = $1", [Number(legacyPaperId)]);
  const row = maybeOne(result);
  if (!row) throw new NotFoundError(`Paper not found: ${legacyPaperId}`);
  return row;
}

async function reportArtifactRow(db, legacyPaperId, libraryPaperId) {
  if (!libraryPaperId) return null;
  const result = await db.query(
    `
      SELECT *
      FROM artifacts
      WHERE scope_type = 'paper'
        AND scope_id = $1
        AND artifact_type = $2
      ORDER BY
        CASE WHEN source_json::jsonb ->> 'source_key' = $3 THEN 0 ELSE 1 END,
        updated_at DESC,
        id DESC
      LIMIT 1
    `,
    [Number(libraryPaperId), PAPER_REPORT_ARTIFACT_TYPE, `paper_report:${Number(legacyPaperId)}`]
  );
  return maybeOne(result);
}

async function sourceProjectsForRecommendedPapers(db, paperIds = null) {
  const normalizedIds = paperIds === null ? null : parseIntegerList(paperIds);
  const result = await db.query(
    `
      SELECT r.paper_id, r.project_id
      FROM project_paper_recommendations r
      JOIN research_projects rp ON rp.id = r.project_id
      WHERE r.state IN ('pending', 'accepted')
        AND rp.status NOT IN ('paused', 'archived')
        AND ($1::bigint[] IS NULL OR r.paper_id = ANY($1::bigint[]))
      ORDER BY r.paper_id, r.project_id
    `,
    [normalizedIds && normalizedIds.length ? normalizedIds : null]
  );
  const projectsByPaper = new Map();
  for (const row of result.rows || []) {
    const paperId = Number(row.paper_id);
    const projects = projectsByPaper.get(paperId) || [];
    projects.push(Number(row.project_id));
    projectsByPaper.set(paperId, projects);
  }
  return projectsByPaper;
}

async function savePaperReportState(db, state) {
  const content = {
    paper_id: Number(state.library_paper_id),
    legacy_arxiv_paper_id: Number(state.paper_id),
    arxiv_id: state.arxiv_id || "",
    link: state.link || "",
    prompt: state.prompt || "",
    system_prompt: state.system_prompt || "",
    source_project_ids: state.source_project_ids || [],
    error_message: state.error_message || "",
    started_at: state.started_at ?? null,
    finished_at: state.finished_at ?? null
  };
  const source = {
    source_key: `paper_report:${Number(state.paper_id)}`,
    generated_from: "paper_report_queue",
    legacy_arxiv_paper_id: Number(state.paper_id),
    source_text_hash: state.source_text_hash || ""
  };
  const markdown = state.report_markdown || "";
  const now = nowIso();
  const inputHash = state.source_text_hash || contentHash(markdown, content);
  if (state.artifact_id) {
    await db.query(
      `
        UPDATE artifacts
        SET title = $1,
            content_markdown = $2,
            content_json = $3,
            status = $4,
            source_json = $5,
            model_provider_id = $6,
            model = $7,
            input_hash = $8,
            updated_at = $9
        WHERE id = $10
      `,
      [
        text(state.title) || `Paper ${Number(state.paper_id)} Full Report`,
        markdown,
        toJson(content),
        text(state.status) || "queued",
        toJson(source),
        state.model_provider_id || "",
        state.model || "",
        inputHash,
        now,
        Number(state.artifact_id)
      ]
    );
    return Number(state.artifact_id);
  }
  const inserted = await db.query(
    `
      INSERT INTO artifacts(
        scope_type, scope_id, artifact_type, title, content_markdown,
        content_json, status, source_json, model_provider_id, model,
        input_hash, created_at, updated_at
      )
      VALUES ('paper', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      RETURNING id
    `,
    [
      Number(state.library_paper_id),
      PAPER_REPORT_ARTIFACT_TYPE,
      text(state.title) || `Paper ${Number(state.paper_id)} Full Report`,
      markdown,
      toJson(content),
      text(state.status) || "queued",
      toJson(source),
      state.model_provider_id || "",
      state.model || "",
      inputHash,
      now
    ]
  );
  return Number(inserted.rows[0].id);
}

async function setLegacyPaperLibraryStatus(db, legacyPaperId, status) {
  const paper = await legacyPaper(db, legacyPaperId);
  const libraryPaperId = await ensureLibraryPaperIdForLegacyPaper(db, paper);
  const existing = await db.query("SELECT reading_state, saved_at, last_read_at FROM papers WHERE id = $1", [libraryPaperId]);
  const existingRow = maybeOne(existing) || {};
  const now = nowIso();
  const savedAt = ["saved", "reading", "read"].includes(status) && !existingRow.saved_at ? now : existingRow.saved_at;
  const lastReadAt = status === "read" ? now : existingRow.last_read_at;
  const readingState = readingStateForStatus(status, existingRow.reading_state);
  await db.query(
    `
      UPDATE papers
      SET library_status = $1,
          reading_state = $2,
          saved_at = $3,
          last_read_at = $4,
          updated_at = $5
      WHERE id = $6
    `,
    [status, readingState, savedAt, lastReadAt, now, libraryPaperId]
  );
  return { ok: true, paper_id: libraryPaperId, library_status: status, reading_state: readingState };
}

async function acceptRecommendationsForPaper(db, paperId, projectIds, importance) {
  if (!VALID_IMPORTANCE.has(importance)) throw new ValidationError("importance must be high, medium, or low");
  const selectedIds = parseIntegerList(projectIds);
  if (!selectedIds.length) throw new ValidationError("At least one project must be selected");
  await legacyPaper(db, paperId);
  const found = await db.query(
    `
      SELECT project_id
      FROM project_paper_recommendations
      WHERE paper_id = $1
        AND project_id = ANY($2::bigint[])
        AND state != 'discarded'
    `,
    [Number(paperId), selectedIds]
  );
  const foundIds = new Set((found.rows || []).map((row) => Number(row.project_id)));
  const missing = selectedIds.filter((projectId) => !foundIds.has(projectId));
  if (missing.length) throw new ValidationError(`Recommendation not found for project(s): ${missing.join(", ")}`);
  const now = nowIso();
  await db.query(
    `
      UPDATE project_paper_recommendations
      SET state = 'accepted',
          importance = $1,
          updated_at = $2
      WHERE paper_id = $3
        AND project_id = ANY($4::bigint[])
    `,
    [importance, now, Number(paperId), selectedIds]
  );
  await db.query(
    `
      UPDATE project_paper_recommendations
      SET state = 'discarded',
          updated_at = $1
      WHERE paper_id = $2
        AND state = 'pending'
        AND NOT (project_id = ANY($3::bigint[]))
    `,
    [now, Number(paperId), selectedIds]
  );
  for (const projectId of selectedIds) {
    await db.query(
      `
        INSERT INTO project_papers(project_id, paper_id, relation, note, created_at, updated_at)
        VALUES ($1, $2, 'reading', 'accepted_from_recommendation', $3, $3)
        ON CONFLICT(project_id, paper_id) DO UPDATE SET
          relation = CASE
            WHEN project_papers.relation = 'candidate' THEN excluded.relation
            ELSE project_papers.relation
          END,
          note = CASE
            WHEN project_papers.note = 'auto_matched_by_project_context' THEN excluded.note
            ELSE project_papers.note
          END,
          updated_at = excluded.updated_at
      `,
      [projectId, Number(paperId), now]
    );
  }
}

async function discardRecommendationsForPaper(db, paperId, projectIds = null) {
  await legacyPaper(db, paperId);
  const selectedIds = projectIds === null ? null : parseIntegerList(projectIds);
  const now = nowIso();
  if (selectedIds && selectedIds.length) {
    await db.query(
      `
        UPDATE project_paper_recommendations
        SET state = 'discarded',
            updated_at = $1
        WHERE paper_id = $2
          AND state = 'pending'
          AND project_id = ANY($3::bigint[])
      `,
      [now, Number(paperId), selectedIds]
    );
    return;
  }
  await db.query(
    `
      UPDATE project_paper_recommendations
      SET state = 'discarded',
          updated_at = $1
      WHERE paper_id = $2
        AND state = 'pending'
    `,
    [now, Number(paperId)]
  );
}

async function paperReportState(db, legacyPaperId) {
  const paper = await legacyPaper(db, legacyPaperId);
  const libraryPaperId = await ensureLibraryPaperIdForLegacyPaper(db, paper);
  if (!libraryPaperId) return null;
  const row = await reportArtifactRow(db, legacyPaperId, libraryPaperId);
  const content = reportContent(row);
  const source = reportSource(row);
  const now = nowIso();
  return {
    artifact_id: row ? Number(row.id) : null,
    paper_id: Number(legacyPaperId),
    library_paper_id: libraryPaperId,
    arxiv_id: paper.arxiv_id || "",
    link: paper.link || "",
    title: paper.title || "",
    status: row?.status || "queued",
    prompt: content.prompt || "",
    system_prompt: content.system_prompt || "",
    model_provider_id: row?.model_provider_id || "",
    model: row?.model || "",
    source_text_hash: source.source_text_hash || row?.input_hash || "",
    source_project_ids: sourceProjectIdsFromContent(content),
    report_markdown: row?.content_markdown || "",
    error_message: content.error_message || "",
    created_at: row?.created_at || now,
    updated_at: row?.updated_at || now,
    started_at: content.started_at ?? null,
    finished_at: content.finished_at ?? null
  };
}

export async function syncProjectPaperRecommendations(paperIds = null) {
  const normalizedIds = paperIds === null ? null : parseIntegerList(paperIds);
  return withTransaction(async (client) => {
    const rows = await client.query(
      `
        SELECT
          j.project_id,
          j.paper_id,
          j.relation_type,
          j.reason,
          j.input_hash,
          r.state AS existing_state
        FROM project_paper_judgments j
        JOIN arxiv_papers p ON p.id = j.paper_id
        JOIN research_projects rp ON rp.id = j.project_id
        LEFT JOIN project_paper_recommendations r
          ON r.project_id = j.project_id AND r.paper_id = j.paper_id
        WHERE j.relation_type = ANY($1::text[])
          AND j.suggested_action != 'ignore'
          AND j.confidence >= $2
          AND j.usefulness_score >= $3
          AND rp.status NOT IN ('paused', 'archived')
          AND NOT EXISTS (
            SELECT 1 FROM arxiv_paper_tombstones t
            WHERE t.arxiv_id = p.arxiv_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM papers lp
            WHERE lp.arxiv_id = p.arxiv_id
              AND lp.library_status IN ('archived', 'discarded')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM paper_sources ps
            JOIN papers lp ON lp.id = ps.paper_id
            WHERE ps.source_type = 'arxiv'
              AND ps.source_identifier = p.arxiv_id
              AND lp.library_status IN ('archived', 'discarded')
          )
          AND ($4::bigint[] IS NULL OR j.paper_id = ANY($4::bigint[]))
      `,
      [
        REPORT_RELATIONS,
        REPORT_CONFIDENCE_THRESHOLD,
        REPORT_USEFULNESS_THRESHOLD,
        normalizedIds && normalizedIds.length ? normalizedIds : null
      ]
    );
    let inserted = 0;
    let refreshed = 0;
    let preserved = 0;
    const now = nowIso();
    for (const row of rows.rows || []) {
      const existingState = text(row.existing_state);
      if (existingState === "accepted" || existingState === "discarded") preserved += 1;
      else if (existingState) refreshed += 1;
      else inserted += 1;
      await client.query(
        `
          INSERT INTO project_paper_recommendations(
            project_id, paper_id, state, importance, relation_type, reason,
            source_judgment_hash, created_at, updated_at
          )
          VALUES ($1, $2, 'pending', '', $3, $4, $5, $6, $6)
          ON CONFLICT(project_id, paper_id) DO UPDATE SET
            relation_type = excluded.relation_type,
            reason = excluded.reason,
            source_judgment_hash = excluded.source_judgment_hash,
            updated_at = excluded.updated_at
        `,
        [
          Number(row.project_id),
          Number(row.paper_id),
          row.relation_type || "",
          row.reason || "",
          row.input_hash || "",
          now
        ]
      );
    }
    return {
      paper_recommendation_candidates: rows.rows?.length || 0,
      paper_recommendations_created: inserted,
      paper_recommendations_refreshed: refreshed,
      paper_recommendations_preserved: preserved
    };
  });
}

export async function ensurePaperReportsForRecommendations(paperIds = null) {
  const projectsByPaper = await sourceProjectsForRecommendedPapers({ query }, paperIds);
  return withTransaction(async (client) => {
    let created = 0;
    let refreshed = 0;
    let preserved = 0;
    for (const [paperId, projectIds] of projectsByPaper.entries()) {
      const state = await paperReportState(client, paperId);
      if (!state) continue;
      if (!state.artifact_id) {
        await savePaperReportState(client, {
          ...state,
          status: "queued",
          prompt: DEFAULT_PAPER_READER_PROMPT,
          system_prompt: PAPER_READER_ANALYSIS_SYSTEM,
          source_project_ids: projectIds,
          report_markdown: "",
          error_message: ""
        });
        created += 1;
        continue;
      }
      if (JSON.stringify(state.source_project_ids) !== JSON.stringify(projectIds)) {
        await savePaperReportState(client, {
          ...state,
          source_project_ids: projectIds,
          prompt: state.prompt || DEFAULT_PAPER_READER_PROMPT,
          system_prompt: state.system_prompt || PAPER_READER_ANALYSIS_SYSTEM
        });
        refreshed += 1;
      } else {
        preserved += 1;
      }
    }
    return {
      paper_reports_candidates: projectsByPaper.size,
      paper_reports_queued: created,
      paper_reports_refreshed: refreshed,
      paper_reports_preserved: preserved
    };
  });
}

export async function getInbox() {
  await syncProjectPaperRecommendations();
  await ensurePaperReportsForRecommendations();
  const projectNamesResult = await query(
    `
      SELECT r.paper_id, rp.name AS project_name
      FROM project_paper_recommendations r
      JOIN research_projects rp ON rp.id = r.project_id
      WHERE r.state = 'pending'
        AND rp.status NOT IN ('paused', 'archived')
      ORDER BY
        r.paper_id,
        CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
        r.updated_at DESC,
        rp.name
    `
  );
  const projectNamesByPaper = new Map();
  for (const row of projectNamesResult.rows || []) {
    const paperId = Number(row.paper_id);
    const names = projectNamesByPaper.get(paperId) || [];
    const projectName = text(row.project_name);
    if (projectName && !names.includes(projectName)) names.push(projectName);
    projectNamesByPaper.set(paperId, names);
  }
  const result = await query(
    `
      WITH pending_recommendations AS (
        SELECT
          r.*,
          COUNT(*) OVER (PARTITION BY r.paper_id) AS project_count,
          ROW_NUMBER() OVER (
            PARTITION BY r.paper_id
            ORDER BY
              CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
              r.updated_at DESC
          ) AS rn
        FROM project_paper_recommendations r
        WHERE r.state = 'pending'
      )
      SELECT
        p.id,
        p.arxiv_id,
        p.title,
        p.authors_json,
        p.categories_json,
        p.published_at,
        p.link,
        r.project_id,
        rp.name AS project_name,
        r.relation_type,
        r.reason,
        r.project_count,
        j.usefulness_score,
        j.confidence,
        rr.status AS report_status,
        rr.content_json AS report_content_json,
        rr.updated_at AS report_updated_at
      FROM arxiv_papers p
      JOIN pending_recommendations r ON r.paper_id = p.id AND r.rn = 1
      JOIN research_projects rp ON rp.id = r.project_id
      LEFT JOIN project_paper_judgments j
        ON j.project_id = r.project_id AND j.paper_id = r.paper_id
      LEFT JOIN (
        SELECT ps.source_identifier AS arxiv_id, af.status, af.content_json, af.updated_at
        FROM artifacts af
        JOIN paper_sources ps ON ps.paper_id = af.scope_id
        WHERE af.scope_type = 'paper'
          AND af.artifact_type = $1
          AND af.status != 'removed'
      ) rr ON rr.arxiv_id = p.arxiv_id
      WHERE NOT EXISTS (
          SELECT 1 FROM arxiv_paper_tombstones t
          WHERE t.arxiv_id = p.arxiv_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM papers lp
          WHERE lp.arxiv_id = p.arxiv_id
            AND lp.library_status IN ('archived', 'discarded')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM paper_sources ps
          JOIN papers lp ON lp.id = ps.paper_id
          WHERE ps.source_type = 'arxiv'
            AND ps.source_identifier = p.arxiv_id
            AND lp.library_status IN ('archived', 'discarded')
        )
      ORDER BY
        CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
        COALESCE(j.usefulness_score, 0) DESC,
        j.confidence DESC,
        p.published_at DESC
      LIMIT 100
    `,
    [PAPER_REPORT_ARTIFACT_TYPE]
  );
  return {
    items: (result.rows || []).map((row) => {
      const reportContentJson = reportContent({ content_json: row.report_content_json });
      return {
        id: Number(row.id),
        arxiv_id: row.arxiv_id || "",
        title: row.title || "",
        authors: parseJson(row.authors_json, []),
        categories: parseJson(row.categories_json, []),
        published_at: row.published_at || "",
        link: row.link || "",
        score: numberValue(row.usefulness_score),
        project_id: Number(row.project_id),
        project_name: row.project_name || "",
        project_names: projectNamesByPaper.get(Number(row.id)) || (row.project_name ? [row.project_name] : []),
        relation_type: row.relation_type || "",
        confidence: numberValue(row.confidence),
        reason: row.reason || "",
        project_count: Number(row.project_count || 1),
        report_status: row.report_status || "",
        report_error: reportContentJson.error_message || "",
        report_updated_at: row.report_updated_at || null,
        feedback_status: ""
      };
    })
  };
}

export async function getLegacyPaperDetail(paperId) {
  const id = positiveId(paperId, "paper_id");
  await syncProjectPaperRecommendations([id]);
  await ensurePaperReportsForRecommendations([id]);
  return getReaderPaperDetail(id);
}

export async function updatePaperRecommendation(paperId, payload = {}) {
  const id = positiveId(paperId, "paper_id");
  const action = text(payload.action).toLowerCase();
  await syncProjectPaperRecommendations([id]);
  if (action === "accept") {
    const projectIds = parseIntegerList(payload.project_ids);
    const importance = text(payload.importance).toLowerCase();
    return withTransaction(async (client) => {
      await acceptRecommendationsForPaper(client, id, projectIds, importance);
      const library = await setLegacyPaperLibraryStatus(client, id, "reading");
      const detail = await getReaderPaperDetail(id, client);
      return { ...detail, ok: true, library, sync: { skipped: true, reason: "node_crud_recommendation_update" } };
    });
  }
  if (action === "discard") {
    const projectIds = Array.isArray(payload.project_ids) ? parseIntegerList(payload.project_ids) : null;
    return withTransaction(async (client) => {
      await discardRecommendationsForPaper(client, id, projectIds);
      let library = null;
      try {
        library = await setLegacyPaperLibraryStatus(client, id, "discarded");
      } catch {
        library = null;
      }
      return { ok: true, paper_id: id, action: "discard", library };
    });
  }
  throw new ValidationError("action must be accept or discard");
}

export async function savePaperFeedback(paperId, statusValue, note = "") {
  const id = positiveId(paperId, "paper_id");
  const status = text(statusValue);
  if (!VALID_FEEDBACK.has(status)) throw new ValidationError(`Invalid feedback status: ${status}`);
  return withTransaction(async (client) => {
    const paper = await legacyPaper(client, id);
    const now = nowIso();
    await client.query(
      `
        INSERT INTO user_feedback(paper_id, status, note, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT(paper_id, status) DO UPDATE SET
          note = excluded.note,
          updated_at = excluded.updated_at
      `,
      [id, status, text(note), now]
    );
    const libraryPaperId = await ensureLibraryPaperIdForLegacyPaper(client, paper);
    const statusMap = {
      read_later: "saved",
      favorite: "saved",
      read: "read",
      not_relevant: "discarded"
    };
    const libraryStatus = statusMap[status];
    const existing = await client.query("SELECT reading_state, saved_at, last_read_at FROM papers WHERE id = $1", [libraryPaperId]);
    const existingRow = maybeOne(existing) || {};
    const savedAt = ["saved", "reading", "read"].includes(libraryStatus) && !existingRow.saved_at ? now : existingRow.saved_at;
    const lastReadAt = libraryStatus === "read" ? now : existingRow.last_read_at;
    await client.query(
      `
        UPDATE papers
        SET library_status = $1,
            reading_state = $2,
            saved_at = $3,
            last_read_at = $4,
            updated_at = $5
        WHERE id = $6
      `,
      [
        libraryStatus,
        readingStateForStatus(libraryStatus, existingRow.reading_state),
        savedAt,
        lastReadAt,
        now,
        libraryPaperId
      ]
    );
    return {
      ok: true,
      paper_id: id,
      status,
      arxiv_id: paper.arxiv_id || "",
      library: {
        ok: true,
        paper_id: libraryPaperId,
        library_status: libraryStatus,
        reading_state: readingStateForStatus(libraryStatus, existingRow.reading_state)
      }
    };
  });
}
