from __future__ import annotations

import os
import re
import unittest
from typing import Any

from worker.db import init_db
from worker.pg import TABLE_ORDER, PgCursor, connect_postgres


POSTGRES_TEST_SKIP_REASON = "TEST_DATABASE_URL is not set; skipping PostgreSQL integration test"


def test_database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL", "").strip()


def require_test_database_url() -> str:
    database_url = test_database_url()
    if not database_url:
        raise unittest.SkipTest(POSTGRES_TEST_SKIP_REASON)
    return database_url


class TestPostgresConnection:
    dialect = "postgres"

    def __init__(self, conn: Any):
        self._conn = conn
        self._lastrowid = 0
        self.row_factory = None

    def execute(self, sql: str, params=()) -> PgCursor:
        normalized = " ".join(str(sql).strip().lower().split())
        if re.fullmatch(r"select last_insert_rowid\(\)(?: as id)?", normalized):
            return self._conn.execute("SELECT ? AS id", (self._lastrowid,))
        cursor = self._conn.execute(sql, params)
        if getattr(cursor, "lastrowid", None) is not None:
            self._lastrowid = int(cursor.lastrowid)
        return cursor

    def executescript(self, script: str) -> None:
        self._conn.executescript(script)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


def connect_test_db() -> TestPostgresConnection:
    conn = TestPostgresConnection(connect_postgres(require_test_database_url()))
    init_db(conn)
    reset_test_db(conn)
    return conn


def reset_test_db(conn: TestPostgresConnection) -> None:
    tables = ", ".join(TABLE_ORDER)
    conn.execute(f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE")
    conn.commit()
