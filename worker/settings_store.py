from __future__ import annotations

import re
import os
import sqlite3
from dataclasses import replace
from pathlib import Path
from typing import Any

from .config import LLMProvider, Settings, normalize_provider_base_url
from .db import from_json, to_json, utc_now

CSV_FIELDS = {
    "obsidian_include_dirs",
    "obsidian_include_tags",
    "obsidian_project_center_tags",
    "arxiv_categories",
    "rag_searchers",
}

PATH_FIELDS = {"obsidian_vault_path", "arxiv_pdf_dir", "arxiv_text_dir"}

INT_FIELDS = {
    "arxiv_daily_lookback_days",
    "arxiv_max_results",
    "rag_top_k",
    "rag_prefilter_top_k",
    "rag_prefilter_min_keep",
    "rag_prefilter_max_keep",
    "scheduler_interval_hours",
}

FLOAT_FIELDS = {
    "arxiv_request_interval_seconds",
    "rag_score_threshold",
    "rag_prefilter_threshold",
}

STRING_FIELDS = {
    "obsidian_vault_path",
    "arxiv_pdf_dir",
    "arxiv_text_dir",
    "vector_index_backend",
    "llm_chat_provider_id",
    "llm_chat_model",
    "llm_embedding_provider_id",
    "llm_embedding_model",
    "scheduler_run_time",
}

BOOL_FIELDS = {
    "scheduler_enabled",
    "run_daily_on_startup_enabled",
    "arxiv_cache_full_text",
    "rag_prefilter_enabled",
}
JSON_FIELDS = {"llm_providers"}

ALLOWED_FIELDS = CSV_FIELDS | INT_FIELDS | FLOAT_FIELDS | STRING_FIELDS | BOOL_FIELDS | JSON_FIELDS


def _csv(value: Any, tags: bool = False) -> list[str]:
    if isinstance(value, list):
        raw = [str(item) for item in value]
    else:
        raw = str(value or "").split(",")
    items = [item.strip() for item in raw if item.strip()]
    if tags:
        return [item.lstrip("#").lower() for item in items]
    return items


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _stored(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute("SELECT key, value_json FROM app_settings").fetchall()
    return {row["key"]: from_json(row["value_json"], None) for row in rows}


def _provider_to_payload(provider: LLMProvider) -> dict[str, Any]:
    return {
        "id": provider.id,
        "name": provider.name,
        "base_url": provider.base_url,
        "api_key_configured": bool(provider.api_key),
        "chat_models": provider.chat_models,
        "embedding_models": provider.embedding_models,
    }


def _provider_to_store(provider: LLMProvider) -> dict[str, Any]:
    return {
        "id": provider.id,
        "name": provider.name,
        "base_url": provider.base_url,
        "api_key": provider.api_key,
        "chat_models": provider.chat_models,
        "embedding_models": provider.embedding_models,
    }


def _providers_from_value(value: Any, existing: dict[str, LLMProvider] | None = None) -> list[LLMProvider]:
    providers = []
    existing = existing or {}
    for item in (value if isinstance(value, list) else []):
        if not isinstance(item, dict):
            continue
        provider_id = str(item.get("id", "")).strip()
        if not provider_id:
            continue
        previous = existing.get(provider_id)
        api_key = str(item.get("api_key", "") or "")
        if item.get("clear_api_key"):
            api_key = ""
        elif not api_key and previous:
            api_key = previous.api_key
        providers.append(
            LLMProvider(
                id=provider_id,
                name=str(item.get("name") or provider_id).strip(),
                base_url=normalize_provider_base_url(str(item.get("base_url", ""))),
                api_key=api_key,
                chat_models=_csv(item.get("chat_models", [])),
                embedding_models=_csv(item.get("embedding_models", [])),
            )
        )
    return providers


def _setting_payload(settings: Settings, stored: dict[str, Any]) -> dict[str, Any]:
    return {
        "obsidian_vault_path": str(settings.obsidian_vault_path or ""),
        "obsidian_include_dirs": settings.obsidian_include_dirs,
        "obsidian_include_tags": settings.obsidian_include_tags,
        "obsidian_project_center_tags": settings.obsidian_project_center_tags,
        "arxiv_categories": settings.arxiv_categories,
        "arxiv_daily_lookback_days": settings.arxiv_daily_lookback_days,
        "arxiv_max_results": settings.arxiv_max_results,
        "arxiv_request_interval_seconds": settings.arxiv_request_interval_seconds,
        "arxiv_cache_full_text": settings.arxiv_cache_full_text,
        "arxiv_pdf_dir": str(settings.arxiv_pdf_dir),
        "arxiv_text_dir": str(settings.arxiv_text_dir),
        "rag_score_threshold": settings.rag_score_threshold,
        "rag_top_k": settings.rag_top_k,
        "rag_searchers": settings.rag_searchers,
        "rag_prefilter_enabled": settings.rag_prefilter_enabled,
        "rag_prefilter_threshold": settings.rag_prefilter_threshold,
        "rag_prefilter_top_k": settings.rag_prefilter_top_k,
        "rag_prefilter_min_keep": settings.rag_prefilter_min_keep,
        "rag_prefilter_max_keep": settings.rag_prefilter_max_keep,
        "vector_index_backend": settings.vector_index_backend,
        "llm_providers": [_provider_to_payload(provider) for provider in settings.llm_providers],
        "llm_chat_provider_id": settings.llm_chat_provider_id,
        "llm_chat_model": settings.llm_chat_model,
        "llm_embedding_provider_id": settings.llm_embedding_provider_id,
        "llm_embedding_model": settings.llm_embedding_model,
        "scheduler_enabled": _bool(stored.get("scheduler_enabled", os.environ.get("SCHEDULER_ENABLED", False))),
        "run_daily_on_startup_enabled": _bool(
            stored.get(
                "run_daily_on_startup_enabled",
                os.environ.get("RUN_DAILY_ON_STARTUP_ENABLED", False),
            )
        ),
        "scheduler_run_time": str(stored.get("scheduler_run_time", os.environ.get("SCHEDULER_RUN_TIME", "09:00"))),
        "scheduler_interval_hours": int(
            stored.get("scheduler_interval_hours", os.environ.get("SCHEDULER_INTERVAL_HOURS", 24)) or 24
        ),
    }


def apply_stored_settings(conn: sqlite3.Connection, settings: Settings) -> Settings:
    stored = _stored(conn)
    updates: dict[str, Any] = {}

    if "obsidian_vault_path" in stored:
        vault = str(stored.get("obsidian_vault_path") or "").strip()
        updates["obsidian_vault_path"] = Path(vault).expanduser() if vault else None
    if "arxiv_pdf_dir" in stored:
        updates["arxiv_pdf_dir"] = Path(str(stored.get("arxiv_pdf_dir") or "./data/arxiv_pdfs")).expanduser()
    if "arxiv_text_dir" in stored:
        updates["arxiv_text_dir"] = Path(str(stored.get("arxiv_text_dir") or "./data/arxiv_text")).expanduser()
    for field in CSV_FIELDS:
        if field in stored and field != "obsidian_include_tags":
            updates[field] = _csv(stored[field])
    if "obsidian_include_tags" in stored:
        updates["obsidian_include_tags"] = _csv(stored["obsidian_include_tags"], tags=True)
    if "obsidian_project_center_tags" in stored:
        updates["obsidian_project_center_tags"] = _csv(stored["obsidian_project_center_tags"], tags=True)
    if "llm_providers" in stored:
        updates["llm_providers"] = _providers_from_value(stored["llm_providers"])
    for field in INT_FIELDS:
        if field in stored and hasattr(settings, field):
            updates[field] = int(stored[field])
    for field in FLOAT_FIELDS:
        if field in stored:
            updates[field] = float(stored[field])
    for field in BOOL_FIELDS:
        if field in stored and hasattr(settings, field):
            updates[field] = _bool(stored[field])
    for field in STRING_FIELDS:
        if field in PATH_FIELDS:
            continue
        if field in stored and hasattr(settings, field):
            value = str(stored[field])
            updates[field] = value

    return replace(settings, **updates)


def get_app_settings(conn: sqlite3.Connection, settings: Settings) -> dict[str, Any]:
    return {"settings": _setting_payload(settings, _stored(conn))}


def save_app_settings(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    now = utc_now()
    current_settings = _stored(conn)
    existing_providers = {
        provider.id: provider for provider in _providers_from_value(current_settings.get("llm_providers", []))
    }
    normalized: dict[str, Any] = {}

    def store_setting(key: str, value: Any) -> None:
        conn.execute(
            """
            INSERT INTO app_settings(key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            """,
            (key, to_json(value), now),
        )

    for key, raw_value in payload.items():
        if key not in ALLOWED_FIELDS:
            continue
        value: Any = raw_value
        if key in CSV_FIELDS:
            value = _csv(raw_value, tags=key in {"obsidian_include_tags", "obsidian_project_center_tags"})
        elif key == "llm_providers":
            value = [_provider_to_store(provider) for provider in _providers_from_value(raw_value, existing_providers)]
        elif key in INT_FIELDS:
            value = int(raw_value or 0)
        elif key in FLOAT_FIELDS:
            value = float(raw_value or 0)
        elif key in BOOL_FIELDS:
            value = _bool(raw_value)
        elif key == "scheduler_run_time":
            value = str(raw_value or "09:00")
            if not re.match(r"^\d{2}:\d{2}$", value):
                raise RuntimeError("scheduler_run_time must use HH:MM")
        else:
            value = str(raw_value or "").strip()

        normalized[key] = value
        store_setting(key, value)

    if normalized.get("scheduler_enabled") and normalized.get("run_daily_on_startup_enabled"):
        raise RuntimeError("scheduler_enabled and run_daily_on_startup_enabled are mutually exclusive")
    if normalized.get("scheduler_enabled"):
        store_setting("run_daily_on_startup_enabled", False)
    if normalized.get("run_daily_on_startup_enabled"):
        store_setting("scheduler_enabled", False)

    conn.commit()
    return {"ok": True}


def scheduler_settings(conn: sqlite3.Connection, settings: Settings) -> dict[str, Any]:
    return get_app_settings(conn, settings)["settings"]
