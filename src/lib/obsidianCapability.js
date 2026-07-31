import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useCachedApi } from "./apiCache.jsx";
import {
  api,
  createApiError,
  emitAuthRequired,
  isAuthRequiredError,
  isNonJsonResponse,
  readResponseJson
} from "./dashboard.js";

export const OBSIDIAN_OPTIONAL_SETUP_MESSAGE = "Obsidian is optional. Configure a usable vault path in Settings to export or select paths inside the vault.";
export const OBSIDIAN_PATH_MISSING_MESSAGE = "The configured Obsidian vault path is unavailable. Check it in Settings.";

function localized(t, key, fallback, values = {}) {
  return typeof t === "function"
    ? t(`system:obsidian.${key}`, { ...values, defaultValue: fallback })
    : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

export function obsidianCapabilityFrom({ health, settings, t } = {}) {
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
      label: status === "remote_configured" ? localized(t, "remote", "Remote") : status === "ok" ? "OK" : localized(t, "configured", "Configured"),
      path: vaultPath || remotePath,
      state: status === "remote_configured" || status === "ok" ? "ok" : "neutral",
      status: status || "configured"
    };
  }

  if (!configured || status === "not_configured") {
    return {
      available: false,
      configured: false,
      disabledReason: localized(t, "optionalSetup", OBSIDIAN_OPTIONAL_SETUP_MESSAGE),
      label: localized(t, "optionalNotConfigured", "Optional: not configured"),
      path: vaultPath,
      state: "neutral",
      status: status || "not_configured"
    };
  }

  if (status === "missing") {
    return {
      available: false,
      configured: true,
      disabledReason: localized(t, "pathMissing", OBSIDIAN_PATH_MISSING_MESSAGE),
      label: localized(t, "pathDoesNotExist", "Path does not exist"),
      path: vaultPath,
      state: "warn",
      status
    };
  }

  return {
    available: false,
    configured: true,
    disabledReason: localized(t, "pathMissing", OBSIDIAN_PATH_MISSING_MESSAGE),
    label: status || localized(t, "unavailable", "Unavailable"),
    path: vaultPath || remotePath,
    state: "warn",
    status: status || "unavailable"
  };
}

export function useObsidianCapability({ health: providedHealth, settings, onError } = {}) {
  const { t } = useTranslation("system");
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
    () => obsidianCapabilityFrom({ health, settings, t }),
    [health, settings, t]
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

export function friendlyObsidianMessage(error, t = null) {
  const message = errorText(error);
  if (isObsidianNotConfiguredError(error)) return localized(t, "optionalSetup", OBSIDIAN_OPTIONAL_SETUP_MESSAGE);
  if (/obsidian vault path does not exist/i.test(message)) return localized(t, "pathMissing", OBSIDIAN_PATH_MISSING_MESSAGE);
  return text(error?.message) || localized(t, "operationFailed", "Obsidian operation failed.");
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
    const error = createApiError(response, data, failureReason || "Obsidian operation failed.");
    if (isAuthRequiredError(error)) emitAuthRequired({ path, status: response.status, data });
    throw error;
  }
  return data || {};
}
