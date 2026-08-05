from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


_INVENTORY_PATH = Path(__file__).resolve().parent.parent / "config" / "worker-job-inventory.json"


@lru_cache(maxsize=1)
def worker_job_inventory() -> tuple[dict[str, Any], ...]:
    document = json.loads(_INVENTORY_PATH.read_text(encoding="utf-8"))
    entries = tuple(dict(entry) for entry in document.get("jobs", []))
    job_types = [str(entry.get("type") or "") for entry in entries]
    if not all(job_types) or len(job_types) != len(set(job_types)):
        raise RuntimeError("config/worker-job-inventory.json contains an empty or duplicate job type")
    return entries


@lru_cache(maxsize=1)
def _inventory_by_type() -> dict[str, dict[str, Any]]:
    return {str(entry["type"]): entry for entry in worker_job_inventory()}


def worker_job_definition(job_type: str) -> dict[str, Any] | None:
    return _inventory_by_type().get(str(job_type or ""))


def worker_job_concurrency_group(job_type: str) -> str:
    return str((worker_job_definition(job_type) or {}).get("concurrency_group") or "unclassified")


def worker_job_title(job_type: str) -> str:
    return str((worker_job_definition(job_type) or {}).get("label") or job_type or "任务")
