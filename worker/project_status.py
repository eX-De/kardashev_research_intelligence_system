from __future__ import annotations

RUN_DAILY_EXCLUDED_PROJECT_STATUSES = ("paused", "archived")


def run_daily_project_status_sql(alias: str) -> str:
    return f"{alias}.status NOT IN ('paused', 'archived')"
