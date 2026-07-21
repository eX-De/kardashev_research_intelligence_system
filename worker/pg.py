from __future__ import annotations

import re
from typing import Any, Iterable


IDENTITY_TABLES = {
    "obsidian_notes",
    "knowledge_documents",
    "research_chunks",
    "arxiv_papers",
    "arxiv_text_chunks",
    "papers",
    "paper_sources",
    "paper_assets",
    "paper_chunks",
    "paper_prefilter_runs",
    "matches",
    "user_feedback",
    "job_runs",
    "worker_jobs",
    "app_events",
    "research_projects",
    "paper_reader_messages",
    "artifacts",
    "artifact_chunks",
}

TABLE_ORDER = [
    "knowledge_documents",
    "obsidian_notes",
    "arxiv_papers",
    "arxiv_paper_tombstones",
    "papers",
    "paper_sources",
    "paper_assets",
    "research_projects",
    "project_context_documents",
    "research_chunks",
    "chunk_embeddings",
    "arxiv_text_chunks",
    "paper_chunks",
    "arxiv_chunk_embeddings",
    "arxiv_paper_embeddings",
    "paper_prefilter_runs",
    "matches",
    "user_feedback",
    "job_runs",
    "worker_jobs",
    "app_events",
    "daily_run_meta",
    "daily_run_steps",
    "daily_run_papers",
    "app_settings",
    "project_papers",
    "project_paper_matches",
    "project_paper_judgments",
    "project_paper_recommendations",
    "paper_reader_references",
    "paper_reader_messages",
    "project_notes",
    "artifact_chunk_embeddings",
    "artifact_chunks",
    "artifacts",
]


class PgRow:
    def __init__(self, columns: list[str], values: tuple[Any, ...]):
        self._columns = columns
        self._values = values
        self._by_name = {column: values[index] for index, column in enumerate(columns)}

    def __getitem__(self, key: str | int) -> Any:
        if isinstance(key, int):
            return self._values[key]
        return self._by_name[key]

    def __iter__(self):
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def keys(self) -> list[str]:
        return list(self._columns)


class PgCursor:
    def __init__(self, cursor: Any, lastrowid: int | None = None):
        self._cursor = cursor
        self.lastrowid = lastrowid
        self.rowcount = int(cursor.rowcount or 0)

    def _columns(self) -> list[str]:
        return [column.name for column in (self._cursor.description or [])]

    def _wrap(self, row: tuple[Any, ...] | None) -> PgRow | None:
        if row is None:
            return None
        return PgRow(self._columns(), row)

    def fetchone(self) -> PgRow | None:
        if not self._cursor.description:
            return None
        return self._wrap(self._cursor.fetchone())

    def fetchall(self) -> list[PgRow]:
        if not self._cursor.description:
            return []
        columns = self._columns()
        return [PgRow(columns, row) for row in self._cursor.fetchall()]


class PgConnection:
    dialect = "postgres"

    def __init__(self, conn: Any):
        self._conn = conn

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            self.commit()
        else:
            self.rollback()
        return False

    def execute(self, sql: str, params: Iterable[Any] | None = None) -> PgCursor:
        translated = translate_sql(sql)
        before_auto_returning = translated
        translated = _append_returning_id(translated)
        auto_returning_id = translated != before_auto_returning and _returns_generated_id(translated)
        cursor = self._conn.cursor()
        cursor.execute(translated, tuple(params or ()))
        lastrowid = None
        if auto_returning_id and cursor.description:
            row = cursor.fetchone()
            if row is not None:
                lastrowid = int(row[0])
        return PgCursor(cursor, lastrowid=lastrowid)

    def executescript(self, script: str) -> None:
        for statement in _split_sql_script(script):
            if statement.strip():
                self.execute(statement)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()


def connect_postgres(database_url: str) -> PgConnection:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            "PostgreSQL support requires psycopg. Install dependencies with: pip install -r requirements.txt"
        ) from exc
    return PgConnection(psycopg.connect(database_url))


def translate_sql(sql: str) -> str:
    return _replace_qmark_placeholders(sql.strip())


def _replace_qmark_placeholders(sql: str) -> str:
    result: list[str] = []
    in_single = False
    in_double = False
    index = 0
    while index < len(sql):
        char = sql[index]
        if char == "'" and not in_double:
            result.append(char)
            if in_single and index + 1 < len(sql) and sql[index + 1] == "'":
                result.append(sql[index + 1])
                index += 2
                continue
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
            result.append(char)
        elif char == "?" and not in_single and not in_double:
            result.append("%s")
        else:
            result.append(char)
        index += 1
    return "".join(result)


def _insert_table(sql: str) -> str | None:
    match = re.match(r"(?is)^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b", sql)
    return match.group(1) if match else None


def _append_returning_id(sql: str) -> str:
    stripped = sql.rstrip().rstrip(";")
    table = _insert_table(stripped)
    if not table or table not in IDENTITY_TABLES:
        return sql
    if re.search(r"(?is)\bRETURNING\b|\bON\s+CONFLICT\b", stripped):
        return sql
    return f"{stripped} RETURNING id"


def _returns_generated_id(sql: str) -> bool:
    return bool(re.search(r"(?is)\bRETURNING\s+id\b", sql))


def _split_sql_script(script: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    in_single = False
    in_double = False
    index = 0
    while index < len(script):
        char = script[index]
        if char == "'" and not in_double:
            current.append(char)
            if in_single and index + 1 < len(script) and script[index + 1] == "'":
                current.append(script[index + 1])
                index += 2
                continue
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
            current.append(char)
        elif char == ";" and not in_single and not in_double:
            statements.append("".join(current))
            current = []
        else:
            current.append(char)
        index += 1
    if current:
        statements.append("".join(current))
    return statements
