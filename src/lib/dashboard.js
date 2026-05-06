export const PROJECT_STATUSES = [
  ["active", "进行中"],
  ["planned", "计划中"],
  ["completed", "已完成"],
  ["paused", "搁置"],
  ["exploring", "探索中"],
  ["writing", "写作中"],
  ["archived", "归档"]
];

export const PROJECT_PAPER_RELATIONS = [
  ["candidate", "候选"],
  ["reading", "阅读中"],
  ["core", "核心文献"],
  ["background", "背景资料"],
  ["rejected", "已排除"]
];

export const PROJECT_NOTE_RELATIONS = [
  ["source", "资料"],
  ["idea", "想法"],
  ["method", "方法"],
  ["result", "结果"],
  ["todo", "待办"],
  ["center_page", "中心页"],
  ["folder_member", "项目文件夹"]
];

const PROJECT_STATUS_LABELS = Object.fromEntries(PROJECT_STATUSES);

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

export async function postJson(path, body = {}) {
  return api(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function fmtScore(value) {
  if (value === null || value === undefined) return "0.00";
  return Number(value).toFixed(2);
}

export function fmtDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

export function csv(value) {
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

export function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function compactLabel(value, size = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > size ? `${text.slice(0, size - 1)}...` : text;
}

export function snippet(value, size = 180) {
  return compactLabel(value, size);
}

export function statusLabel(status) {
  return PROJECT_STATUS_LABELS[status] || status || "未知";
}

export function metaNumber(meta = {}, keys = []) {
  for (const key of keys) {
    const value = Number(meta[key] || 0);
    if (value) return value;
  }
  return 0;
}

export function jobTitle(jobType) {
  const labels = {
    "run-daily": "每日流程",
    "fetch-arxiv": "arXiv 抓取",
    "cache-arxiv-text": "论文正文缓存",
    "generate-reports": "每日总报告生成",
    "sync-obsidian": "Obsidian 同步",
    "rank-papers": "论文匹配"
  };
  return labels[jobType] || jobType;
}

export function summarizeMeta(meta = {}) {
  return Object.entries(meta)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

export async function chooseLocalPath({ mode = "directory", title = "选择路径", relativeTo, basePath } = {}) {
  return postJson("/api/local-path/select", {
    mode,
    title,
    relative_to: relativeTo,
    base_path: basePath
  });
}
