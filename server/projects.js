import {
  NotFoundError,
  ValidationError,
  maybeOne,
  parseJson,
  query,
  toJson,
  withTransaction
} from "./db.js";

export const PROJECT_STATUSES = new Set(["planned", "active", "completed", "paused", "exploring", "writing", "archived"]);
export const PROJECT_PAPER_RELATIONS = new Set(["candidate", "reading", "core", "background", "rejected"]);
export const PROJECT_NOTE_RELATIONS = new Set(["source", "idea", "method", "result", "todo", "center_page", "folder_member"]);
export const DEFAULT_PROJECT_AUTOMATION = Object.freeze({
  auto_link_papers: false,
  generate_paper_cards: true,
  generate_project_digest: true,
  sync_experiment_notes: true
});

const PROJECT_STATUS_TAGS = Object.freeze({
  active: "Status/进行中",
  completed: "Status/已完成",
  paused: "Status/搁置",
  planned: "Status/计划中"
});
const VALID_LIBRARY_STATUSES = new Set(["candidate", "saved", "reading", "read", "archived", "discarded"]);
const ARCHIVE_PROTECTED_STATUSES = new Set(["saved", "reading", "read"]);

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveId(value, field = "id") {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`${field} is required`);
  }
  return parsed;
}

function csvPayload(value) {
  if (Array.isArray(value)) {
    return value.map((item) => text(item)).filter(Boolean);
  }
  return text(value).split(",").map((item) => text(item)).filter(Boolean);
}

function tagPayload(value) {
  return csvPayload(value).map((item) => item.replace(/^#+/, "").toLowerCase()).filter(Boolean);
}

function boolPayload(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on", "enabled"].includes(text(value).toLowerCase());
}

function automationPayload(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_PROJECT_AUTOMATION).map(([key, defaultValue]) => [
      key,
      boolPayload(raw[key], defaultValue)
    ])
  );
}

function statusTagForProjectStatus(status) {
  return PROJECT_STATUS_TAGS[status] || PROJECT_STATUS_TAGS.planned;
}

function projectRow(row) {
  const automation = {
    ...DEFAULT_PROJECT_AUTOMATION,
    ...parseJson(row.automation_json, {})
  };
  return {
    id: Number(row.id),
    name: row.name,
    status: row.status,
    summary: row.summary || "",
    goals: row.goals || "",
    keywords: parseJson(row.keywords_json, []),
    obsidian_project_path: row.obsidian_project_path || "",
    obsidian_output_dir: row.obsidian_output_dir || "",
    obsidian_note_id: row.obsidian_note_id ?? null,
    obsidian_folder: row.obsidian_folder || "",
    obsidian_status_tag: row.obsidian_status_tag || "",
    discovery_source: row.discovery_source || "manual",
    source_tags: parseJson(row.source_tags_json, []),
    arxiv_categories: parseJson(row.arxiv_categories_json, []),
    automation,
    created_at: row.created_at,
    updated_at: row.updated_at,
    paper_count: numberValue(row.paper_count),
    note_count: numberValue(row.note_count),
    artifact_count: numberValue(row.artifact_count),
    latest_artifact_at: row.latest_artifact_at || ""
  };
}

function projectArtifactPayload(row) {
  const content = parseJson(row.content_json, {});
  const source = parseJson(row.source_json, {});
  const obsidianExport = content && typeof content === "object" ? content.obsidian_export : null;
  let obsidianPath = "";
  if (obsidianExport && typeof obsidianExport === "object") {
    obsidianPath = text(obsidianExport.path);
  }
  if (!obsidianPath && source && typeof source === "object") {
    obsidianPath = text(source.obsidian_path);
  }
  return {
    id: Number(row.id),
    artifact_type: row.artifact_type,
    title: row.title,
    obsidian_path: obsidianPath,
    content_markdown: row.content_markdown || "",
    content_json: content && typeof content === "object" ? content : {},
    status: row.status,
    source: source && typeof source === "object" ? source : {},
    updated_at: row.updated_at
  };
}

async function projectContextPayload(db, projectId) {
  const result = await db.query(
    `
      SELECT
        kd.id,
        kd.source_type,
        kd.source_uri,
        kd.title,
        kd.raw_content,
        kd.indexed_at,
        kd.updated_at,
        pcd.relation,
        pcd.weight,
        COUNT(c.id) AS chunk_count
      FROM project_context_documents pcd
      JOIN knowledge_documents kd ON kd.id = pcd.document_id
      LEFT JOIN research_chunks c ON c.document_id = kd.id
      WHERE pcd.project_id = $1
      GROUP BY kd.id, pcd.relation, pcd.weight
      ORDER BY pcd.weight DESC, kd.updated_at DESC
    `,
    [projectId]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    document_id: Number(row.id),
    source_type: row.source_type,
    source_uri: row.source_uri,
    title: row.title,
    excerpt: text(row.raw_content).slice(0, 600),
    relation: row.relation,
    weight: numberValue(row.weight),
    chunk_count: numberValue(row.chunk_count),
    indexed_at: row.indexed_at,
    updated_at: row.updated_at
  }));
}

async function projectRecommendationPaperRows(db, projectId, {
  states = ["pending", "accepted"],
  excludeLinked = true,
  limit = 80
} = {}) {
  const selectedStates = states.map((state) => text(state)).filter((state) => (
    ["pending", "accepted", "discarded"].includes(state)
  ));
  if (!selectedStates.length) return [];
  const rowLimit = Math.max(1, Math.min(Number.parseInt(String(limit || 80), 10) || 80, 500));
  const stateParams = selectedStates.map((_, index) => `$${index + 2}`).join(", ");
  const linkedClause = excludeLinked
    ? `
          AND NOT EXISTS (
            SELECT 1
            FROM project_papers pp
            WHERE pp.project_id = r.project_id
              AND pp.paper_id = r.paper_id
              AND NOT (
                pp.relation = 'candidate'
                AND pp.note = 'auto_matched_by_project_context'
              )
          )
        `
    : "";
  const result = await db.query(
    `
      SELECT
        p.id,
        p.arxiv_id,
        p.title,
        p.published_at,
        COALESCE(text_asset.status, 'pending') AS text_status,
        COALESCE(source.source_url, '') AS link,
        p.id AS library_paper_id,
        r.state AS recommendation_state,
        r.importance,
        r.relation_type,
        r.reason AS recommendation_reason,
        r.updated_at AS recommendation_updated_at,
        j.relevance_score,
        j.usefulness_score,
        j.confidence
      FROM project_paper_recommendations r
      JOIN papers p ON p.id = r.paper_id
      LEFT JOIN LATERAL (
        SELECT ps.source_url
        FROM paper_sources ps
        WHERE ps.paper_id = p.id
        ORDER BY ps.updated_at DESC, ps.id DESC
        LIMIT 1
      ) source ON TRUE
      LEFT JOIN LATERAL (
        SELECT pa.status
        FROM paper_assets pa
        WHERE pa.paper_id = p.id AND pa.asset_type = 'text'
        ORDER BY pa.updated_at DESC, pa.id DESC
        LIMIT 1
      ) text_asset ON TRUE
      LEFT JOIN project_paper_judgments j
        ON j.project_id = r.project_id AND j.paper_id = r.source_arxiv_paper_id
      WHERE r.project_id = $1
        AND r.state IN (${stateParams})
        AND p.library_status NOT IN ('archived', 'discarded')
        ${linkedClause}
      ORDER BY
        CASE r.state WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
        CASE r.relation_type WHEN 'direct' THEN 0 WHEN 'indirect' THEN 1 ELSE 2 END,
        COALESCE(j.usefulness_score, 0) DESC,
        COALESCE(j.confidence, 0) DESC,
        p.published_at DESC
      LIMIT $${selectedStates.length + 2}
    `,
    [projectId, ...selectedStates, rowLimit]
  );
  return result.rows;
}

export async function getProjects(db = { query }) {
  const result = await db.query(`
    SELECT
      p.*,
      COUNT(DISTINCT pp.paper_id) AS paper_count,
      COUNT(DISTINCT pn.note_id) AS note_count,
      COUNT(DISTINCT af.id) AS artifact_count,
      MAX(af.updated_at) AS latest_artifact_at
    FROM research_projects p
    LEFT JOIN project_papers pp
      ON pp.project_id = p.id
     AND NOT (
       pp.relation = 'candidate'
       AND pp.note = 'auto_matched_by_project_context'
     )
    LEFT JOIN project_notes pn ON pn.project_id = p.id
    LEFT JOIN artifacts af ON af.scope_type = 'project' AND af.scope_id = p.id
    GROUP BY p.id
    ORDER BY
      CASE p.status
        WHEN 'active' THEN 1
        WHEN 'exploring' THEN 2
        WHEN 'writing' THEN 3
        WHEN 'paused' THEN 4
        ELSE 5
      END,
      p.updated_at DESC
  `);
  return { items: result.rows.map(projectRow) };
}

export async function getProjectDetail(projectId, db = { query }) {
  const id = positiveId(projectId, "project_id");
  const projectResult = await db.query(
    `
      SELECT
        p.*,
        COUNT(DISTINCT pp.paper_id) AS paper_count,
        COUNT(DISTINCT pn.note_id) AS note_count
      FROM research_projects p
      LEFT JOIN project_papers pp
        ON pp.project_id = p.id
       AND NOT (
         pp.relation = 'candidate'
         AND pp.note = 'auto_matched_by_project_context'
       )
      LEFT JOIN project_notes pn ON pn.project_id = p.id
      WHERE p.id = $1
      GROUP BY p.id
    `,
    [id]
  );
  const row = maybeOne(projectResult);
  if (!row) throw new NotFoundError(`Project not found: ${id}`);

  const [
    papers,
    notes,
    recommendedPapers,
    candidateNotes,
    artifacts,
    projectMatches,
    contextDocuments
  ] = await Promise.all([
    db.query(
      `
        SELECT
          p.id,
          p.arxiv_id,
          p.title,
          COALESCE(source.source_url, '') AS link,
          p.id AS library_paper_id,
          pp.relation,
          pp.note,
          pp.updated_at,
          COALESCE(r.importance, '') AS importance,
          COALESCE(NULLIF(ppm.quality_score, 0), ppm.score) AS project_score
        FROM project_papers pp
        JOIN papers p ON p.id = pp.paper_id
        LEFT JOIN LATERAL (
          SELECT ps.source_url
          FROM paper_sources ps
          WHERE ps.paper_id = p.id
          ORDER BY ps.updated_at DESC, ps.id DESC
          LIMIT 1
        ) source ON TRUE
        LEFT JOIN project_paper_recommendations r
          ON r.project_id = pp.project_id
         AND r.paper_id = pp.paper_id
         AND r.state = 'accepted'
        LEFT JOIN project_paper_matches ppm
          ON ppm.project_id = pp.project_id
         AND ppm.paper_id = r.source_arxiv_paper_id
        WHERE pp.project_id = $1
          AND NOT (
            pp.relation = 'candidate'
            AND pp.note = 'auto_matched_by_project_context'
          )
        ORDER BY
          CASE r.importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
          COALESCE(ppm.score, 0) DESC,
          pp.updated_at DESC
      `,
      [id]
    ),
    db.query(
      `
        SELECT n.id, n.path, n.title, pn.relation, pn.note, pn.updated_at
        FROM project_notes pn
        JOIN obsidian_notes n ON n.id = pn.note_id
        WHERE pn.project_id = $1
        ORDER BY pn.updated_at DESC
      `,
      [id]
    ),
    projectRecommendationPaperRows(db, id, {
      states: ["pending", "accepted"],
      excludeLinked: true,
      limit: 80
    }),
    db.query(
      `
        SELECT n.id, n.path, n.title, n.tags_json, COUNT(c.id) AS chunk_count
        FROM obsidian_notes n
        LEFT JOIN research_chunks c ON c.note_id = n.id
        WHERE NOT EXISTS (
          SELECT 1 FROM project_notes pn
          WHERE pn.project_id = $1 AND pn.note_id = n.id
        )
        GROUP BY n.id
        ORDER BY n.indexed_at DESC
        LIMIT 80
      `,
      [id]
    ),
    db.query(
      `
        SELECT id, artifact_type, title, content_markdown, content_json, status, source_json, updated_at
        FROM artifacts
        WHERE scope_type = 'project' AND scope_id = $1
        ORDER BY updated_at DESC
      `,
      [id]
    ),
    db.query(
      `
        SELECT
          ppm.paper_id,
          ppm.score,
          ppm.rank_score,
          COALESCE(NULLIF(ppm.quality_score, 0), ppm.score) AS quality_score,
          ppm.best_arxiv_chunk_id,
          ppm.best_obsidian_chunk_id,
          ppm.searchers_json,
          ppm.evidence_json,
          ppm.match_type,
          ppm.updated_at,
          p.arxiv_id,
          p.title,
          p.link,
          p.published_at,
          ac.chunk_index AS arxiv_chunk_index,
          ac.source AS arxiv_chunk_source,
          ac.page_start AS arxiv_page_start,
          ac.page_end AS arxiv_page_end,
          ac.text AS arxiv_text,
          c.heading AS obsidian_heading,
          c.text AS obsidian_text,
          COALESCE(n.title, kd.title) AS note_title,
          COALESCE(n.path, kd.source_uri) AS note_path,
          kd.source_type AS context_source_type,
          kd.id AS context_document_id,
          j.relation_type,
          j.relevance_score,
          j.usefulness_score,
          j.confidence AS judgment_confidence,
          j.suggested_action,
          j.reason AS judgment_reason,
          j.evidence_mapping_json,
          j.missing_evidence,
          j.updated_at AS judgment_updated_at
        FROM project_paper_matches ppm
        JOIN arxiv_papers p ON p.id = ppm.paper_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = ppm.best_arxiv_chunk_id
        LEFT JOIN research_chunks c ON c.id = ppm.best_obsidian_chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN knowledge_documents kd ON kd.id = c.document_id
        LEFT JOIN project_paper_judgments j
          ON j.project_id = ppm.project_id AND j.paper_id = ppm.paper_id
        WHERE ppm.project_id = $1
        ORDER BY quality_score DESC, ppm.updated_at DESC
        LIMIT 80
      `,
      [id]
    ),
    projectContextPayload(db, id)
  ]);

  const recommendationPayload = recommendedPapers.map((paper) => ({
    id: Number(paper.id),
    library_paper_id: Number(paper.library_paper_id || 0),
    arxiv_id: paper.arxiv_id,
    title: paper.title,
    published_at: paper.published_at,
    text_status: paper.text_status,
    score: numberValue(paper.usefulness_score),
    recommendation_state: paper.recommendation_state,
    importance: paper.importance,
    relation_type: paper.relation_type,
    reason: paper.recommendation_reason,
    confidence: numberValue(paper.confidence),
    recommendation_updated_at: paper.recommendation_updated_at
  }));

  return {
    project: projectRow(row),
    papers: papers.rows.map((paper) => ({
      id: Number(paper.id),
      library_paper_id: Number(paper.library_paper_id || 0),
      arxiv_id: paper.arxiv_id,
      title: paper.title,
      link: paper.link,
      relation: paper.relation,
      note: paper.note,
      importance: paper.importance || "",
      project_score: numberValue(paper.project_score),
      updated_at: paper.updated_at
    })),
    notes: notes.rows.map((note) => ({
      id: Number(note.id),
      path: note.path,
      title: note.title,
      relation: note.relation,
      note: note.note,
      updated_at: note.updated_at
    })),
    context_documents: contextDocuments,
    candidate_papers: recommendationPayload,
    recommended_papers: recommendationPayload,
    candidate_notes: candidateNotes.rows.map((note) => ({
      id: Number(note.id),
      path: note.path,
      title: note.title,
      tags: parseJson(note.tags_json, []),
      chunk_count: numberValue(note.chunk_count)
    })),
    artifacts: artifacts.rows.map(projectArtifactPayload),
    retrieval_hits: projectMatches.rows.map((match) => ({
      paper_id: Number(match.paper_id),
      arxiv_id: match.arxiv_id,
      title: match.title,
      link: match.link,
      published_at: match.published_at,
      score: numberValue(match.score),
      best_arxiv_chunk_id: match.best_arxiv_chunk_id === null || match.best_arxiv_chunk_id === undefined
        ? null
        : Number(match.best_arxiv_chunk_id),
      best_obsidian_chunk_id: match.best_obsidian_chunk_id === null || match.best_obsidian_chunk_id === undefined
        ? null
        : Number(match.best_obsidian_chunk_id),
      searchers: parseJson(match.searchers_json, []),
      evidence: parseJson(match.evidence_json, {}),
      match_type: match.match_type,
      updated_at: match.updated_at,
      arxiv_chunk_index: match.arxiv_chunk_index,
      arxiv_chunk_source: match.arxiv_chunk_source,
      arxiv_page_start: match.arxiv_page_start,
      arxiv_page_end: match.arxiv_page_end,
      arxiv_text: match.arxiv_text,
      obsidian_heading: match.obsidian_heading,
      obsidian_text: match.obsidian_text,
      note_title: match.note_title,
      note_path: match.note_path,
      context_source_type: match.context_source_type,
      context_document_id: match.context_document_id === null || match.context_document_id === undefined
        ? null
        : Number(match.context_document_id),
      rank_score: numberValue(match.rank_score),
      quality_score: numberValue(match.quality_score),
      judgment: match.relation_type === null || match.relation_type === undefined
        ? null
        : {
            relation_type: match.relation_type,
            relevance_score: numberValue(match.relevance_score),
            usefulness_score: numberValue(match.usefulness_score),
            confidence: numberValue(match.judgment_confidence),
            suggested_action: match.suggested_action,
            reason: match.judgment_reason,
            evidence_mapping: parseJson(match.evidence_mapping_json, []),
            missing_evidence: match.missing_evidence,
            updated_at: match.judgment_updated_at
          }
    }))
  };
}

function normalizedProjectPayload(payload = {}) {
  const name = text(payload.name);
  if (!name) throw new ValidationError("Project name is required");
  const status = text(payload.status || "active");
  if (!PROJECT_STATUSES.has(status)) {
    throw new ValidationError(`Invalid project status: ${status}`);
  }
  const obsidianProjectPath = text(payload.obsidian_project_path).replaceAll("\\", "/");
  const obsidianOutputDir = text(payload.obsidian_output_dir).replaceAll("\\", "/");
  const obsidianFolder = text(payload.obsidian_folder).replaceAll("\\", "/");
  const discoverySource = text(payload.discovery_source || "manual") || "manual";
  return {
    id: payload.id ? positiveId(payload.id) : null,
    name,
    status,
    summary: text(payload.summary),
    goals: text(payload.goals),
    keywords: csvPayload(payload.keywords ?? []),
    obsidian_project_path: obsidianProjectPath,
    obsidian_output_dir: obsidianOutputDir,
    obsidian_folder: obsidianFolder,
    obsidian_status_tag: statusTagForProjectStatus(status),
    discovery_source: discoverySource,
    source_tags: tagPayload(payload.source_tags ?? []),
    arxiv_categories: csvPayload(payload.arxiv_categories ?? []),
    automation: automationPayload(payload.automation ?? {})
  };
}

export async function saveProject(payload = {}) {
  const normalized = normalizedProjectPayload(payload);
  const projectId = await withTransaction(async (client) => {
    const now = nowIso();
    if (normalized.id) {
      const existingResult = await client.query(
        "SELECT obsidian_project_path, obsidian_folder, discovery_source FROM research_projects WHERE id = $1",
        [normalized.id]
      );
      const existing = maybeOne(existingResult);
      if (!existing) throw new NotFoundError(`Project not found: ${normalized.id}`);
      const obsidianProjectPath = normalized.obsidian_project_path || existing.obsidian_project_path || "";
      const obsidianFolder = normalized.obsidian_folder || existing.obsidian_folder || "";
      const discoverySource = existing.discovery_source || normalized.discovery_source;
      await client.query(
        `
          UPDATE research_projects
          SET
            name = $1,
            status = $2,
            summary = $3,
            goals = $4,
            keywords_json = $5,
            obsidian_project_path = $6,
            obsidian_output_dir = $7,
            obsidian_folder = $8,
            obsidian_status_tag = $9,
            discovery_source = $10,
            source_tags_json = $11,
            arxiv_categories_json = $12,
            automation_json = $13,
            updated_at = $14
          WHERE id = $15
        `,
        [
          normalized.name,
          normalized.status,
          normalized.summary,
          normalized.goals,
          toJson(normalized.keywords),
          obsidianProjectPath,
          normalized.obsidian_output_dir,
          obsidianFolder,
          normalized.obsidian_status_tag,
          discoverySource,
          toJson(normalized.source_tags),
          toJson(normalized.arxiv_categories),
          toJson(normalized.automation),
          now,
          normalized.id
        ]
      );
      return normalized.id;
    }

    const inserted = await client.query(
      `
        INSERT INTO research_projects(
          name, status, summary, goals, keywords_json, obsidian_project_path,
          obsidian_output_dir, obsidian_folder, obsidian_status_tag, discovery_source,
          source_tags_json, arxiv_categories_json, automation_json,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
        RETURNING id
      `,
      [
        normalized.name,
        normalized.status,
        normalized.summary,
        normalized.goals,
        toJson(normalized.keywords),
        normalized.obsidian_project_path,
        normalized.obsidian_output_dir,
        normalized.obsidian_folder,
        normalized.obsidian_status_tag,
        normalized.discovery_source,
        toJson(normalized.source_tags),
        toJson(normalized.arxiv_categories),
        toJson(normalized.automation),
        now
      ]
    );
    return Number(inserted.rows[0].id);
  });
  return getProjectDetail(projectId);
}

function validateRelation(value, allowed, fallback) {
  const relation = text(value || fallback);
  if (!allowed.has(relation)) throw new ValidationError(`Invalid relation: ${relation}`);
  return relation;
}

function readingStateForStatus(status, existing = "") {
  if (status === "reading") return "reading";
  if (status === "read") return "read";
  if (["candidate", "saved"].includes(status)) return existing || "unread";
  return existing || "unread";
}

async function setPaperLibraryStatus(client, paperId, status) {
  const nextStatus = text(status);
  if (!VALID_LIBRARY_STATUSES.has(nextStatus)) {
    throw new ValidationError(`Invalid library status: ${nextStatus}`);
  }
  const currentResult = await client.query("SELECT saved_at, last_read_at, reading_state FROM papers WHERE id = $1", [paperId]);
  const current = maybeOne(currentResult);
  if (!current) throw new NotFoundError(`Paper not found: ${paperId}`);
  const now = nowIso();
  const savedAt = ARCHIVE_PROTECTED_STATUSES.has(nextStatus) && !current.saved_at ? now : current.saved_at;
  const lastReadAt = nextStatus === "read" ? now : current.last_read_at;
  const readingState = readingStateForStatus(nextStatus, text(current.reading_state));
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
    [nextStatus, readingState, savedAt, lastReadAt, now, paperId]
  );
  return { ok: true, paper_id: paperId, library_status: nextStatus, reading_state: readingState };
}

export async function linkProjectPaper(projectId, payload = {}) {
  const id = positiveId(projectId, "project_id");
  const paperId = positiveId(payload.paper_id, "paper_id");
  const relation = validateRelation(payload.relation, PROJECT_PAPER_RELATIONS, "candidate");
  const note = text(payload.note);
  await withTransaction(async (client) => {
    const now = nowIso();
    await client.query(
      `
        INSERT INTO project_papers(project_id, paper_id, relation, note, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT(project_id, paper_id) DO UPDATE SET
          relation = excluded.relation,
          note = excluded.note,
          updated_at = excluded.updated_at
      `,
      [id, paperId, relation, note, now]
    );
    if (relation === "reading") {
      await setPaperLibraryStatus(client, paperId, "reading");
    } else if (["core", "background", "candidate"].includes(relation)) {
      await setPaperLibraryStatus(client, paperId, "saved");
    } else if (relation === "rejected") {
      await setPaperLibraryStatus(client, paperId, "discarded");
    }
  });
  return getProjectDetail(id);
}

export async function unlinkProjectPaper(projectId, paperId) {
  const id = positiveId(projectId, "project_id");
  const linkedPaperId = positiveId(paperId, "paper_id");
  await withTransaction(async (client) => {
    await client.query(
      "DELETE FROM project_papers WHERE project_id = $1 AND paper_id = $2",
      [id, linkedPaperId]
    );
  });
  return getProjectDetail(id);
}

export async function linkProjectNote(projectId, payload = {}) {
  const id = positiveId(projectId, "project_id");
  const noteId = positiveId(payload.note_id, "note_id");
  const relation = validateRelation(payload.relation, PROJECT_NOTE_RELATIONS, "source");
  const note = text(payload.note);
  await withTransaction(async (client) => {
    const now = nowIso();
    await client.query(
      `
        INSERT INTO project_notes(project_id, note_id, relation, note, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT(project_id, note_id) DO UPDATE SET
          relation = excluded.relation,
          note = excluded.note,
          updated_at = excluded.updated_at
      `,
      [id, noteId, relation, note, now]
    );
  });
  return getProjectDetail(id);
}

export async function unlinkProjectNote(projectId, noteId) {
  const id = positiveId(projectId, "project_id");
  const linkedNoteId = positiveId(noteId, "note_id");
  await withTransaction(async (client) => {
    await client.query(
      "DELETE FROM project_notes WHERE project_id = $1 AND note_id = $2",
      [id, linkedNoteId]
    );
  });
  return getProjectDetail(id);
}
