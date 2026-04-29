let dashboardInitialized = false;

export function initDashboard() {
if (dashboardInitialized) return;
dashboardInitialized = true;

const paperList = document.querySelector("#paperList");
const inboxMeta = document.querySelector("#inboxMeta");
const paperDetail = document.querySelector("#paperDetail");
const refreshButton = document.querySelector("#refreshButton");
const jobStatus = document.querySelector("#jobStatus");
const projectsView = document.querySelector("#projectsView");
const inboxView = document.querySelector("#inboxView");
const controlView = document.querySelector("#controlView");
const projectBoard = document.querySelector("#projectBoard");
const projectMeta = document.querySelector("#projectMeta");
const projectReminders = document.querySelector("#projectReminders");
const projectStats = document.querySelector("#projectStats");
const projectDetail = document.querySelector("#projectDetail");
const newProjectButton = document.querySelector("#newProjectButton");
const settingsForm = document.querySelector("#settingsForm");
const healthGrid = document.querySelector("#healthGrid");
const historyTable = document.querySelector("#historyTable");
const schedulerSummary = document.querySelector("#schedulerSummary");
const refreshControlButton = document.querySelector("#refreshControlButton");
const startStartupDailyButton = document.querySelector("#startStartupDailyButton");
const startSchedulerButton = document.querySelector("#startSchedulerButton");
const stopSchedulerButton = document.querySelector("#stopSchedulerButton");
const runNowButton = document.querySelector("#runNowButton");
const llmProviders = document.querySelector("#llmProviders");
const addProviderButton = document.querySelector("#addProviderButton");
const chatProviderSelect = document.querySelector("#chatProviderSelect");
const chatModelSelect = document.querySelector("#chatModelSelect");
const embeddingProviderSelect = document.querySelector("#embeddingProviderSelect");
const embeddingModelSelect = document.querySelector("#embeddingModelSelect");

let papers = [];
let activePaperId = null;
let projects = [];
let activeProjectId = null;
let activeProjectData = null;
let projectActivities = [];
let projectJobStatus = null;
let activeView = "projects";
let settingsHydrated = false;
let dashboardRefreshInFlight = false;

const PROJECT_COLUMNS = [
  ["active", "进行中"],
  ["planned", "计划中"],
  ["completed", "已完成"],
  ["paused", "搁置"],
  ["exploring", "探索中"],
  ["writing", "写作中"],
  ["archived", "归档"]
];
const PROJECT_PAPER_RELATIONS = [
  ["candidate", "候选"],
  ["reading", "阅读中"],
  ["core", "核心文献"],
  ["background", "背景资料"],
  ["rejected", "已排除"]
];
const PROJECT_NOTE_RELATIONS = [
  ["center_page", "中心页"],
  ["folder_member", "项目文件夹"],
  ["source", "资料"],
  ["idea", "想法"],
  ["method", "方法"],
  ["result", "结果"],
  ["todo", "待办"]
];
const PROJECT_STATUS_LABELS = Object.fromEntries(PROJECT_COLUMNS);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function fmtScore(value) {
  if (value === null || value === undefined) return "0.00";
  return Number(value).toFixed(2);
}

function fmtDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function csv(value) {
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function relationOptions(options, selected) {
  return options
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

function compactLabel(value, size = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > size ? `${text.slice(0, size - 1)}...` : text;
}

function snippet(value, size = 180) {
  return compactLabel(value, size);
}

function checked(value) {
  return value ? "checked" : "";
}

function statusLabel(status) {
  return PROJECT_STATUS_LABELS[status] || status || "未知";
}

function sumProject(field) {
  return projects.reduce((total, project) => total + Number(project[field] || 0), 0);
}

function metaNumber(meta = {}, keys = []) {
  for (const key of keys) {
    const value = Number(meta[key] || 0);
    if (value) return value;
  }
  return 0;
}

function findActivity(predicate) {
  return projectActivities.find((item) => item.status === "completed" && predicate(item.meta || {}, item));
}

function jobTitle(jobType) {
  const labels = {
    "run-daily": "每日流程",
    "fetch-arxiv": "arXiv 抓取",
    "cache-arxiv-text": "论文正文缓存",
    "generate-reports": "用途报告生成",
    "sync-obsidian": "Obsidian 同步",
    "rank-papers": "论文匹配"
  };
  return labels[jobType] || jobType;
}

function renderProjectStats() {
  const activeCount = projects.filter((project) => ["active", "exploring", "writing"].includes(project.status)).length;
  const configuredOutputs = projects.filter((project) => project.obsidian_project_path || project.obsidian_output_dir).length;
  const autoDigest = projects.filter((project) => project.automation?.generate_project_digest).length;
  const stats = [
    ["项目", projects.length, `${activeCount} active`],
    ["论文", sumProject("paper_count"), "linked"],
    ["笔记", sumProject("note_count"), "Obsidian"],
    ["生成产物", sumProject("artifact_count"), "synced"],
    ["输出配置", configuredOutputs, "Obsidian paths"],
    ["自动综述", autoDigest, "enabled"]
  ];
  projectStats.innerHTML = stats
    .map(
      ([label, value, hint]) => `
        <div class="project-stat-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <p>${escapeHtml(hint)}</p>
        </div>
      `
    )
    .join("");
}

function reminderItem(state, title, detail) {
  return `
    <article class="reminder ${state}">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function dailyProgressReminder(job, progress) {
  const steps = progress.steps || [];
  const total = Number(progress.total || steps.length || 1);
  const completed = Number(progress.completed || steps.filter((step) => step.status === "completed").length);
  const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  const current = progress.current_label || steps.find((step) => step.status === "running")?.label || "准备中";
  return `
    <article class="reminder info daily-progress-card">
      <div class="daily-progress-head">
        <strong>每日流程运行中</strong>
        <span>${completed}/${total}</span>
      </div>
      <p>${escapeHtml(current)} · started ${escapeHtml(fmtDate(job.started_at))}</p>
      <div class="daily-progress-bar" aria-label="每日流程进度">
        <span style="width: ${percent}%"></span>
      </div>
      <div class="daily-progress-steps">
        ${steps
          .map(
            (step) => `
              <span class="daily-step ${escapeHtml(step.status || "pending")}">
                ${escapeHtml(step.label)}
              </span>
            `
          )
          .join("")}
      </div>
      ${
        steps.some((step) => step.summary)
          ? `<p class="daily-progress-summary">${escapeHtml(
              steps
                .filter((step) => step.summary)
                .map((step) => `${step.label}: ${step.summary}`)
                .join(" · ")
            )}</p>`
          : ""
      }
    </article>
  `;
}

function renderProjectReminders() {
  const reminders = [];
  const running = projectJobStatus?.current_job;
  const runningDaily = projectActivities.find((item) => item.job_type === "run-daily" && item.status === "running");
  const dailyProgress = runningDaily?.meta?.daily_progress;
  if (dailyProgress) {
    reminders.push(dailyProgressReminder(runningDaily, dailyProgress));
  } else if (running) {
    reminders.push(
      reminderItem("info", "任务运行中", `${jobTitle(running.command)} · started ${fmtDate(running.started_at)}`)
    );
  }

  const failed = projectActivities.find((item) => item.status === "failed");
  if (failed) {
    reminders.push(
      reminderItem("bad", "任务失败", `${jobTitle(failed.job_type)} · ${failed.message || fmtDate(failed.finished_at)}`)
    );
  }

  const trainingDone = findActivity((_, item) => /train|training|experiment|实验/i.test(item.job_type));
  if (trainingDone) {
    reminders.push(
      reminderItem("ok", "训练/实验任务完成", `${jobTitle(trainingDone.job_type)} · ${fmtDate(trainingDone.finished_at)}`)
    );
  }

  const paperJob = findActivity((meta) => metaNumber(meta, ["arxiv_papers_inserted", "papers_inserted"]) > 0);
  if (paperJob) {
    const count = metaNumber(paperJob.meta, ["arxiv_papers_inserted", "papers_inserted"]);
    reminders.push(reminderItem("info", "新论文到了", `${count} 篇新 arXiv 论文已入库 · ${fmtDate(paperJob.finished_at)}`));
  }

  const syncJob = findActivity((meta, item) => {
    const indexed = metaNumber(meta, ["sync_indexed", "indexed"]);
    return indexed > 0 || item.job_type === "sync-obsidian";
  });
  if (syncJob) {
    const indexed = metaNumber(syncJob.meta, ["sync_indexed", "indexed"]);
    const chunks = metaNumber(syncJob.meta, ["sync_chunks_created", "chunks_created"]);
    reminders.push(
      reminderItem(
        "ok",
        "实验记录已同步",
        indexed ? `${indexed} 篇笔记更新，${chunks} 个 chunk 入库 · ${fmtDate(syncJob.finished_at)}` : `Obsidian 同步完成 · ${fmtDate(syncJob.finished_at)}`
      )
    );
  }

  const textJob = findActivity((meta) => metaNumber(meta, ["text_texts_extracted", "texts_extracted"]) > 0);
  if (textJob) {
    const count = metaNumber(textJob.meta, ["text_texts_extracted", "texts_extracted"]);
    reminders.push(reminderItem("ok", "论文正文已缓存", `${count} 篇论文 PDF 已转 TXT · ${fmtDate(textJob.finished_at)}`));
  }

  const rankJob = findActivity((meta) => metaNumber(meta, ["matched_papers"]) > 0);
  if (rankJob) {
    const count = metaNumber(rankJob.meta, ["matched_papers"]);
    reminders.push(reminderItem("info", "论文匹配完成", `${count} 篇论文命中你的研究上下文 · ${fmtDate(rankJob.finished_at)}`));
  }

  const artifact = activeProjectData?.artifacts?.[0];
  if (artifact) {
    reminders.push(reminderItem("ok", "项目索引已写入", `${artifact.obsidian_path} · ${fmtDate(artifact.updated_at)}`));
  }

  if (!reminders.length) {
    reminders.push(reminderItem("neutral", "暂无新提醒", "没有新的任务完成、论文到达或实验同步事件。"));
  }

  projectReminders.innerHTML = reminders.slice(0, 5).join("");
}

function renderProjectDashboard() {
  renderProjectStats();
  renderProjectReminders();
}

function setView(view) {
  activeView = view;
  projectsView.classList.toggle("is-hidden", view !== "projects");
  inboxView.classList.toggle("is-hidden", view !== "inbox");
  controlView.classList.toggle("is-hidden", view !== "control");
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  if (view === "control") {
    loadControl({ hydrate: !settingsHydrated }).catch(showError);
  }
  if (view === "inbox") {
    loadInbox().catch(showError);
  }
  if (view === "projects") {
    loadProjects().catch(showError);
  }
}

function renderProjects() {
  projectMeta.textContent = `${projects.length} projects`;
  if (!projects.length) {
    projectBoard.innerHTML = `<div class="project-empty">暂无项目</div>`;
    renderProjectDashboard();
    return;
  }
  projectBoard.innerHTML = projects
    .map(
      (project) => `
        <button class="project-row ${project.id === activeProjectId ? "active" : ""}" data-project-id="${project.id}">
          <div class="project-row-main">
            <strong>${escapeHtml(project.name)}</strong>
            <p>${escapeHtml(project.obsidian_folder || project.obsidian_project_path || project.obsidian_output_dir || "未配置 Obsidian 输出")}</p>
          </div>
          <span class="status-pill status-${escapeHtml(project.status)}"><span class="status-dot"></span>${escapeHtml(statusLabel(project.status))}</span>
          <span class="project-row-metric"><strong>${project.paper_count || 0}</strong><small>papers</small></span>
          <span class="project-row-metric"><strong>${project.note_count || 0}</strong><small>notes</small></span>
          <span class="project-row-metric"><strong>${project.artifact_count || 0}</strong><small>outputs</small></span>
          <span class="project-row-date">${fmtDate(project.updated_at)}</span>
        </button>
      `
    )
    .join("");
  projectBoard.insertAdjacentHTML(
    "afterbegin",
    `<div class="project-table-head">
      <span>Project</span>
      <span>Status</span>
      <span>Papers</span>
      <span>Notes</span>
      <span>Outputs</span>
      <span>Updated</span>
    </div>`
  );
  renderProjectDashboard();
}

function projectForm(project = {}) {
  const automation = {
    auto_link_papers: false,
    generate_paper_cards: true,
    generate_project_digest: true,
    sync_experiment_notes: true,
    ...(project.automation || {})
  };
  return `
    <div class="detail-card">
      <form id="projectForm" class="project-form">
        <div class="detail-title">
          <h2>${project.id ? "项目自动化" : "新建项目"}</h2>
          <p class="muted">${project.id ? `Updated ${fmtDate(project.updated_at)}` : "Obsidian-backed workspace"}</p>
        </div>
        <label>
          <span>项目名称</span>
          <input name="name" value="${escapeHtml(project.name || "")}" required />
        </label>
        <label>
          <span>状态</span>
          <select name="status">
            ${PROJECT_COLUMNS.map(([value, label]) => `<option value="${value}" ${project.status === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>关键词</span>
          <input name="keywords" value="${escapeHtml(csv(project.keywords || []))}" placeholder="RAG,agent,scientific discovery" />
        </label>
        <label>
          <span>Obsidian 项目主页</span>
          <input name="obsidian_project_path" value="${escapeHtml(project.obsidian_project_path || "")}" placeholder="Projects/Agentic RAG.md" />
        </label>
        <label>
          <span>Obsidian 输出目录</span>
          <input name="obsidian_output_dir" value="${escapeHtml(project.obsidian_output_dir || "")}" placeholder="Projects/Agentic RAG" />
        </label>
        <label>
          <span>Obsidian 源标签</span>
          <input name="source_tags" value="${escapeHtml(csv(project.source_tags || []))}" placeholder="research,paper,experiment" />
        </label>
        <label>
          <span>arXiv 分类</span>
          <input name="arxiv_categories" value="${escapeHtml(csv(project.arxiv_categories || []))}" placeholder="cs.AI,cs.CL,cs.IR" />
        </label>
        <div class="automation-flags">
          <label class="checkbox-line">
            <input name="auto_link_papers" type="checkbox" ${checked(automation.auto_link_papers)} />
            <span>自动纳入高相关论文</span>
          </label>
          <label class="checkbox-line">
            <input name="generate_paper_cards" type="checkbox" ${checked(automation.generate_paper_cards)} />
            <span>生成论文卡片</span>
          </label>
          <label class="checkbox-line">
            <input name="generate_project_digest" type="checkbox" ${checked(automation.generate_project_digest)} />
            <span>生成项目综述</span>
          </label>
          <label class="checkbox-line">
            <input name="sync_experiment_notes" type="checkbox" ${checked(automation.sync_experiment_notes)} />
            <span>整理实验记录</span>
          </label>
        </div>
        <div class="form-actions">
          <button type="submit" class="primary">保存配置</button>
        </div>
      </form>
    </div>
  `;
}

function renderProjectDetail(data) {
  const project = data.project;
  const linkedPapers = data.papers || [];
  const linkedNotes = data.notes || [];
  const candidatePapers = data.candidate_papers || [];
  const candidateNotes = data.candidate_notes || [];
  const projectMatches = data.project_matches || [];
  activeProjectData = data;
  activeProjectId = project.id;
  renderProjects();
  renderProjectDashboard();
  projectDetail.className = "project-detail-stack";
  projectDetail.innerHTML = `
    ${projectForm(project)}
    <section class="panel automation-panel">
      <div class="panel-title">
        <h2>Obsidian 中心</h2>
        <button type="button" data-export-project>同步索引到 Obsidian</button>
      </div>
      <div class="project-health-grid">
        <div class="health-item ${project.obsidian_project_path ? "ok" : "warn"}">
          <span>项目主页</span>
          <strong>${escapeHtml(project.obsidian_project_path || "未配置")}</strong>
        </div>
        <div class="health-item ${project.obsidian_output_dir ? "ok" : "warn"}">
          <span>项目文件夹</span>
          <strong>${escapeHtml(project.obsidian_folder || project.obsidian_output_dir || "默认 Projects")}</strong>
        </div>
        <div class="health-item neutral">
          <span>源标签</span>
          <strong>${escapeHtml(csv(project.source_tags || []) || "全局配置")}</strong>
        </div>
        <div class="health-item neutral">
          <span>arXiv</span>
          <strong>${escapeHtml(csv(project.arxiv_categories || []) || "全局配置")}</strong>
        </div>
      </div>
      <div>
        <h3>生成产物</h3>
        <div class="linked-list">
          ${
            (data.artifacts || []).length
              ? data.artifacts
                  .map(
                    (artifact) => `
                      <div class="linked-item">
                        <div>
                          <strong>${escapeHtml(artifact.title)}</strong>
                          <p class="muted">${escapeHtml(artifact.status)} · ${escapeHtml(artifact.obsidian_path)}</p>
                        </div>
                      </div>
                    `
                  )
                  .join("")
              : `<p class="muted">暂无生成产物。</p>`
          }
        </div>
      </div>
    </section>
    <section class="panel project-match-panel">
      <div class="panel-title">
        <h2>项目候选论文</h2>
        <p>${projectMatches.length} matches</p>
      </div>
      <div class="project-match-list">
        ${
          projectMatches.length
            ? projectMatches
                .map(
                  (match) => `
                    <article class="project-match-item">
                      <div class="project-match-head">
                        <div>
                          <strong>${escapeHtml(match.title)}</strong>
                          <p class="muted">${escapeHtml(match.arxiv_id)} · score ${fmtScore(match.score)} · ${escapeHtml((match.searchers || []).join(", ") || "matched")}</p>
                        </div>
                        <a href="${escapeHtml(match.link || "#")}" target="_blank" rel="noreferrer">打开</a>
                      </div>
                      <div class="project-match-evidence">
                        <p><span>论文</span>${escapeHtml(snippet(match.arxiv_text || match.evidence?.arxiv_text))}</p>
                        <p><span>项目</span>${escapeHtml(snippet(`${match.note_title || ""} ${match.obsidian_heading || ""} ${match.obsidian_text || ""}`))}</p>
                        <p class="muted">${escapeHtml(match.note_path || "项目上下文")} · chunk ${escapeHtml(match.best_obsidian_chunk_id || "")}</p>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<p class="muted">暂无基于项目上下文匹配到的论文。</p>`
        }
      </div>
    </section>
    <section class="panel resource-panel">
      <div class="panel-title">
        <h2>关联信息</h2>
        <p>${project.paper_count || 0} papers · ${project.note_count || 0} notes</p>
      </div>
      <div class="link-grid">
        <form class="link-form" data-link-paper>
          <label>
            <span>加入论文</span>
            <select name="paper_id">
              ${
                candidatePapers.length
                  ? candidatePapers
                      .map((paper) => `<option value="${paper.id}">${escapeHtml(compactLabel(`${paper.arxiv_id} · ${paper.title}`))}</option>`)
                      .join("")
                  : `<option value="">无可选论文</option>`
              }
            </select>
          </label>
          <label>
            <span>关系</span>
            <select name="relation">${relationOptions(PROJECT_PAPER_RELATIONS, "candidate")}</select>
          </label>
          <button type="submit" ${candidatePapers.length ? "" : "disabled"}>加入</button>
        </form>
        <form class="link-form" data-link-note>
          <label>
            <span>加入笔记</span>
            <select name="note_id">
              ${
                candidateNotes.length
                  ? candidateNotes
                      .map((note) => `<option value="${note.id}">${escapeHtml(compactLabel(`${note.title} · ${note.path}`))}</option>`)
                      .join("")
                  : `<option value="">无可选笔记</option>`
              }
            </select>
          </label>
          <label>
            <span>关系</span>
            <select name="relation">${relationOptions(PROJECT_NOTE_RELATIONS, "source")}</select>
          </label>
          <button type="submit" ${candidateNotes.length ? "" : "disabled"}>加入</button>
        </form>
      </div>
      <div class="resource-columns">
        <div>
          <h3>项目论文</h3>
          <div class="linked-list">
            ${
              linkedPapers.length
                ? linkedPapers
                    .map(
                      (paper) => `
                        <div class="linked-item">
                          <div>
                            <strong>${escapeHtml(paper.title)}</strong>
                            <p class="muted">${escapeHtml(paper.relation)} · ${escapeHtml(paper.arxiv_id)}${paper.project_score ? ` · score ${fmtScore(paper.project_score)}` : ""}</p>
                            ${paper.note ? `<p class="muted">${escapeHtml(paper.note)}</p>` : ""}
                          </div>
                          <button type="button" data-unlink-paper="${paper.id}">移除</button>
                        </div>
                      `
                    )
                    .join("")
                : `<p class="muted">暂无关联论文。</p>`
            }
          </div>
        </div>
        <div>
          <h3>项目笔记</h3>
          <div class="linked-list">
            ${
              linkedNotes.length
                ? linkedNotes
                    .map(
                      (note) => `
                        <div class="linked-item">
                          <div>
                            <strong>${escapeHtml(note.title)}</strong>
                            <p class="muted">${escapeHtml(note.relation)} · ${escapeHtml(note.path)}</p>
                            ${note.note ? `<p class="muted">${escapeHtml(note.note)}</p>` : ""}
                          </div>
                          <button type="button" data-unlink-note="${note.id}">移除</button>
                        </div>
                      `
                    )
                    .join("")
                : `<p class="muted">暂无关联 Obsidian 笔记。</p>`
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

async function loadProjects() {
  const [data, history, status] = await Promise.all([
    api("/api/projects"),
    api("/api/jobs/history?limit=12"),
    api("/api/jobs/status")
  ]);
  projects = data.items || [];
  projectActivities = history.items || [];
  projectJobStatus = status.scheduler || {};
  renderProjects();
  if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
    await loadProject(activeProjectId);
  } else if (projects.length) {
    await loadProject(projects[0].id);
  } else {
    activeProjectId = null;
    activeProjectData = null;
    renderProjectDashboard();
  }
}

async function loadProject(id) {
  const data = await api(`/api/projects/${id}`);
  renderProjectDetail(data);
}

function showNewProjectForm() {
  activeProjectId = null;
  activeProjectData = null;
  renderProjects();
  renderProjectDashboard();
  projectDetail.className = "project-detail-stack";
  projectDetail.innerHTML = projectForm({
    status: "active",
    keywords: [],
    source_tags: [],
    arxiv_categories: [],
    automation: {
      auto_link_papers: false,
      generate_paper_cards: true,
      generate_project_digest: true,
      sync_experiment_notes: true
    }
  });
}

function renderInbox() {
  inboxMeta.textContent = `${papers.length} recommendations`;
  if (!papers.length) {
    paperList.innerHTML = `<div class="paper-card"><h2>还没有推荐</h2><div class="card-meta">先在“配置与任务”里保存配置，再执行 run-daily。</div></div>`;
    return;
  }

  paperList.innerHTML = papers
    .map((paper) => {
      const active = paper.id === activePaperId ? " active" : "";
      const status = paper.feedback_status ? `<span class="pill">${escapeHtml(paper.feedback_status)}</span>` : "";
      return `
        <button class="paper-card${active}" data-paper-id="${paper.id}">
          <h2>${escapeHtml(paper.title)}</h2>
          <div class="card-meta">
            <span class="pill score">${fmtScore(paper.score)}</span>
            <span class="pill">${escapeHtml((paper.categories || []).slice(0, 2).join(", ") || "arXiv")}</span>
            ${status}
          </div>
        </button>
      `;
    })
    .join("");
}

function renderDetail(data) {
  const paper = data.paper;
  const explanation = data.explanation || {};
  const evidence = data.evidence || [];
  activePaperId = paper.id;
  renderInbox();

  paperDetail.className = "detail-card";
  paperDetail.innerHTML = `
    <div class="detail-main">
      <div class="detail-title">
        <h2>${escapeHtml(paper.title)}</h2>
        <p class="muted">${escapeHtml((paper.authors || []).slice(0, 6).join(", "))}</p>
        <p class="muted">
          <a href="${escapeHtml(paper.link)}" target="_blank" rel="noreferrer">${escapeHtml(paper.arxiv_id)}</a>
          · ${escapeHtml((paper.categories || []).join(", "))}
        </p>
        <p class="muted">
          TXT: ${escapeHtml(paper.text_status || "pending")}
          ${paper.text_path ? `· ${escapeHtml(paper.text_path)}` : ""}
        </p>
      </div>

      <div class="detail-actions">
        <button data-status="relevant">Relevant</button>
        <button data-status="not_relevant">Not relevant</button>
        <button data-status="read_later">Read later</button>
        <button data-status="read">Read</button>
        <button data-status="favorite">Favorite</button>
      </div>

      <div class="section">
        <h3>Recommendation</h3>
        <p class="summary">${escapeHtml(explanation.recommendation_reason || "No explanation generated yet.")}</p>
      </div>

      <div class="section">
        <h3>Abstract</h3>
        <p class="summary">${escapeHtml(paper.summary)}</p>
      </div>

      <div class="section">
        <h3>Evidence</h3>
        <div class="evidence-list">
          ${
            evidence.length
              ? evidence
                  .map(
                    (item) => `
                      <article class="evidence">
                        <strong>${escapeHtml(item.note_title || item.note_path)} · ${fmtScore(item.score)}</strong>
                        ${
                          item.arxiv_text
                            ? `<p class="muted">Paper chunk ${escapeHtml(item.arxiv_chunk_index ?? "")}${item.arxiv_page_start ? ` · pages ${escapeHtml(item.arxiv_page_start)}-${escapeHtml(item.arxiv_page_end || item.arxiv_page_start)}` : ""}</p>
                               <p>${escapeHtml(item.arxiv_text.slice(0, 700))}</p>`
                            : ""
                        }
                        <p class="muted">Matched note chunk</p>
                        <p>${escapeHtml(item.text)}</p>
                        <p class="muted">${escapeHtml((item.searchers || []).join(", "))}</p>
                      </article>
                    `
                  )
                  .join("")
              : `<p class="muted">No evidence chunks found.</p>`
          }
        </div>
      </div>
    </div>
  `;
}

async function loadInbox() {
  inboxMeta.textContent = "Loading recommendations...";
  const data = await api("/api/inbox");
  papers = data.items || [];
  if (!activePaperId && papers.length) activePaperId = papers[0].id;
  renderInbox();
  if (activePaperId) await loadPaper(activePaperId);
}

async function loadPaper(id) {
  const data = await api(`/api/papers/${id}`);
  renderDetail(data);
}

function hydrateSettings(settings) {
  const set = (name, value) => {
    const input = settingsForm.elements[name];
    if (!input) return;
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = csv(value);
    }
  };
  Object.entries(settings).forEach(([key, value]) => {
    if (key !== "llm_providers") set(key, value);
  });
  renderProviders(settings.llm_providers || []);
  refreshLLMSelectors({
    chatProviderId: settings.llm_chat_provider_id,
    chatModel: settings.llm_chat_model,
    embeddingProviderId: settings.llm_embedding_provider_id,
    embeddingModel: settings.llm_embedding_model
  });
  settingsHydrated = true;
}

function providerTemplate(provider = {}) {
  const keyText = provider.api_key_configured ? "API key 已保存；留空不修改。" : "尚未保存 API key。";
  return `
    <div class="provider-row" data-provider-row>
      <label>
        <span>ID</span>
        <input data-provider-field="id" value="${escapeHtml(provider.id || "")}" placeholder="qwen" />
      </label>
      <label>
        <span>名称</span>
        <input data-provider-field="name" value="${escapeHtml(provider.name || "")}" placeholder="Qwen" />
      </label>
      <label class="wide">
        <span>Base URL</span>
        <input data-provider-field="base_url" value="${escapeHtml(provider.base_url || "")}" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
      </label>
      <label>
        <span>API Key</span>
        <input data-provider-field="api_key" type="password" placeholder="${escapeHtml(keyText)}" />
      </label>
      <label class="wide">
        <span>Chat models</span>
        <input data-provider-field="chat_models" value="${escapeHtml(csv(provider.chat_models))}" placeholder="qwen-plus,qwen-max" />
      </label>
      <label class="wide">
        <span>Embedding models</span>
        <input data-provider-field="embedding_models" value="${escapeHtml(csv(provider.embedding_models))}" placeholder="text-embedding-v4" />
      </label>
      <label class="checkbox-line">
        <input data-provider-field="clear_api_key" type="checkbox" />
        <span>清除 key</span>
      </label>
      <div class="provider-actions">
        <button type="button" data-remove-provider>移除</button>
      </div>
    </div>
  `;
}

function renderProviders(providers) {
  const rows = providers.length
    ? providers
    : [{ id: "default", name: "Default", base_url: "", chat_models: [], embedding_models: [] }];
  llmProviders.innerHTML = rows.map(providerTemplate).join("");
}

function collectProviders() {
  return Array.from(llmProviders.querySelectorAll("[data-provider-row]"))
    .map((row) => {
      const value = (field) => row.querySelector(`[data-provider-field="${field}"]`);
      return {
        id: value("id")?.value.trim() || "",
        name: value("name")?.value.trim() || "",
        base_url: value("base_url")?.value.trim() || "",
        api_key: value("api_key")?.value || "",
        clear_api_key: Boolean(value("clear_api_key")?.checked),
        chat_models: splitCsv(value("chat_models")?.value),
        embedding_models: splitCsv(value("embedding_models")?.value)
      };
    })
    .filter((provider) => provider.id);
}

function optionList(values, selected) {
  if (!values.length) return `<option value="">未配置</option>`;
  return values
    .map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

function refreshLLMSelectors(selected = {}) {
  const providers = collectProviders();
  const providerOptions = providers
    .map((provider) => {
      const label = provider.name || provider.id;
      return `<option value="${escapeHtml(provider.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  chatProviderSelect.innerHTML = providerOptions || `<option value="">未配置</option>`;
  embeddingProviderSelect.innerHTML = providerOptions || `<option value="">未配置</option>`;

  if (selected.chatProviderId) chatProviderSelect.value = selected.chatProviderId;
  if (selected.embeddingProviderId) embeddingProviderSelect.value = selected.embeddingProviderId;

  const chatProvider = providers.find((provider) => provider.id === chatProviderSelect.value);
  const embeddingProvider = providers.find((provider) => provider.id === embeddingProviderSelect.value);
  chatModelSelect.innerHTML = optionList(chatProvider?.chat_models || [], selected.chatModel);
  embeddingModelSelect.innerHTML = optionList(embeddingProvider?.embedding_models || [], selected.embeddingModel);
}

function renderScheduler(status) {
  const scheduler = status.scheduler || {};
  const startupDaily = scheduler.startup_daily || {};
  const current = scheduler.current_job;
  const activeMode = scheduler.enabled ? "scheduler" : startupDaily.enabled ? "startup" : "off";
  document.querySelectorAll("[data-run-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.runMode === activeMode);
  });
  if (scheduler.enabled) {
    schedulerSummary.textContent = `定时执行 · 下次执行 ${fmtDate(scheduler.next_run_at)}`;
  } else if (startupDaily.enabled) {
    schedulerSummary.textContent = startupDaily.last_skip_reason === "already_completed_today"
      ? "启动执行 · 今日已完成"
      : "启动执行 · 每日首次启动 dashboard 时运行";
  } else {
    schedulerSummary.textContent = "未启用";
  }
  jobStatus.textContent = current
    ? `Running ${current.command}...`
    : scheduler.last_job?.message || scheduler.last_error?.message || "Idle";
}

function healthItem(label, value, state = "neutral") {
  return `
    <div class="health-item ${state}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderHealth(health) {
  const obsidianState = health.obsidian?.status === "ok" ? "ok" : "warn";
  const llmState = health.llm?.configured ? "ok" : "warn";
  const counts = health.counts || {};
  healthGrid.innerHTML = [
    healthItem("Database", health.database?.ok ? "OK" : "Error", health.database?.ok ? "ok" : "bad"),
    healthItem("Obsidian", health.obsidian?.status || "unknown", obsidianState),
    healthItem("LLM", health.llm?.configured ? `${health.llm.providers?.length || 0} providers` : "Not configured", llmState),
    healthItem("Notes", counts.notes ?? 0),
    healthItem("Projects", counts.projects ?? 0),
    healthItem("Project Artifacts", counts.project_artifacts ?? 0),
    healthItem("Chunks", counts.chunks ?? 0),
    healthItem("Papers", counts.papers ?? 0),
    healthItem("Paper Embeddings", counts.paper_embeddings ?? 0),
    healthItem("Paper TXT", counts.paper_texts ?? 0),
    healthItem("Paper Chunks", counts.paper_chunks ?? 0),
    healthItem("Chunk Embeddings", counts.paper_chunk_embeddings ?? 0),
    healthItem("Prefilter Runs", counts.prefilter_runs ?? 0),
    healthItem("Matches", counts.matches ?? 0),
    healthItem("Latest job", health.latest_job?.status || "none", health.latest_job?.status === "failed" ? "bad" : "neutral")
  ].join("");
}

function renderHistory(history) {
  const items = history.items || [];
  if (!items.length) {
    historyTable.innerHTML = `<p class="muted">暂无任务记录。</p>`;
    return;
  }
  historyTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>任务</th>
          <th>状态</th>
          <th>开始</th>
          <th>结束</th>
          <th>结果</th>
        </tr>
      </thead>
      <tbody>
        ${items
          .map(
            (item) => `
              <tr>
                <td>${escapeHtml(item.job_type)}</td>
                <td><span class="pill ${item.status === "failed" ? "bad-pill" : ""}">${escapeHtml(item.status)}</span></td>
                <td>${fmtDate(item.started_at)}</td>
                <td>${fmtDate(item.finished_at)}</td>
                <td>${escapeHtml(item.message || summarizeMeta(item.meta))}</td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function summarizeMeta(meta = {}) {
  const pairs = Object.entries(meta).slice(0, 4);
  return pairs.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

async function loadControl({ hydrate = false } = {}) {
  const [settingsData, status, health, history] = await Promise.all([
    api("/api/settings"),
    api("/api/jobs/status"),
    api("/api/health"),
    api("/api/jobs/history")
  ]);
  if (hydrate) hydrateSettings(settingsData.settings || {});
  renderScheduler(status);
  renderHealth(health);
  renderHistory(history);
}

function collectSettings() {
  const formData = new FormData(settingsForm);
  const payload = {};
  for (const [key, value] of formData.entries()) {
    payload[key] = value;
  }
  payload.arxiv_cache_full_text = settingsForm.elements.arxiv_cache_full_text.checked;
  payload.rag_prefilter_enabled = settingsForm.elements.rag_prefilter_enabled.checked;
  payload.scheduler_enabled = settingsForm.elements.scheduler_enabled.checked;
  payload.run_daily_on_startup_enabled = settingsForm.elements.run_daily_on_startup_enabled.checked;
  if (payload.scheduler_enabled && payload.run_daily_on_startup_enabled) {
    payload.run_daily_on_startup_enabled = false;
  }
  payload.llm_providers = collectProviders();
  return payload;
}

async function runJob(name, endpoint = `/api/jobs/${name}`) {
  jobStatus.textContent = `Running ${name}...`;
  try {
    const data = await api(endpoint, { method: "POST" });
    jobStatus.textContent = data.message || `${name} finished`;
    await Promise.all([loadInbox(), loadProjects(), loadControl({ hydrate: false })]);
  } catch (error) {
    showError(error);
  }
}

function showError(error) {
  jobStatus.textContent = error.message;
}

paperList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-paper-id]");
  if (!button) return;
  loadPaper(button.dataset.paperId).catch(showError);
});

paperDetail.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-status]");
  if (!button || !activePaperId) return;
  const status = button.dataset.status;
  await api(`/api/papers/${activePaperId}/feedback`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
  jobStatus.textContent = `Marked ${status}`;
  await loadInbox();
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

projectBoard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-id]");
  if (!button) return;
  loadProject(button.dataset.projectId).catch(showError);
});

newProjectButton.addEventListener("click", showNewProjectForm);

projectDetail.addEventListener("submit", async (event) => {
  const form = event.target.closest("#projectForm");
  const paperLinkForm = event.target.closest("[data-link-paper]");
  const noteLinkForm = event.target.closest("[data-link-note]");
  if (form) {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
      name: formData.get("name"),
      status: formData.get("status"),
      keywords: splitCsv(formData.get("keywords")),
      obsidian_project_path: formData.get("obsidian_project_path"),
      obsidian_output_dir: formData.get("obsidian_output_dir"),
      source_tags: splitCsv(formData.get("source_tags")),
      arxiv_categories: splitCsv(formData.get("arxiv_categories")),
      automation: {
        auto_link_papers: formData.has("auto_link_papers"),
        generate_paper_cards: formData.has("generate_paper_cards"),
        generate_project_digest: formData.has("generate_project_digest"),
        sync_experiment_notes: formData.has("sync_experiment_notes")
      }
    };
    if (activeProjectId) payload.id = activeProjectId;
    try {
      const data = await api(activeProjectId ? `/api/projects/${activeProjectId}` : "/api/projects", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      jobStatus.textContent = "Project saved";
      await loadProjects();
      await loadProject(data.project.id);
    } catch (error) {
      showError(error);
    }
    return;
  }
  if ((paperLinkForm || noteLinkForm) && activeProjectId) {
    event.preventDefault();
    const linkForm = paperLinkForm || noteLinkForm;
    const formData = new FormData(linkForm);
    const payload = paperLinkForm
      ? {
          paper_id: formData.get("paper_id"),
          relation: formData.get("relation")
        }
      : {
          note_id: formData.get("note_id"),
          relation: formData.get("relation")
        };
    const endpoint = paperLinkForm ? "papers" : "notes";
    try {
      const data = await api(`/api/projects/${activeProjectId}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      jobStatus.textContent = paperLinkForm ? "Paper linked" : "Note linked";
      await loadProjects();
      renderProjectDetail(data);
    } catch (error) {
      showError(error);
    }
  }
});

projectDetail.addEventListener("click", async (event) => {
  const exportButton = event.target.closest("[data-export-project]");
  const paperButton = event.target.closest("[data-unlink-paper]");
  const noteButton = event.target.closest("[data-unlink-note]");
  if (!activeProjectId || (!exportButton && !paperButton && !noteButton)) return;
  if (exportButton) {
    try {
      const data = await api(`/api/projects/${activeProjectId}/export-obsidian`, { method: "POST" });
      jobStatus.textContent = `Synced ${data.export?.obsidian_path || "project index"}`;
      await loadProjects();
      renderProjectDetail(data);
    } catch (error) {
      showError(error);
    }
    return;
  }
  const endpoint = paperButton
    ? `/api/projects/${activeProjectId}/papers/${paperButton.dataset.unlinkPaper}`
    : `/api/projects/${activeProjectId}/notes/${noteButton.dataset.unlinkNote}`;
  try {
    const data = await api(endpoint, { method: "DELETE" });
    jobStatus.textContent = paperButton ? "Paper removed from project" : "Note removed from project";
    await loadProjects();
    renderProjectDetail(data);
  } catch (error) {
    showError(error);
  }
});

document.querySelectorAll("[data-job]").forEach((button) => {
  button.addEventListener("click", () => runJob(button.dataset.job));
});

addProviderButton.addEventListener("click", () => {
  llmProviders.insertAdjacentHTML("beforeend", providerTemplate({}));
  refreshLLMSelectors();
});

llmProviders.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-provider]");
  if (!button) return;
  button.closest("[data-provider-row]")?.remove();
  if (!llmProviders.querySelector("[data-provider-row]")) {
    renderProviders([]);
  }
  refreshLLMSelectors();
});

llmProviders.addEventListener("input", () => {
  refreshLLMSelectors({
    chatProviderId: chatProviderSelect.value,
    chatModel: chatModelSelect.value,
    embeddingProviderId: embeddingProviderSelect.value,
    embeddingModel: embeddingModelSelect.value
  });
});

chatProviderSelect.addEventListener("change", () => {
  refreshLLMSelectors({
    chatProviderId: chatProviderSelect.value,
    embeddingProviderId: embeddingProviderSelect.value,
    embeddingModel: embeddingModelSelect.value
  });
});

embeddingProviderSelect.addEventListener("change", () => {
  refreshLLMSelectors({
    chatProviderId: chatProviderSelect.value,
    chatModel: chatModelSelect.value,
    embeddingProviderId: embeddingProviderSelect.value
  });
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  jobStatus.textContent = "Saving settings...";
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify(collectSettings())
    });
    jobStatus.textContent = "Settings saved";
    await loadControl({ hydrate: true });
  } catch (error) {
    showError(error);
  }
});

settingsForm.elements.run_daily_on_startup_enabled.addEventListener("change", (event) => {
  if (event.target.checked) {
    settingsForm.elements.scheduler_enabled.checked = false;
  }
});

settingsForm.elements.scheduler_enabled.addEventListener("change", (event) => {
  if (event.target.checked) {
    settingsForm.elements.run_daily_on_startup_enabled.checked = false;
  }
});

startStartupDailyButton.addEventListener("click", async () => {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        run_daily_on_startup_enabled: true,
        scheduler_enabled: false
      })
    });
    settingsForm.elements.run_daily_on_startup_enabled.checked = true;
    settingsForm.elements.scheduler_enabled.checked = false;
    await loadControl({ hydrate: false });
  } catch (error) {
    showError(error);
  }
});

startSchedulerButton.addEventListener("click", async () => {
  try {
    await api("/api/jobs/scheduler/start", { method: "POST" });
    settingsForm.elements.run_daily_on_startup_enabled.checked = false;
    settingsForm.elements.scheduler_enabled.checked = true;
    await loadControl({ hydrate: false });
  } catch (error) {
    showError(error);
  }
});

stopSchedulerButton.addEventListener("click", async () => {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        run_daily_on_startup_enabled: false,
        scheduler_enabled: false
      })
    });
    settingsForm.elements.run_daily_on_startup_enabled.checked = false;
    settingsForm.elements.scheduler_enabled.checked = false;
    await loadControl({ hydrate: false });
  } catch (error) {
    showError(error);
  }
});

runNowButton.addEventListener("click", () => runJob("run-daily", "/api/jobs/run-now"));

refreshButton.addEventListener("click", () => loadInbox().catch(showError));
refreshControlButton.addEventListener("click", () => loadControl({ hydrate: false }).catch(showError));

setInterval(async () => {
  if (dashboardRefreshInFlight) return;
  dashboardRefreshInFlight = true;
  try {
    if (activeView === "control") {
      await loadControl({ hydrate: false }).catch(showError);
    } else if (activeView === "projects") {
      await loadProjects().catch(showError);
    }
  } finally {
    dashboardRefreshInFlight = false;
  }
}, 5000);

loadProjects().catch(showError);
}
