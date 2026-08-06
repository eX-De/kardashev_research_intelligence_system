import { readFileSync } from "node:fs";

import { envValue } from "./env.js";
import { parseJson, query, toJson } from "./db.js";
import { updateNotification } from "./notifications.js";

const UPDATE_STATUS_SETTING = "app_update_status";
const DEFAULT_REPOSITORY = "exde1968/kardashev-research-intelligence-system";
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function currentAppVersion() {
  const override = envValue("KRIS_APP_VERSION", "").trim();
  if (override) return override.replace(/^v/, "");
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "")
      .trim().replace(/^v/, "");
  } catch {
    return "";
  }
}

function repository() {
  return envValue("KRIS_UPDATE_REPOSITORY", DEFAULT_REPOSITORY).trim().replace(/^\/+|\/+$/g, "") || DEFAULT_REPOSITORY;
}

function semverKey(value) {
  const match = SEMVER_RE.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

function newer(candidate, current) {
  const left = semverKey(candidate);
  const right = semverKey(current);
  if (!left || !right) return Boolean(candidate && current && candidate !== current);
  return left.some((part, index) => part !== right[index] && part > right[index] && left.slice(0, index).every((item, i) => item === right[i]));
}

async function githubJson(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "kris-update-checker" };
  const token = envValue("KRIS_GITHUB_TOKEN", "").trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return response.json();
}

export async function readUpdateStatus() {
  const result = await query("SELECT value_json FROM app_settings WHERE key = $1", [UPDATE_STATUS_SETTING]);
  const status = parseJson(result.rows?.[0]?.value_json, {});
  if (!Object.hasOwn(status, "available")) status.available = false;
  if (!Object.hasOwn(status, "current_version")) status.current_version = currentAppVersion();
  return { ...status, notification: updateNotification(status) };
}

export async function checkForUpdates() {
  const repo = repository();
  const currentVersion = currentAppVersion();
  const status = {
    ok: true, available: false, checked_at: new Date().toISOString(), current_version: currentVersion,
    repository: repo, latest_version: "", latest_tag: "", release_name: "", release_notes: "",
    release_url: "", published_at: "", source: "", error: ""
  };
  try {
    const [release, tagsPayload] = await Promise.all([
      githubJson(`/repos/${repo}/releases/latest`),
      githubJson(`/repos/${repo}/tags?per_page=100`)
    ]);
    const tags = Array.isArray(tagsPayload) ? tagsPayload : [];
    const candidates = tags.map((item) => String(item?.name || "")).filter((name) => semverKey(name));
    candidates.sort((a, b) => {
      const left = semverKey(a); const right = semverKey(b);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });
    const releaseTag = String(release?.tag_name || "").trim();
    const latestTag = candidates.at(-1) || releaseTag;
    const latestVersion = latestTag.replace(/^v/, "");
    Object.assign(status, {
      latest_tag: latestTag,
      latest_version: latestVersion,
      available: newer(latestVersion, currentVersion),
      source: latestTag ? "github_tag" : "",
      release_url: latestTag ? `https://github.com/${repo}/tree/${latestTag}` : ""
    });
    if (release && releaseTag === latestTag) {
      Object.assign(status, {
        release_name: String(release.name || latestTag),
        release_notes: String(release.body || "").slice(0, 8000),
        release_url: String(release.html_url || ""),
        published_at: String(release.published_at || ""),
        source: "github_release"
      });
    }
  } catch (error) {
    Object.assign(status, { ok: false, available: false, error: error.message });
  }
  await query(
    `INSERT INTO app_settings(key, value_json, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
    [UPDATE_STATUS_SETTING, toJson(status), status.checked_at]
  );
  return { ...status, notification: updateNotification(status) };
}
