from __future__ import annotations

from typing import Any


PAPER_READER_DEFAULT_PROMPTS = {
    "zh-CN": """请阅读这份研究文档，输出结构化解读：

1. 研究问题和背景
2. 方法和实验设计
3. 主要发现
4. 局限性
5. 对后续研究或应用的启发

请尽量使用中文，保留关键英文术语。""",
    "en": """Read this research document and provide a structured analysis:

1. Research question and background
2. Methods and experimental design
3. Main findings
4. Limitations
5. Implications for future research or applications

Please answer in English while preserving important terms in their original language.""",
}
PAPER_READER_DEFAULT_PROMPT_LOCALE = "zh-CN"
PAPER_READER_DEFAULT_PROMPT = PAPER_READER_DEFAULT_PROMPTS[PAPER_READER_DEFAULT_PROMPT_LOCALE]
PAPER_READER_LEGACY_DEFAULT_PROMPTS = {
    """请阅读这篇论文 PDF，输出结构化解读：

1. 研究问题和背景
2. 方法和实验设计
3. 主要发现
4. 局限性
5. 对后续研究或应用的启发

请尽量使用中文，保留关键英文术语。""",
}


def is_builtin_paper_reader_prompt(value: Any) -> bool:
    prompt = str(value or "").strip()
    return prompt in PAPER_READER_DEFAULT_PROMPTS.values() or prompt in PAPER_READER_LEGACY_DEFAULT_PROMPTS


def normalize_paper_reader_prompt_locale(value: Any) -> str:
    locale = str(value or "").strip()
    if locale == "en" or locale.lower().startswith("en-"):
        return "en"
    return PAPER_READER_DEFAULT_PROMPT_LOCALE


def default_paper_reader_prompt(locale: Any) -> str:
    return PAPER_READER_DEFAULT_PROMPTS[normalize_paper_reader_prompt_locale(locale)]


def infer_paper_reader_prompt_mode(value: Any, custom_prompt: Any = "") -> str:
    mode = str(value or "").strip().lower()
    if mode in {"default", "custom"}:
        return mode
    prompt = str(custom_prompt or "").strip()
    if not prompt or is_builtin_paper_reader_prompt(prompt):
        return "default"
    return "custom"


def resolve_paper_reader_prompt(
    settings: Any,
    *,
    locale: Any = "",
    prompt: Any = "",
) -> str:
    explicit_prompt = str(prompt or "").strip()
    if explicit_prompt:
        return explicit_prompt
    prompt_locale = normalize_paper_reader_prompt_locale(
        locale or getattr(settings, "paper_reader_prompt_locale", "")
    )
    custom_prompt = str(getattr(settings, "paper_reader_default_prompt", "") or "").strip()
    mode = infer_paper_reader_prompt_mode(
        getattr(settings, "paper_reader_prompt_mode", ""),
        custom_prompt,
    )
    if mode == "custom" and custom_prompt:
        return custom_prompt
    return default_paper_reader_prompt(prompt_locale)
