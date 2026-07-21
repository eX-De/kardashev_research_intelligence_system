from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

from .db import clean_unicode


WEB_EXTRACTOR_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "extract-web-content.mjs"


def _web_import_timeout_seconds() -> int:
    raw = clean_unicode(os.environ.get("READER_WEB_IMPORT_TIMEOUT_SECONDS", "600")).strip()
    try:
        return max(30, min(1800, int(raw)))
    except ValueError:
        return 600


def extract_web_documents(urls: list[str]) -> dict[str, object]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("网页正文导入需要 Node.js 运行时")
    if not WEB_EXTRACTOR_SCRIPT.is_file():
        raise RuntimeError(f"网页正文提取脚本不存在：{WEB_EXTRACTOR_SCRIPT}")

    payload = json.dumps({"urls": urls}, ensure_ascii=False)
    try:
        completed = subprocess.run(
            [node, str(WEB_EXTRACTOR_SCRIPT)],
            input=payload,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            timeout=_web_import_timeout_seconds(),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("网页正文提取超时") from exc

    stdout = clean_unicode(completed.stdout).strip()
    try:
        result = json.loads(stdout) if stdout else {}
    except json.JSONDecodeError as exc:
        stderr = clean_unicode(completed.stderr).strip()
        detail = stderr[-1000:] if stderr else stdout[-1000:]
        raise RuntimeError(f"网页正文提取器返回了无效结果：{detail}") from exc
    if not isinstance(result, dict):
        raise RuntimeError("网页正文提取器返回格式无效")
    if completed.returncode != 0 and not result.get("results"):
        message = clean_unicode(str(result.get("error") or completed.stderr or "网页正文提取失败")).strip()
        raise RuntimeError(message[:1000])
    if not result.get("results") and result.get("error"):
        raise RuntimeError(clean_unicode(str(result["error"])).strip()[:1000])
    return result
