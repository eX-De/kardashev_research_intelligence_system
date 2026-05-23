from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def env_value(name: str, default: Any = "") -> str:
    file_path = os.environ.get(f"{name}_FILE", "").strip()
    if file_path:
        try:
            return Path(file_path).read_text(encoding="utf-8").rstrip("\r\n")
        except OSError as exc:
            raise RuntimeError(f"Failed to read {name}_FILE ({file_path}): {exc}") from exc
    value = os.environ.get(name)
    return str(default) if value is None else str(value)


def env_bool(name: str, default: Any = "false") -> bool:
    return env_value(name, default).strip().lower() in {"1", "true", "yes", "on", "enabled"}
