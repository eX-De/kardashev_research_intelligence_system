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
const AUTH_REQUIRED_CODE = "auth_required";
const NON_JSON_RESPONSE = "__nonJsonResponse";

export const AUTH_REQUIRED_EVENT = "panel-auth-required";

function cleanMessage(value) {
  const message = String(value ?? "").replace(/\s+/g, " ").trim();
  return message.length > 220 ? `${message.slice(0, 219)}...` : message;
}

function isAuthRequiredValue(value) {
  return cleanMessage(value) === AUTH_REQUIRED_CODE;
}

function isAuthRequiredPayload(data) {
  if (!data) return false;
  if (typeof data === "string") return isAuthRequiredValue(data);
  return [data.code, data.reason, data.error, data.message].some(isAuthRequiredValue);
}

export function isAuthRequiredResponse(response, data) {
  return Number(response?.status) === 401 && isAuthRequiredPayload(data);
}

export function isAuthRequiredError(error) {
  return [
    error?.code,
    error?.reason,
    error?.data?.code,
    error?.data?.reason,
    error?.data?.error,
    error?.data?.message
  ].some(isAuthRequiredValue) || (Number(error?.status) === 401 && isAuthRequiredPayload(error?.data));
}

export function emitAuthRequired(detail = {}) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  const event = typeof window.CustomEvent === "function"
    ? new window.CustomEvent(AUTH_REQUIRED_EVENT, { detail })
    : new Event(AUTH_REQUIRED_EVENT);
  window.dispatchEvent(event);
}

export async function readResponseJson(response) {
  const body = await response.text().catch(() => "");
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return {
      [NON_JSON_RESPONSE]: true,
      error: cleanMessage(body)
    };
  }
}

export function isNonJsonResponse(data) {
  return Boolean(data?.[NON_JSON_RESPONSE]);
}

function responseErrorMessage(response, data, fallback = "Request failed") {
  return cleanMessage(data?.error || data?.message || data?.detail || data?.reason || data?.code)
    || (response?.status ? cleanMessage(`HTTP ${response.status} ${response.statusText || ""}`) : "")
    || fallback;
}

export function createApiError(response, data, fallback = "Request failed") {
  const authRequired = isAuthRequiredResponse(response, data);
  let message = authRequired ? responseErrorMessage(response, data, "请先登录。") : responseErrorMessage(response, data, fallback);
  if (authRequired && message === AUTH_REQUIRED_CODE) message = "请先登录。";
  const error = new Error(message);
  error.name = authRequired ? "AuthRequiredError" : "ApiError";
  error.status = response?.status;
  error.statusText = response?.statusText;
  error.code = data?.code || (authRequired ? AUTH_REQUIRED_CODE : undefined);
  error.reason = data?.reason;
  error.data = data;
  return error;
}

function requestHeaders(headers) {
  const nextHeaders = new Headers(headers || {});
  if (!nextHeaders.has("content-type")) nextHeaders.set("content-type", "application/json");
  return nextHeaders;
}

export async function api(path, options = {}) {
  const { headers, ...restOptions } = options;
  const response = await fetch(path, {
    ...restOptions,
    credentials: "same-origin",
    headers: requestHeaders(headers)
  });
  const data = await readResponseJson(response);
  if (!response.ok || isNonJsonResponse(data)) {
    const error = createApiError(response, data);
    if (isAuthRequiredError(error)) emitAuthRequired({ path, status: response.status, data });
    throw error;
  }
  return data || {};
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
    "resume-daily": "恢复每日流程",
    "retry-daily": "历史论文补跑",
    "fetch-arxiv": "arXiv 抓取",
    "cache-arxiv-text": "论文正文缓存",
    "generate-paper-reports": "全文报告生成",
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
