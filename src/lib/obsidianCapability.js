import { useEffect, useMemo } from "react";

import { useCachedApi } from "./apiCache.jsx";
import {
  api,
  createApiError,
  emitAuthRequired,
  isAuthRequiredError,
  isNonJsonResponse,
  readResponseJson
} from "./dashboard.js";

export const OBSIDIAN_OPTIONAL_SETUP_MESSAGE = "Obsidian 是可选集成；如需导出或选择 vault 内路径，请先在设置页填写可用的 vault 路径。";
export const OBSIDIAN_PATH_MISSING_MESSAGE = "当前 Obsidian vault 路径不可用，请在设置页检查路径。";

function text(value) {
  return String(value ?? "").trim();
}

export function obsidianCapabilityFrom({ health, settings } = {}) {
  const obsidian = health?.obsidian || {};
  const status = text(obsidian.status);
  const remote = obsidian.remote || {};
  const vaultPath = text(settings?.obsidian_vault_path || obsidian.path);
  const remotePath = text(remote.bucket ? `${remote.backend || "remote"}:${remote.bucket}/${remote.prefix || ""}` : "");
  const configured = Boolean(vaultPath || remotePath || obsidian.configured || status === "ok" || status === "remote_configured" || status === "missing" || (status && status !== "not_configured"));
  const available = status === "ok" || status === "remote_configured" || (!status && Boolean(vaultPath));

  if (available) {
    return {
      available: true,
      configured: true,
      disabledReason: "",
      label: status === "remote_configured" ? "远端" : status === "ok" ? "OK" : "已配置",
      path: vaultPath || remotePath,
      state: status === "remote_configured" || status === "ok" ? "ok" : "neutral",
      status: status || "configured"
    };
  }

  if (!configured || status === "not_configured") {
    return {
      available: false,
      configured: false,
      disabledReason: OBSIDIAN_OPTIONAL_SETUP_MESSAGE,
      label: "可选：未配置",
      path: vaultPath,
      state: "neutral",
      status: status || "not_configured"
    };
  }

  if (status === "missing") {
    return {
      available: false,
      configured: true,
      disabledReason: OBSIDIAN_PATH_MISSING_MESSAGE,
      label: "路径不存在",
      path: vaultPath,
      state: "warn",
      status
    };
  }

  return {
    available: false,
    configured: true,
    disabledReason: OBSIDIAN_PATH_MISSING_MESSAGE,
    label: status || "不可用",
    path: vaultPath || remotePath,
    state: "warn",
    status: status || "unavailable"
  };
}

export function useObsidianCapability({ health: providedHealth, settings, onError } = {}) {
  const healthQuery = useCachedApi(
    ["health", "summary"],
    () => api("/api/health/summary"),
    { enabled: !providedHealth, staleTime: 60000 }
  );

  useEffect(() => {
    if (!providedHealth && healthQuery.error) onError?.(healthQuery.error);
  }, [healthQuery.error, onError, providedHealth]);

  const health = providedHealth || healthQuery.data || null;

  return useMemo(
    () => obsidianCapabilityFrom({ health, settings }),
    [health, settings]
  );
}

function errorText(error) {
  return [
    error?.code,
    error?.reason,
    error?.data?.code,
    error?.data?.reason,
    error?.data?.error,
    error?.message,
    error
  ].map(text).filter(Boolean).join(" ");
}

export function isObsidianNotConfiguredError(error) {
  return /obsidian_not_configured|obsidian vault path is not configured|请先选择或填写 Obsidian vault 路径/i.test(errorText(error));
}

export function friendlyObsidianMessage(error) {
  const message = errorText(error);
  if (isObsidianNotConfiguredError(error)) return OBSIDIAN_OPTIONAL_SETUP_MESSAGE;
  if (/obsidian vault path does not exist/i.test(message)) return OBSIDIAN_PATH_MISSING_MESSAGE;
  return text(error?.message) || "Obsidian 操作失败。";
}

export async function postObsidianJson(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await readResponseJson(response);
  const failureReason = data?.reason || data?.code;
  if (!response.ok || isNonJsonResponse(data) || failureReason === "obsidian_not_configured") {
    const error = createApiError(response, data, failureReason || "Obsidian 操作失败。");
    if (isAuthRequiredError(error)) emitAuthRequired({ path, status: response.status, data });
    throw error;
  }
  return data || {};
}
