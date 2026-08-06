from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from .env import env_bool, env_value


def _load_dotenv() -> None:
    path = Path(".env")
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        os.environ.setdefault(key, value)


def _csv(name: str, default: str = "") -> list[str]:
    value = env_value(name, default)
    return [part.strip() for part in value.split(",") if part.strip()]


def _tags(name: str, default: str = "") -> list[str]:
    return [part.lstrip("#").lower() for part in _csv(name, default)]


@dataclass(frozen=True)
class LLMProvider:
    id: str
    name: str
    base_url: str
    api_key: str
    chat_models: list[str]
    embedding_models: list[str]
    provider_type: str = "openai_compatible"
    openrouter_model_policies: dict[str, dict[str, object]] = field(default_factory=dict)


@dataclass(frozen=True)
class Settings:
    obsidian_vault_path: Path | None
    obsidian_include_dirs: list[str]
    obsidian_include_tags: list[str]
    obsidian_project_center_tags: list[str]
    obsidian_cli_command: str
    obsidian_paper_repository_dir: str
    obsidian_paper_attachment_dir: str
    obsidian_project_paper_list_name: str
    arxiv_categories: list[str]
    arxiv_daily_lookback_days: int
    arxiv_max_results: int
    arxiv_request_interval_seconds: float
    arxiv_cache_full_text: bool
    arxiv_pdf_dir: Path
    arxiv_text_dir: Path
    retry_daily_max_results: int
    rag_score_threshold: float
    rag_top_k: int
    rag_searchers: list[str]
    rag_prefilter_enabled: bool
    rag_prefilter_threshold: float
    rag_prefilter_top_k: int
    rag_prefilter_min_keep: int
    rag_prefilter_max_keep: int
    llm_providers: list[LLMProvider]
    llm_chat_provider_id: str
    llm_chat_model: str
    llm_embedding_provider_id: str
    llm_embedding_model: str
    obsidian_storage_backend: str = "local"
    obsidian_remote_endpoint_url: str = ""
    obsidian_remote_region: str = ""
    obsidian_remote_bucket: str = ""
    obsidian_remote_prefix: str = ""
    obsidian_remote_access_key_id: str = ""
    obsidian_remote_secret_access_key: str = ""
    obsidian_remote_mirror_dir: Path = Path("./data/obsidian_remote_vault")
    obsidian_remote_output_prefix: str = "Research Intelligence"
    obsidian_remote_append_only: bool = True
    embedding_concurrency: int = 2
    global_llm_request_concurrency: int = 4
    global_embedding_request_concurrency: int = 4
    paper_reader_prompt_mode: str = "default"
    paper_reader_prompt_locale: str = "zh-CN"
    paper_reader_default_prompt: str = ""
    paper_report_provider_id: str = ""
    paper_report_model: str = ""
    project_chat_profile_provider_id: str = ""
    project_chat_profile_model: str = ""
    project_chat_profile_concurrency: int = 2
    project_judgment_concurrency: int = 3
    project_judgment_prompt_mode: str = "default"
    project_judgment_prompt_locale: str = "zh-CN"
    project_judgment_custom_prompt: str = ""
    reader_chat_provider_id: str = ""
    reader_chat_model: str = ""
    reader_smart_save_provider_id: str = ""
    reader_smart_save_model: str = ""
    reader_question_provider_id: str = ""
    reader_question_model: str = ""

    def provider(self, provider_id: str) -> LLMProvider | None:
        return next((provider for provider in self.llm_providers if provider.id == provider_id), None)

    def chat_provider(self) -> LLMProvider | None:
        return self.provider(self.llm_chat_provider_id)

    def embedding_provider(self) -> LLMProvider | None:
        return self.provider(self.llm_embedding_provider_id)


def _providers_from_env() -> list[LLMProvider]:
    raw = env_value("LLM_PROVIDERS_JSON", "").strip()
    if not raw:
        return []
    try:
        values = json.loads(raw)
    except json.JSONDecodeError:
        return []
    providers = []
    for item in (values if isinstance(values, list) else []):
        if not isinstance(item, dict):
            continue
        provider_id = str(item.get("id", "")).strip()
        if not provider_id:
            continue
        provider_type = normalize_provider_type(
            str(item.get("provider_type", "")),
            str(item.get("base_url", "")),
        )
        if provider_type == "openrouter" and any(provider.provider_type == "openrouter" for provider in providers):
            raise RuntimeError("only one OpenRouter provider can be configured")
        chat_models = [str(model) for model in item.get("chat_models", []) if str(model).strip()]
        providers.append(
            LLMProvider(
                id=provider_id,
                name=str(item.get("name") or provider_id),
                base_url=OPENROUTER_BASE_URL if provider_type == "openrouter" else normalize_provider_base_url(str(item.get("base_url", ""))),
                api_key=str(item.get("api_key", "")),
                chat_models=chat_models,
                embedding_models=[
                    str(model) for model in item.get("embedding_models", []) if str(model).strip()
                ],
                provider_type=provider_type,
                openrouter_model_policies=(
                    normalize_openrouter_model_policies(item.get("openrouter_model_policies"), chat_models, item)
                    if provider_type == "openrouter"
                    else {}
                ),
            )
        )
    return providers


def normalize_provider_base_url(value: str) -> str:
    base_url = value.strip().rstrip("/")
    for suffix in ("/chat/completions", "/embeddings"):
        if base_url.endswith(suffix):
            base_url = base_url[: -len(suffix)]
    return base_url.rstrip("/")


PROVIDER_TYPES = {"openai_compatible", "openrouter"}
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
REASONING_EFFORTS = {"", "none", "minimal", "low", "medium", "high", "xhigh", "max"}
OPENROUTER_PROVIDER_SORTS = {"", "price", "throughput", "latency"}


def normalize_provider_type(value: object, base_url: object = "") -> str:
    provider_type = str(value or "").strip().lower()
    if provider_type in PROVIDER_TYPES:
        return provider_type
    if "openrouter.ai" in str(base_url or "").strip().lower():
        return "openrouter"
    return "openai_compatible"


def normalize_reasoning_effort(value: object) -> str:
    effort = str(value or "").strip().lower()
    return effort if effort in REASONING_EFFORTS else ""


def normalize_openrouter_provider_sort(value: object) -> str:
    provider_sort = str(value or "").strip().lower()
    return provider_sort if provider_sort in OPENROUTER_PROVIDER_SORTS else ""


def normalize_openrouter_model_policies(
    value: object,
    chat_models: list[str],
    legacy: dict[str, object] | None = None,
) -> dict[str, dict[str, object]]:
    source = value if isinstance(value, dict) else {}
    legacy = legacy or {}
    legacy_policy = None
    if len(chat_models) == 1 and not source:
        legacy_policy = {
            "reasoning_effort": legacy.get("reasoning_effort", ""),
            "provider_only": legacy.get("openrouter_provider_only", []),
            "provider_sort": legacy.get("openrouter_provider_sort", ""),
        }
    policies: dict[str, dict[str, object]] = {}
    for model in chat_models:
        policy = source.get(model) or legacy_policy
        if not isinstance(policy, dict):
            continue
        raw_provider_only = policy.get("provider_only", [])
        provider_only = raw_provider_only if isinstance(raw_provider_only, list) else str(raw_provider_only or "").split(",")
        policies[model] = {
            "reasoning_effort": normalize_reasoning_effort(policy.get("reasoning_effort", "")),
            "provider_only": [str(provider).strip().lower() for provider in provider_only if str(provider).strip()],
            "provider_sort": normalize_openrouter_provider_sort(policy.get("provider_sort", "")),
        }
    return policies


def _bool(name: str, default: str = "false") -> bool:
    return env_bool(name, default)


def _positive_int(name: str, default: int, *, maximum: int | None = None) -> int:
    raw_value = env_value(name, str(default))
    value = int(raw_value or default)
    if value < 1:
        raise RuntimeError(f"{name} must be at least 1")
    if maximum is not None and value > maximum:
        raise RuntimeError(f"{name} must be at most {maximum}")
    return value


def load_settings() -> Settings:
    _load_dotenv()
    vault = env_value("OBSIDIAN_VAULT_PATH", "").strip()
    providers = _providers_from_env()
    paper_reader_custom_prompt = env_value("PAPER_READER_DEFAULT_PROMPT", "")
    paper_reader_prompt_mode = env_value("PAPER_READER_PROMPT_MODE", "").strip().lower()
    if paper_reader_prompt_mode not in {"default", "custom"}:
        paper_reader_prompt_mode = "custom" if paper_reader_custom_prompt.strip() else "default"
    project_judgment_custom_prompt = env_value("PROJECT_JUDGMENT_CUSTOM_PROMPT", "")
    project_judgment_prompt_mode = env_value("PROJECT_JUDGMENT_PROMPT_MODE", "").strip().lower()
    if project_judgment_prompt_mode not in {"default", "custom"}:
        project_judgment_prompt_mode = "custom" if project_judgment_custom_prompt.strip() else "default"
    return Settings(
        obsidian_vault_path=Path(vault).expanduser() if vault else None,
        obsidian_include_dirs=_csv("OBSIDIAN_INCLUDE_DIRS", "Research,Papers"),
        obsidian_include_tags=_tags("OBSIDIAN_INCLUDE_TAGS", "research,paper,direction"),
        obsidian_project_center_tags=_tags("OBSIDIAN_PROJECT_CENTER_TAGS", ""),
        obsidian_cli_command=env_value("OBSIDIAN_CLI_COMMAND", "obsidian").strip() or "obsidian",
        obsidian_paper_repository_dir=env_value(
            "OBSIDIAN_PAPER_REPOSITORY_DIR",
            "人工智能/论文仓库",
        ).strip().replace("\\", "/").strip("/"),
        obsidian_paper_attachment_dir=env_value(
            "OBSIDIAN_PAPER_ATTACHMENT_DIR",
            "人工智能/论文仓库/附件",
        ).strip().replace("\\", "/").strip("/"),
        obsidian_project_paper_list_name=env_value(
            "OBSIDIAN_PROJECT_PAPER_LIST_NAME",
            "论文列表.md",
        ).strip() or "论文列表.md",
        arxiv_categories=_csv("ARXIV_CATEGORIES", "cs.AI,cs.CL,cs.IR"),
        arxiv_daily_lookback_days=int(env_value("ARXIV_DAILY_LOOKBACK_DAYS", "1")),
        arxiv_max_results=int(env_value("ARXIV_MAX_RESULTS", "50")),
        arxiv_request_interval_seconds=float(env_value("ARXIV_REQUEST_INTERVAL_SECONDS", "3")),
        arxiv_cache_full_text=_bool("ARXIV_CACHE_FULL_TEXT", "true"),
        arxiv_pdf_dir=Path(env_value("ARXIV_PDF_DIR", "./data/arxiv_pdfs")),
        arxiv_text_dir=Path(env_value("ARXIV_TEXT_DIR", "./data/arxiv_text")),
        retry_daily_max_results=int(env_value("RETRY_DAILY_MAX_RESULTS", "100")),
        rag_score_threshold=float(env_value("RAG_SCORE_THRESHOLD", "0.35")),
        rag_top_k=int(env_value("RAG_TOP_K", "6")),
        rag_searchers=_csv(
            "RAG_SEARCHERS",
            "embedding_search,keyword_search,front_page_search",
        ),
        rag_prefilter_enabled=_bool("RAG_PREFILTER_ENABLED", "true"),
        rag_prefilter_threshold=float(env_value("RAG_PREFILTER_THRESHOLD", "0.18")),
        rag_prefilter_top_k=int(env_value("RAG_PREFILTER_TOP_K", "20")),
        rag_prefilter_min_keep=int(env_value("RAG_PREFILTER_MIN_KEEP", "30")),
        rag_prefilter_max_keep=int(env_value("RAG_PREFILTER_MAX_KEEP", "50")),
        llm_providers=providers,
        llm_chat_provider_id=env_value("LLM_CHAT_PROVIDER_ID", ""),
        llm_chat_model=env_value("LLM_CHAT_MODEL", ""),
        llm_embedding_provider_id=env_value("LLM_EMBEDDING_PROVIDER_ID", ""),
        llm_embedding_model=env_value("LLM_EMBEDDING_MODEL", ""),
        obsidian_storage_backend=env_value("OBSIDIAN_STORAGE_BACKEND", "local").strip().lower() or "local",
        obsidian_remote_endpoint_url=env_value("OBSIDIAN_REMOTE_ENDPOINT_URL", "").strip(),
        obsidian_remote_region=env_value("OBSIDIAN_REMOTE_REGION", "").strip(),
        obsidian_remote_bucket=env_value("OBSIDIAN_REMOTE_BUCKET", "").strip(),
        obsidian_remote_prefix=env_value("OBSIDIAN_REMOTE_PREFIX", "").strip().replace("\\", "/").strip("/"),
        obsidian_remote_access_key_id=env_value("OBSIDIAN_REMOTE_ACCESS_KEY_ID", "").strip(),
        obsidian_remote_secret_access_key=env_value("OBSIDIAN_REMOTE_SECRET_ACCESS_KEY", "").strip(),
        obsidian_remote_mirror_dir=Path(env_value("OBSIDIAN_REMOTE_MIRROR_DIR", "./data/obsidian_remote_vault")).expanduser(),
        obsidian_remote_output_prefix=env_value(
            "OBSIDIAN_REMOTE_OUTPUT_PREFIX",
            "Research Intelligence",
        ).strip().replace("\\", "/").strip("/") or "Research Intelligence",
        obsidian_remote_append_only=_bool("OBSIDIAN_REMOTE_APPEND_ONLY", "true"),
        embedding_concurrency=min(
            _positive_int("EMBEDDING_CONCURRENCY", 2),
            _positive_int("GLOBAL_EMBEDDING_REQUEST_CONCURRENCY", 4),
        ),
        global_llm_request_concurrency=_positive_int("GLOBAL_LLM_REQUEST_CONCURRENCY", 4),
        global_embedding_request_concurrency=_positive_int("GLOBAL_EMBEDDING_REQUEST_CONCURRENCY", 4),
        paper_reader_prompt_mode=paper_reader_prompt_mode,
        paper_reader_prompt_locale=env_value("PAPER_READER_PROMPT_LOCALE", "zh-CN").strip() or "zh-CN",
        paper_reader_default_prompt=paper_reader_custom_prompt,
        paper_report_provider_id=env_value("PAPER_REPORT_PROVIDER_ID", ""),
        paper_report_model=env_value("PAPER_REPORT_MODEL", ""),
        project_chat_profile_provider_id=env_value("PROJECT_CHAT_PROFILE_PROVIDER_ID", ""),
        project_chat_profile_model=env_value("PROJECT_CHAT_PROFILE_MODEL", ""),
        project_chat_profile_concurrency=min(
            _positive_int("PROJECT_CHAT_PROFILE_CONCURRENCY", 2, maximum=8),
            _positive_int("GLOBAL_LLM_REQUEST_CONCURRENCY", 4),
        ),
        project_judgment_concurrency=min(
            _positive_int("PROJECT_JUDGMENT_CONCURRENCY", 3, maximum=8),
            _positive_int("GLOBAL_LLM_REQUEST_CONCURRENCY", 4),
        ),
        project_judgment_prompt_mode=project_judgment_prompt_mode,
        project_judgment_prompt_locale=env_value("PROJECT_JUDGMENT_PROMPT_LOCALE", "zh-CN").strip() or "zh-CN",
        project_judgment_custom_prompt=project_judgment_custom_prompt,
        reader_chat_provider_id=env_value("READER_CHAT_PROVIDER_ID", ""),
        reader_chat_model=env_value("READER_CHAT_MODEL", ""),
        reader_smart_save_provider_id=env_value("READER_SMART_SAVE_PROVIDER_ID", ""),
        reader_smart_save_model=env_value("READER_SMART_SAVE_MODEL", ""),
        reader_question_provider_id=env_value("READER_QUESTION_PROVIDER_ID", ""),
        reader_question_model=env_value("READER_QUESTION_MODEL", ""),
    )
