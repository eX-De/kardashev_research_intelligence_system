from __future__ import annotations

import unittest

from helpers import connect_test_db


class SystemFirstModelTests(unittest.TestCase):
    def test_postgres_system_first_tables_exist_and_chunks_accept_documents(self) -> None:
        conn = connect_test_db()
        tables = {
            row["name"]
            for row in conn.execute(
                """
                SELECT table_name AS name
                FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_type = 'BASE TABLE'
                """
            ).fetchall()
        }
        for table in (
            "knowledge_documents",
            "project_context_documents",
            "research_chunks",
            "papers",
            "paper_sources",
            "paper_assets",
            "paper_chunks",
            "artifacts",
        ):
            self.assertIn(table, tables)

        cur = conn.execute(
            """
            INSERT INTO knowledge_documents(
              source_type, source_uri, title, raw_content, content_hash,
              metadata_json, indexed_at, created_at, updated_at
            )
            VALUES ('manual_project', 'project:1', 'Manual Context', 'body', 'hash', '{}', 'now', 'now', 'now')
            """
        )
        document_id = int(cur.lastrowid)
        conn.execute(
            """
            INSERT INTO research_chunks(document_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Context', 'body', 1, 'manual_project', 'now')
            """,
            (document_id,),
        )
        row = conn.execute("SELECT note_id, document_id FROM research_chunks").fetchone()
        self.assertIsNone(row["note_id"])
        self.assertEqual(row["document_id"], document_id)


if __name__ == "__main__":
    unittest.main()
