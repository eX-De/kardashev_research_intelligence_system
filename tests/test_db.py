from __future__ import annotations

import unittest

from helpers import connect_test_db
from worker.db import POSTGRES_REQUIRED_INDEXES, REQUIRED_TABLES, postgres_index_sql, postgres_schema_sql
from worker.pg import PgConnection


class FakePsycopgCursor:
    def __init__(self) -> None:
        self.description = []
        self.rowcount = 0
        self.rows = []
        self.executed_sql = ""
        self.executed_params = ()

    def execute(self, sql: str, params=()) -> None:
        self.executed_sql = sql
        self.executed_params = params
        if "RETURNING id, status" in sql:
            self.description = [type("Column", (), {"name": "id"})(), type("Column", (), {"name": "status"})()]
            self.rows = [(7, "running")]
            self.rowcount = 1
        elif "RETURNING id" in sql:
            self.description = [type("Column", (), {"name": "id"})()]
            self.rows = [(9,)]
            self.rowcount = 1
        else:
            self.description = []
            self.rows = []
            self.rowcount = 1

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def fetchall(self):
        rows = self.rows
        self.rows = []
        return rows


class FakePsycopgConnection:
    def __init__(self) -> None:
        self.last_cursor = None

    def cursor(self):
        self.last_cursor = FakePsycopgCursor()
        return self.last_cursor

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


class PostgresTestDatabaseTests(unittest.TestCase):
    def test_pg_connection_does_not_consume_explicit_returning_rows(self) -> None:
        raw = FakePsycopgConnection()
        conn = PgConnection(raw)
        cursor = conn.execute("UPDATE worker_jobs SET status = ? WHERE id = ? RETURNING id, status", ("running", 7))

        row = cursor.fetchone()
        self.assertEqual(row["id"], 7)
        self.assertEqual(row["status"], "running")
        self.assertIsNone(cursor.fetchone())

    def test_pg_connection_still_sets_lastrowid_for_auto_insert_returning(self) -> None:
        raw = FakePsycopgConnection()
        conn = PgConnection(raw)
        cursor = conn.execute("INSERT INTO app_events(event_type) VALUES (?)", ("task.started",))

        self.assertEqual(cursor.lastrowid, 9)
        self.assertIsNone(cursor.fetchone())

    def test_queue_and_outbox_schema_is_required(self) -> None:
        schema = postgres_schema_sql()
        indexes = postgres_index_sql()
        self.assertIn("CREATE TABLE IF NOT EXISTS worker_jobs", schema)
        self.assertIn("CREATE TABLE IF NOT EXISTS app_events", schema)
        self.assertIn("worker_jobs", REQUIRED_TABLES)
        self.assertIn("app_events", REQUIRED_TABLES)
        self.assertIn("idx_worker_jobs_claim", POSTGRES_REQUIRED_INDEXES)
        self.assertIn("idx_worker_jobs_job_run", POSTGRES_REQUIRED_INDEXES)
        self.assertIn("idx_app_events_unpublished", POSTGRES_REQUIRED_INDEXES)
        self.assertIn("CREATE INDEX IF NOT EXISTS idx_worker_jobs_claim", indexes)
        self.assertIn("CREATE INDEX IF NOT EXISTS idx_app_events_unpublished", indexes)

    def test_test_database_helper_uses_postgres_connection(self) -> None:
        conn = connect_test_db()
        try:
            self.assertEqual(conn.dialect, "postgres")
            row = conn.execute("SELECT COUNT(*) AS count FROM job_runs").fetchone()
            self.assertEqual(row["count"], 0)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
