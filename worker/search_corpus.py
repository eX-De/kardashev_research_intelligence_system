from __future__ import annotations


EXPERIMENT_REPORT_ARTIFACT_TYPE = "experiment_report"
PAPER_REPORT_ARTIFACT_TYPE = "paper_report"
PROJECT_CHAT_PROFILE_ARTIFACT_TYPE = "project_chat_profile"


def artifact_is_searchable(artifact_type: object, status: object) -> bool:
    normalized_type = str(artifact_type or "").strip()
    normalized_status = str(status or "").strip()
    if normalized_type == PAPER_REPORT_ARTIFACT_TYPE:
        return normalized_status == "done"
    return normalized_status == "ready"


def artifact_uses_generic_embedding_index(artifact_type: object) -> bool:
    return str(artifact_type or "").strip() != EXPERIMENT_REPORT_ARTIFACT_TYPE


def artifact_searchable_sql(alias: str = "a") -> str:
    return (
        f"(({alias}.artifact_type = '{PAPER_REPORT_ARTIFACT_TYPE}' AND {alias}.status = 'done') OR "
        f"({alias}.artifact_type <> '{PAPER_REPORT_ARTIFACT_TYPE}' AND {alias}.status = 'ready'))"
    )


def searchable_library_paper_sql(alias: str = "p") -> str:
    return f"{alias}.library_status NOT IN ('archived', 'discarded')"
