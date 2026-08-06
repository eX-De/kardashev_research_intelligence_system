from __future__ import annotations

import os
import re
import unittest
import uuid
from typing import Any

from worker.db import init_db
from worker.pg import TABLE_ORDER, PgCursor, connect_postgres


POSTGRES_TEST_SKIP_REASON = "TEST_DATABASE_URL is not set; skipping PostgreSQL integration test"
TEST_SCHEMA_PREFIX = "ris_test_"
_TEST_SCHEMA_RE = re.compile(rf"^{TEST_SCHEMA_PREFIX}[0-9a-f]{{32}}$")
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def test_database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL", "").strip().strip("\"'")


def require_test_database_url() -> str:
    database_url = test_database_url()
    if not database_url:
        raise unittest.SkipTest(POSTGRES_TEST_SKIP_REASON)
    return database_url


def _new_test_schema() -> str:
    return f"{TEST_SCHEMA_PREFIX}{uuid.uuid4().hex}"


def _require_test_schema(schema: str) -> str:
    if schema == "public" or not _TEST_SCHEMA_RE.fullmatch(schema):
        raise RuntimeError(
            f"refusing destructive PostgreSQL test operation outside an owned {TEST_SCHEMA_PREFIX}<uuid> schema: {schema!r}"
        )
    return schema


def _quote_identifier(identifier: str) -> str:
    if not _IDENTIFIER_RE.fullmatch(identifier):
        raise RuntimeError(f"refusing unsafe PostgreSQL identifier: {identifier!r}")
    return f'"{identifier.replace(chr(34), chr(34) * 2)}"'


class TestPostgresConnection:
    dialect = "postgres"

    def __init__(
        self,
        conn: Any,
        *,
        database_url: str,
        test_schema: str,
        owns_schema: bool,
    ):
        self._conn = conn
        self._database_url = database_url
        self.test_schema = _require_test_schema(test_schema)
        self._owns_schema = owns_schema
        self._closed = False
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

    @property
    def database_url(self) -> str:
        return self._database_url

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        error: Exception | None = None
        try:
            self._conn.rollback()
            if self._owns_schema:
                schema = _require_test_schema(self.test_schema)
                self._conn.execute("SET search_path TO pg_catalog")
                self._conn.execute(f"DROP SCHEMA IF EXISTS {_quote_identifier(schema)} CASCADE")
                self._conn.commit()
        except Exception as exc:
            error = exc
            try:
                self._conn.rollback()
            except Exception:
                pass
        finally:
            self._conn.close()
        if error is not None:
            raise error

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


def _verify_test_schema(conn: TestPostgresConnection) -> dict[str, Any]:
    schema = _require_test_schema(conn.test_schema)
    row = conn.execute(
        """
        SELECT current_database() AS database_name,
               current_schema() AS schema_name,
               current_schemas(false) AS search_path,
               COALESCE(inet_server_addr()::text, 'local') AS host,
               inet_server_port() AS port
        """
    ).fetchone()
    if row is None:
        raise RuntimeError("could not verify PostgreSQL test target")
    current_schema = str(row["schema_name"] or "")
    search_path = list(row["search_path"] or [])
    if current_schema != schema or search_path != [schema] or "public" in search_path:
        raise RuntimeError(
            "refusing PostgreSQL test connection with unsafe search_path: "
            f"database={row['database_name']!r} current_schema={current_schema!r} search_path={search_path!r}"
        )
    target = {
        "host": str(row["host"]),
        "port": int(row["port"]) if row["port"] is not None else None,
        "database": str(row["database_name"]),
        "schema": schema,
        "search_path": search_path,
    }
    conn.commit()
    return target


def postgres_test_preflight(conn: TestPostgresConnection, *, print_target: bool = True) -> dict[str, Any]:
    target = _verify_test_schema(conn)
    if print_target:
        print(
            "PostgreSQL test target: "
            f"host={target['host']} port={target['port']} database={target['database']} "
            f"schema={target['schema']} search_path={target['search_path']}"
        )
    return target


def _activate_test_schema(conn: TestPostgresConnection, *, print_target: bool) -> dict[str, Any]:
    schema = _require_test_schema(conn.test_schema)
    conn.execute(f"SET search_path TO {_quote_identifier(schema)}")
    return postgres_test_preflight(conn, print_target=print_target)


def connect_test_db() -> TestPostgresConnection:
    database_url = require_test_database_url()
    schema = _new_test_schema()
    conn = TestPostgresConnection(
        connect_postgres(database_url),
        database_url=database_url,
        test_schema=schema,
        owns_schema=True,
    )
    try:
        conn.execute(f"CREATE SCHEMA {_quote_identifier(schema)}")
        conn.commit()
        _activate_test_schema(conn, print_target=True)
        init_db(conn)
        reset_test_db(conn)
        return conn
    except Exception:
        conn.close()
        raise


def connect_test_db_peer(owner: TestPostgresConnection) -> TestPostgresConnection:
    schema = _require_test_schema(owner.test_schema)
    conn = TestPostgresConnection(
        connect_postgres(owner._database_url),
        database_url=owner._database_url,
        test_schema=schema,
        owns_schema=False,
    )
    try:
        _activate_test_schema(conn, print_target=False)
        return conn
    except Exception:
        conn.close()
        raise


def reset_test_db(conn: TestPostgresConnection) -> None:
    target = postgres_test_preflight(conn, print_target=False)
    schema = _require_test_schema(target["schema"])
    if schema != conn.test_schema:
        raise RuntimeError(
            f"refusing to reset schema not owned by this lifecycle: {schema!r} != {conn.test_schema!r}"
        )
    qualified_tables = ", ".join(
        f"{_quote_identifier(schema)}.{_quote_identifier(table)}" for table in TABLE_ORDER
    )
    conn.execute(f"TRUNCATE TABLE {qualified_tables} RESTART IDENTITY CASCADE")
    conn.commit()
