from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


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
    value = os.environ.get(name, default)
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


@dataclass(frozen=True)
class Settings:
    db_path: Path
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
    vector_index_backend: str
    llm_providers: list[LLMProvider]
    llm_chat_provider_id: str
    llm_chat_model: str
    llm_embedding_provider_id: str
    llm_embedding_model: str
    embedding_concurrency: int = 2
    paper_reader_default_prompt: str = ""
    paper_report_provider_id: str = ""
    paper_report_model: str = ""
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
    raw = os.environ.get("LLM_PROVIDERS_JSON", "").strip()
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
        providers.append(
            LLMProvider(
                id=provider_id,
                name=str(item.get("name") or provider_id),
                base_url=normalize_provider_base_url(str(item.get("base_url", ""))),
                api_key=str(item.get("api_key", "")),
                chat_models=[str(model) for model in item.get("chat_models", []) if str(model).strip()],
                embedding_models=[
                    str(model) for model in item.get("embedding_models", []) if str(model).strip()
                ],
            )
        )
    return providers


def normalize_provider_base_url(value: str) -> str:
    base_url = value.strip().rstrip("/")
    for suffix in ("/chat/completions", "/embeddings"):
        if base_url.endswith(suffix):
            base_url = base_url[: -len(suffix)]
    return base_url.rstrip("/")


def _bool(name: str, default: str = "false") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def load_settings() -> Settings:
    _load_dotenv()
    vault = os.environ.get("OBSIDIAN_VAULT_PATH", "").strip()
    providers = _providers_from_env()
    return Settings(
        db_path=Path(os.environ.get("APP_DB_PATH", "./data/research_intelligence.sqlite")),
        obsidian_vault_path=Path(vault).expanduser() if vault else None,
        obsidian_include_dirs=_csv("OBSIDIAN_INCLUDE_DIRS", "Research,Papers"),
        obsidian_include_tags=_tags("OBSIDIAN_INCLUDE_TAGS", "research,paper,direction"),
        obsidian_project_center_tags=_tags("OBSIDIAN_PROJECT_CENTER_TAGS", ""),
        obsidian_cli_command=os.environ.get("OBSIDIAN_CLI_COMMAND", "obsidian").strip() or "obsidian",
        obsidian_paper_repository_dir=os.environ.get(
            "OBSIDIAN_PAPER_REPOSITORY_DIR",
            "人工智能/论文仓库",
        ).strip().replace("\\", "/").strip("/"),
        obsidian_paper_attachment_dir=os.environ.get(
            "OBSIDIAN_PAPER_ATTACHMENT_DIR",
            "人工智能/论文仓库/附件",
        ).strip().replace("\\", "/").strip("/"),
        obsidian_project_paper_list_name=os.environ.get(
            "OBSIDIAN_PROJECT_PAPER_LIST_NAME",
            "论文列表.md",
        ).strip() or "论文列表.md",
        arxiv_categories=_csv("ARXIV_CATEGORIES", "cs.AI,cs.CL,cs.IR"),
        arxiv_daily_lookback_days=int(os.environ.get("ARXIV_DAILY_LOOKBACK_DAYS", "1")),
        arxiv_max_results=int(os.environ.get("ARXIV_MAX_RESULTS", "50")),
        arxiv_request_interval_seconds=float(os.environ.get("ARXIV_REQUEST_INTERVAL_SECONDS", "3")),
        arxiv_cache_full_text=_bool("ARXIV_CACHE_FULL_TEXT", "true"),
        arxiv_pdf_dir=Path(os.environ.get("ARXIV_PDF_DIR", "./data/arxiv_pdfs")),
        arxiv_text_dir=Path(os.environ.get("ARXIV_TEXT_DIR", "./data/arxiv_text")),
        retry_daily_max_results=int(os.environ.get("RETRY_DAILY_MAX_RESULTS", "100")),
        rag_score_threshold=float(os.environ.get("RAG_SCORE_THRESHOLD", "0.35")),
        rag_top_k=int(os.environ.get("RAG_TOP_K", "6")),
        rag_searchers=_csv(
            "RAG_SEARCHERS",
            "embedding_search,keyword_search,front_page_search",
        ),
        rag_prefilter_enabled=_bool("RAG_PREFILTER_ENABLED", "true"),
        rag_prefilter_threshold=float(os.environ.get("RAG_PREFILTER_THRESHOLD", "0.18")),
        rag_prefilter_top_k=int(os.environ.get("RAG_PREFILTER_TOP_K", "20")),
        rag_prefilter_min_keep=int(os.environ.get("RAG_PREFILTER_MIN_KEEP", "30")),
        rag_prefilter_max_keep=int(os.environ.get("RAG_PREFILTER_MAX_KEEP", "50")),
        vector_index_backend=os.environ.get("VECTOR_INDEX_BACKEND", "sqlite"),
        llm_providers=providers,
        llm_chat_provider_id=os.environ.get("LLM_CHAT_PROVIDER_ID", ""),
        llm_chat_model=os.environ.get("LLM_CHAT_MODEL", ""),
        llm_embedding_provider_id=os.environ.get("LLM_EMBEDDING_PROVIDER_ID", ""),
        llm_embedding_model=os.environ.get("LLM_EMBEDDING_MODEL", ""),
        embedding_concurrency=max(1, min(8, int(os.environ.get("EMBEDDING_CONCURRENCY", "2") or 2))),
        paper_reader_default_prompt=os.environ.get("PAPER_READER_DEFAULT_PROMPT", ""),
        paper_report_provider_id=os.environ.get("PAPER_REPORT_PROVIDER_ID", ""),
        paper_report_model=os.environ.get("PAPER_REPORT_MODEL", ""),
        reader_chat_provider_id=os.environ.get("READER_CHAT_PROVIDER_ID", ""),
        reader_chat_model=os.environ.get("READER_CHAT_MODEL", ""),
        reader_smart_save_provider_id=os.environ.get("READER_SMART_SAVE_PROVIDER_ID", ""),
        reader_smart_save_model=os.environ.get("READER_SMART_SAVE_MODEL", ""),
        reader_question_provider_id=os.environ.get("READER_QUESTION_PROVIDER_ID", ""),
        reader_question_model=os.environ.get("READER_QUESTION_MODEL", ""),
    )
