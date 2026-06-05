from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .db import from_json, to_json, utc_now
from .env import env_value


UPDATE_STATUS_SETTING = "app_update_status"
UPDATE_NOTIFICATION_TYPE = "app_update_available"
DEFAULT_REPOSITORY = "exde1968/kardashev-research-intelligence-system"
SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")


def current_app_version() -> str:
    override = env_value("KRIS_APP_VERSION", "").strip()
    if override:
        return override.lstrip("v")
    package_path = Path("package.json")
    if not package_path.exists():
        return ""
    try:
        data = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    return str(data.get("version") or "").strip().lstrip("v")


def _repository() -> str:
    repo = env_value("KRIS_UPDATE_REPOSITORY", DEFAULT_REPOSITORY).strip().strip("/")
    return repo or DEFAULT_REPOSITORY


def _semver_key(value: Any) -> tuple[int, int, int] | None:
    match = SEMVER_RE.match(str(value or "").strip())
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def _newer(candidate: str, current: str) -> bool:
    candidate_key = _semver_key(candidate)
    current_key = _semver_key(current)
    if candidate_key and current_key:
        return candidate_key > current_key
    return bool(candidate and current and candidate != current)


def _fetch_json(url: str, *, timeout: float = 8.0) -> dict[str, Any] | list[Any]:
    headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "kris-update-checker",
    }
    token = env_value("KRIS_GITHUB_TOKEN", "").strip()
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _github_latest_release(repo: str) -> dict[str, Any] | None:
    try:
        data = _fetch_json(f"https://api.github.com/repos/{repo}/releases/latest")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    return data if isinstance(data, dict) else None


def _github_tags(repo: str) -> list[dict[str, Any]]:
    data = _fetch_json(f"https://api.github.com/repos/{repo}/tags?per_page=100")
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


def _latest_semver_tag(tags: list[dict[str, Any]]) -> str:
    candidates = []
    for tag in tags:
        name = str(tag.get("name") or "").strip()
        key = _semver_key(name)
        if key:
            candidates.append((key, name))
    if not candidates:
        return ""
    return max(candidates, key=lambda item: item[0])[1]


def _store_status(conn: Any, status: dict[str, Any]) -> dict[str, Any]:
    conn.execute(
        """
        INSERT INTO app_settings(key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
        """,
        (UPDATE_STATUS_SETTING, to_json(status), utc_now()),
    )
    conn.commit()
    return status


def read_update_status(conn: Any) -> dict[str, Any]:
    row = conn.execute(
        "SELECT value_json FROM app_settings WHERE key = ?",
        (UPDATE_STATUS_SETTING,),
    ).fetchone()
    status = from_json(row["value_json"], {}) if row else {}
    status = status if isinstance(status, dict) else {}
    status.setdefault("available", False)
    status.setdefault("current_version", current_app_version())
    return status


def check_for_updates(conn: Any) -> dict[str, Any]:
    repo = _repository()
    current_version = current_app_version()
    checked_at = utc_now()
    status: dict[str, Any] = {
        "ok": True,
        "available": False,
        "checked_at": checked_at,
        "current_version": current_version,
        "repository": repo,
        "latest_version": "",
        "latest_tag": "",
        "release_name": "",
        "release_notes": "",
        "release_url": "",
        "published_at": "",
        "source": "",
        "error": "",
    }
    try:
        release = _github_latest_release(repo)
        tags = _github_tags(repo)
        latest_tag = _latest_semver_tag(tags)
        release_tag = str((release or {}).get("tag_name") or "").strip()
        if not latest_tag and release_tag:
            latest_tag = release_tag
        latest_version = latest_tag.lstrip("v")
        status.update(
            {
                "latest_version": latest_version,
                "latest_tag": latest_tag,
                "source": "github_tag" if latest_tag else "",
                "available": _newer(latest_version, current_version),
            }
        )
        if release and release_tag == latest_tag:
            status.update(
                {
                    "release_name": str(release.get("name") or latest_tag),
                    "release_notes": str(release.get("body") or "")[:8000],
                    "release_url": str(release.get("html_url") or ""),
                    "published_at": str(release.get("published_at") or ""),
                    "source": "github_release",
                }
            )
        elif latest_tag:
            status["release_url"] = f"https://github.com/{repo}/tree/{latest_tag}"
    except Exception as exc:
        status.update({"ok": False, "error": str(exc), "available": False})
    return _store_status(conn, status)


def update_notification(status: dict[str, Any]) -> dict[str, Any] | None:
    if not status or not status.get("available"):
        return None
    current = str(status.get("current_version") or "当前版本")
    latest = str(status.get("latest_version") or status.get("latest_tag") or "新版本")
    tag = str(status.get("latest_tag") or latest)
    detail = f"当前 {current}，最新 {latest}。可以查看更新说明，或复制适合当前部署方式的更新命令。"
    update = {
        "current_version": current,
        "latest_version": latest,
        "latest_tag": tag,
        "release_name": str(status.get("release_name") or tag),
        "release_notes": str(status.get("release_notes") or ""),
        "release_url": str(status.get("release_url") or ""),
        "published_at": str(status.get("published_at") or ""),
        "checked_at": str(status.get("checked_at") or ""),
        "repository": str(status.get("repository") or _repository()),
        "source": str(status.get("source") or ""),
    }
    return {
        "id": f"app-update-{tag or latest}",
        "type": UPDATE_NOTIFICATION_TYPE,
        "severity": "warn",
        "title": "有新版本可用",
        "detail": detail,
        "created_at": update["checked_at"] or update["published_at"],
        "source": {"update": update},
        "channels": ["list", "toast"],
        "requires_action": True,
    }
