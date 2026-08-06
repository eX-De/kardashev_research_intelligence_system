from __future__ import annotations

import os
import unittest
from unittest.mock import patch

import helpers as db_helpers
from worker.pg import TABLE_ORDER


class _Cursor:
    lastrowid = None

    def __init__(self, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class _RecordingConnection:
    def __init__(self, *, schema: str):
        self.schema = schema
        self.statements: list[str] = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def execute(self, sql: str, params=()):
        del params
        normalized = " ".join(sql.split())
        self.statements.append(normalized)
        if normalized.startswith("SET search_path TO \""):
            self.schema = normalized.split('"', 2)[1]
        elif normalized == "SET search_path TO pg_catalog":
            self.schema = "pg_catalog"
        if "current_database() AS database_name" in normalized:
            return _Cursor({
                "database_name": "test_database",
                "schema_name": self.schema,
                "search_path": [self.schema],
                "host": "127.0.0.1",
                "port": 5432,
            })
        return _Cursor()

    def executescript(self, script: str) -> None:
        self.statements.append(script)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def close(self) -> None:
        self.closed = True


def _wrapped(raw: _RecordingConnection, schema: str, *, owns_schema: bool = False):
    return db_helpers.TestPostgresConnection(
        raw,
        database_url="postgresql://redacted/test_database",
        test_schema=schema,
        owns_schema=owns_schema,
    )


class PostgresTestIsolationUnitTests(unittest.TestCase):
    def test_guard_rejects_public_and_non_owned_schema_names(self) -> None:
        for schema in ("public", "ris_worker_old", "ris_test_not-a-uuid", ""):
            with self.subTest(schema=schema):
                with self.assertRaisesRegex(RuntimeError, "refusing destructive PostgreSQL test operation"):
                    db_helpers._require_test_schema(schema)

    def test_reset_refuses_when_connection_is_not_in_owned_schema(self) -> None:
        owned = "ris_test_" + "a" * 32
        raw = _RecordingConnection(schema="public")
        conn = _wrapped(raw, owned)
        with self.assertRaisesRegex(RuntimeError, "unsafe search_path"):
            db_helpers.reset_test_db(conn)
        self.assertFalse(any(statement.startswith("TRUNCATE TABLE") for statement in raw.statements))

    def test_reset_uses_only_schema_qualified_quoted_table_names(self) -> None:
        schema = "ris_test_" + "b" * 32
        raw = _RecordingConnection(schema=schema)
        conn = _wrapped(raw, schema)
        db_helpers.reset_test_db(conn)
        truncate = next(statement for statement in raw.statements if statement.startswith("TRUNCATE TABLE"))
        for table in TABLE_ORDER:
            self.assertIn(f'"{schema}"."{table}"', truncate)
        table_list = truncate.removeprefix("TRUNCATE TABLE ").removesuffix(" RESTART IDENTITY CASCADE")
        unqualified = [part for part in table_list.split(", ") if not part.startswith(f'"{schema}".')]
        self.assertEqual(unqualified, [])

    def test_each_lifecycle_owns_and_drops_only_its_random_schema(self) -> None:
        raw_connections: list[_RecordingConnection] = []

        def connect(_database_url: str):
            raw = _RecordingConnection(schema="public")
            raw_connections.append(raw)
            return raw

        with patch.object(db_helpers, "require_test_database_url", return_value="postgresql://redacted/test_database"), \
             patch.object(db_helpers, "connect_postgres", side_effect=connect), \
             patch.object(db_helpers, "init_db"):
            first = db_helpers.connect_test_db()
            second = db_helpers.connect_test_db()

        self.assertNotEqual(first.test_schema, second.test_schema)
        self.assertRegex(first.test_schema, r"^ris_test_[0-9a-f]{32}$")
        self.assertRegex(second.test_schema, r"^ris_test_[0-9a-f]{32}$")
        first_schema, second_schema = first.test_schema, second.test_schema
        first.close()
        second.close()
        self.assertIn(f'DROP SCHEMA IF EXISTS "{first_schema}" CASCADE', raw_connections[0].statements)
        self.assertNotIn(f'DROP SCHEMA IF EXISTS "{second_schema}" CASCADE', raw_connections[0].statements)
        self.assertIn(f'DROP SCHEMA IF EXISTS "{second_schema}" CASCADE', raw_connections[1].statements)


@unittest.skipUnless(os.environ.get("TEST_DATABASE_URL", "").strip(), "TEST_DATABASE_URL is not set")
class PostgresTestIsolationIntegrationTests(unittest.TestCase):
    def test_independent_real_lifecycles_use_distinct_non_public_schemas(self) -> None:
        first = db_helpers.connect_test_db()
        second = db_helpers.connect_test_db()
        try:
            first_target = db_helpers.postgres_test_preflight(first)
            second_target = db_helpers.postgres_test_preflight(second)
            self.assertEqual(first_target["database"], second_target["database"])
            self.assertNotEqual(first_target["schema"], second_target["schema"])
            self.assertNotIn("public", first_target["search_path"])
            self.assertNotIn("public", second_target["search_path"])
            first.execute("CREATE TABLE isolation_probe(value integer)")
            first.execute("INSERT INTO isolation_probe(value) VALUES (1)")
            first.commit()
            self.assertIsNone(second.execute("SELECT to_regclass('isolation_probe') AS name").fetchone()["name"])
        finally:
            first.close()
            second.close()


if __name__ == "__main__":
    unittest.main()
