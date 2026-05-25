from __future__ import annotations

import unittest

from worker.pgvector_search import ensure_pgvector_indexes, pgvector_embedding_search


class FakeCursor:
    def __init__(self, rows=None, rowcount: int = 0):
        self._rows = list(rows or [])
        self.rowcount = rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class FakePostgresConnection:
    dialect = "postgres"

    def __init__(self, *, hnsw_fails: bool = False):
        self.hnsw_fails = hnsw_fails
        self.extension_installed = True
        self.vector_column_exists = True
        self.vector_type: str | None = "vector(3)"
        self.inferred_dimensions: int | None = 3
        self.search_rows = []
        self.statements: list[tuple[str, tuple[object, ...]]] = []
        self.commits = 0
        self.rollbacks = 0

    def execute(self, sql: str, params=()):
        clean_sql = " ".join(sql.split())
        values = tuple(params or ())
        self.statements.append((clean_sql, values))
        lowered = clean_sql.lower()
        if "using hnsw" in lowered and self.hnsw_fails:
            raise RuntimeError("hnsw unavailable")
        if "select exists" in lowered and "pg_extension" in lowered:
            return FakeCursor([{"installed": self.extension_installed}])
        if "from information_schema.columns" in lowered:
            return FakeCursor([{"present": 1}] if self.vector_column_exists else [])
        if "format_type" in lowered and "pg_attribute" in lowered:
            return FakeCursor([{"data_type": self.vector_type}] if self.vector_type else [])
        if "jsonb_array_length" in lowered:
            return FakeCursor(
                [{"dimensions": self.inferred_dimensions}]
                if self.inferred_dimensions is not None
                else []
            )
        if lowered.startswith("update chunk_embeddings"):
            return FakeCursor(rowcount=2)
        if lowered.startswith("select chunk_id"):
            return FakeCursor(self.search_rows)
        return FakeCursor()

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class PgvectorSearchTests(unittest.TestCase):
    def test_search_returns_empty_for_empty_scope(self) -> None:
        conn = FakePostgresConnection()
        self.assertEqual(pgvector_embedding_search(conn, [0.1, 0.2], [], 5), [])
        self.assertEqual(conn.statements, [])

    def test_search_returns_empty_when_pgvector_not_ready(self) -> None:
        conn = FakePostgresConnection()
        conn.extension_installed = False

        self.assertEqual(pgvector_embedding_search(conn, [0.1, 0.2], [1, 2], 5), [])

        statements = [sql for sql, _params in conn.statements]
        self.assertTrue(any("pg_extension" in sql for sql in statements))
        self.assertFalse(any(sql.startswith("SELECT chunk_id") for sql in statements))

    def test_search_uses_scoped_any_query_and_converts_distance_to_score(self) -> None:
        conn = FakePostgresConnection()
        conn.search_rows = [
            {"chunk_id": 20, "distance": 0.25},
            {"chunk_id": 10, "distance": 0.1},
        ]

        hits = pgvector_embedding_search(conn, [0.1, 0.2, 0.3], [20, 10, 10], 2)

        self.assertEqual([hit.chunk_id for hit in hits], [10, 20])
        self.assertAlmostEqual(hits[0].score, 0.9)
        self.assertAlmostEqual(hits[1].score, 0.75)
        search_sql, search_params = conn.statements[-1]
        self.assertIn("chunk_id = ANY(CAST(? AS integer[]))", search_sql)
        self.assertIn("ORDER BY distance ASC", search_sql)
        self.assertEqual(search_params, ("[0.1,0.2,0.3]", [10, 20], 2))

    def test_ensure_pgvector_indexes_adds_dimensioned_column_backfills_and_hnsw(self) -> None:
        conn = FakePostgresConnection()
        conn.vector_type = None
        conn.vector_column_exists = False

        result = ensure_pgvector_indexes(conn, dimensions=3)

        self.assertTrue(result["supported"])
        self.assertEqual(result["dimensions"], 3)
        self.assertTrue(result["column_added"])
        self.assertEqual(result["embeddings_backfilled"], 2)
        self.assertEqual(result["index_method"], "hnsw")
        statements = [sql for sql, _params in conn.statements]
        self.assertIn("CREATE EXTENSION IF NOT EXISTS vector", statements)
        self.assertTrue(any("ADD COLUMN embedding_vector vector(3)" in sql for sql in statements))
        self.assertTrue(any("embedding_json::vector(3)" in sql for sql in statements))
        self.assertTrue(any("USING hnsw" in sql for sql in statements))

    def test_ensure_pgvector_indexes_infers_dimensions_and_falls_back_to_ivfflat(self) -> None:
        conn = FakePostgresConnection(hnsw_fails=True)
        conn.vector_type = "vector"

        result = ensure_pgvector_indexes(conn)

        self.assertEqual(result["dimensions"], 3)
        self.assertTrue(result["column_altered"])
        self.assertEqual(result["index_method"], "ivfflat")
        self.assertIn("hnsw unavailable", str(result["index_error"]))
        self.assertEqual(conn.rollbacks, 1)
        statements = [sql for sql, _params in conn.statements]
        self.assertTrue(any("jsonb_array_length" in sql for sql in statements))
        self.assertTrue(any("TYPE vector(3)" in sql for sql in statements))
        self.assertTrue(any("USING ivfflat" in sql for sql in statements))


if __name__ == "__main__":
    unittest.main()
