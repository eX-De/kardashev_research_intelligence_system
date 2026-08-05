from __future__ import annotations

import json
import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


_POLICY_PATH = Path(__file__).resolve().parent.parent / "config" / "worker-job-policy.json"


@lru_cache(maxsize=1)
def policy_document() -> dict[str, Any]:
    document = json.loads(_POLICY_PATH.read_text(encoding="utf-8-sig"))
    inventory = json.loads(_POLICY_PATH.with_name("worker-job-inventory.json").read_text(encoding="utf-8-sig"))
    inventory_types = {str(entry.get("type") or "") for entry in inventory.get("jobs", [])}
    jobs = document.get("jobs") or {}
    required = {"execution_mode", "concurrency_group", "max_running", "key_fields", "priority", "default_max_attempts", "user_visible"}
    valid = (
        int(document.get("version") or 0) >= 1
        and set(jobs) == inventory_types
        and all(
            required.issubset(policy)
            and policy.get("execution_mode") in {"background", "interactive", "node"}
            and str(policy.get("concurrency_group") or "").strip()
            and isinstance(policy.get("max_running"), int) and int(policy["max_running"]) >= 1
            and isinstance(policy.get("key_fields"), list)
            and isinstance(policy.get("priority"), int)
            and isinstance(policy.get("default_max_attempts"), int) and int(policy["default_max_attempts"]) >= 1
            and isinstance(policy.get("user_visible"), bool)
            for policy in jobs.values()
        )
    )
    group_limits: dict[str, int] = {}
    for policy in jobs.values():
        group = str(policy.get("concurrency_group") or "")
        limit = int(policy.get("max_running") or 0)
        if group in group_limits and group_limits[group] != limit:
            valid = False
        group_limits[group] = limit
    if not valid:
        raise RuntimeError("config/worker-job-policy.json is invalid")
    return document


def worker_job_policy(job_type: str) -> dict[str, Any]:
    normalized = str(job_type or "").strip()
    policy = (policy_document().get("jobs") or {}).get(normalized)
    if not isinstance(policy, dict):
        raise RuntimeError(f"No worker job policy is declared for {normalized or '<empty>'}")
    return {"type": normalized, **policy}


def _canonical_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
        if not parsed.scheme or not parsed.netloc:
            return raw.replace("\\", "/")
        host = (parsed.hostname or "").encode("idna").decode("ascii").lower()
        port = parsed.port
        if port and not ((parsed.scheme.lower() == "http" and port == 80) or (parsed.scheme.lower() == "https" and port == 443)):
            host = f"{host}:{port}"
        if parsed.username:
            auth = parsed.username + (f":{parsed.password}" if parsed.password else "") + "@"
            host = auth + host
        query = urlencode(sorted(parse_qsl(parsed.query, keep_blank_values=True)), doseq=True)
        path = quote(parsed.path or "/", safe="/:@-._~!$&'()*+,;=%")
        return urlunsplit((parsed.scheme.lower(), host, path, query, ""))
    except (TypeError, ValueError):
        return raw.replace("\\", "/")


def _transform_key_value(value: str, transform: str) -> str:
    if transform != "canonical_url_set_sha256":
        return value
    try:
        parsed: Any = json.loads(value)
    except (TypeError, ValueError):
        parsed = value
    candidates = parsed if isinstance(parsed, list) else [parsed]
    canonical = sorted({_canonical_url(item) for item in candidates if _canonical_url(item)})
    encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def resolve_worker_job_policy(job_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = worker_job_policy(job_type)
    values = payload if isinstance(payload, dict) else {}
    key = str(policy.get("fixed_key") or "").strip()
    if not key:
        for field in policy.get("key_fields") or []:
            value: Any = values
            for part in str(field).split("."):
                if isinstance(value, dict):
                    value = value.get(part)
                elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
                    value = value[int(part)]
                else:
                    value = None
                    break
            value = (
                json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
                if isinstance(value, (list, dict))
                else str(value or "")
            ).strip().replace("\\", "/")
            if value:
                value = _transform_key_value(value, str(policy.get("key_transform") or ""))
                key = str(policy.get("key_format") or f"{policy.get('key_prefix') or job_type}:{{value}}").replace("{value}", value)
                break
    return {
        **policy,
        "concurrency_key": key,
        "policy_version": int(policy_document()["version"]),
    }


def policy_aging_seconds() -> int:
    return max(1, int(policy_document().get("aging_seconds") or 60))
