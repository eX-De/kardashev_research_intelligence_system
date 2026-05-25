from __future__ import annotations

import unittest

from helpers import connect_test_db
from worker.project_match_cache import ProjectChunkRecord, load_project_match_cache


NOW = "2026-05-19T00:00:00Z"


class ProjectMatchCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = connect_test_db()

    def test_loads_project_document_and_note_chunks_with_metadata(self) -> None:
        project_id = self._insert_project()
        document_id = self._insert_document(
            source_type="manual_project",
            source_uri="manual://doc",
            title="Document Title",
        )
        note_id = self._insert_note(path="Projects/Context.md", title="Context Note")
        document_chunk_id = self._insert_chunk(
            document_id=document_id,
            chunk_index=2,
            heading="Doc Heading",
            text="Document context body",
            source="manual_project",
        )
        note_chunk_id = self._insert_chunk(
            note_id=note_id,
            chunk_index=0,
            heading="Note Heading",
            text="Note context body",
            source="obsidian",
        )
        self._link_document(project_id, document_id)
        self._link_note(project_id, note_id, relation="folder_member")

        cache = load_project_match_cache(self.conn, project_id, tokenize_fn=lambda text: text.lower().split())

        self.assertEqual(cache.project_id, project_id)
        self.assertEqual(cache.chunk_ids, {document_chunk_id, note_chunk_id})
        self.assertEqual(set(cache.chunks_by_id), {document_chunk_id, note_chunk_id})
        document_record = cache.get(document_chunk_id)
        note_record = cache.get(note_chunk_id)
        self.assertIsNotNone(document_record)
        self.assertIsNotNone(note_record)
        assert document_record is not None
        assert note_record is not None
        self.assertEqual(document_record.document_id, document_id)
        self.assertIsNone(document_record.note_id)
        self.assertEqual(document_record.title, "Document Title")
        self.assertEqual(document_record.path, "manual://doc")
        self.assertEqual(document_record["source_type"], "manual_project")
        self.assertEqual(note_record.note_id, note_id)
        self.assertIsNone(note_record.document_id)
        self.assertEqual(note_record.title, "Context Note")
        self.assertEqual(note_record.path, "Projects/Context.md")
        self.assertEqual(note_record.project_relation, "folder_member")

    def test_deduplicates_chunk_ids_before_tokenizing(self) -> None:
        project_id = self._insert_project()
        document_id = self._insert_document(
            source_type="obsidian",
            source_uri="Projects/Shared.md",
            title="Shared Document",
        )
        note_id = self._insert_note(path="Projects/Shared.md", title="Shared Note")
        chunk_id = self._insert_chunk(
            note_id=note_id,
            document_id=document_id,
            chunk_index=0,
            heading="Shared Heading",
            text="Shared body",
        )
        self._link_document(project_id, document_id)
        self._link_note(project_id, note_id)
        tokenized_texts: list[str] = []

        def tokenize(text: str) -> list[str]:
            tokenized_texts.append(text)
            return text.lower().split()

        cache = load_project_match_cache(self.conn, project_id, tokenize_fn=tokenize)

        self.assertEqual(len(cache), 1)
        self.assertEqual(cache.chunk_ids, {chunk_id})
        self.assertEqual(tokenized_texts, ["Shared Heading Shared body"])

    def test_precomputes_tokens_and_token_sets_by_chunk(self) -> None:
        project_id = self._insert_project()
        note_id = self._insert_note(path="Projects/Tokens.md", title="Tokens")
        chunk_id = self._insert_chunk(
            note_id=note_id,
            chunk_index=0,
            heading="Alpha Beta",
            text="Beta Gamma",
        )
        self._link_note(project_id, note_id)

        cache = load_project_match_cache(self.conn, project_id, tokenize_fn=lambda text: text.lower().split())
        record = cache.get(chunk_id)

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.tokens, ("alpha", "beta", "beta", "gamma"))
        self.assertEqual(record.token_set, {"alpha", "beta", "gamma"})
        self.assertEqual(cache.tokens_by_id[chunk_id], record.tokens)
        self.assertEqual(cache.token_sets_by_id[chunk_id], record.token_set)

    def test_exposes_row_like_records_and_front_page_view(self) -> None:
        project_id = self._insert_project()
        note_id = self._insert_note(path="Projects/Front.md", title="Front")
        front_chunk_id = self._insert_chunk(note_id=note_id, chunk_index=4, heading="Front", text="Visible")
        later_chunk_id = self._insert_chunk(note_id=note_id, chunk_index=5, heading="Later", text="Hidden")
        self._link_note(project_id, note_id)

        cache = load_project_match_cache(self.conn, project_id, tokenize_fn=lambda text: text.lower().split())

        self.assertIn(front_chunk_id, cache)
        self.assertIn(later_chunk_id, cache)
        self.assertIsInstance(cache.get(front_chunk_id), ProjectChunkRecord)
        self.assertEqual(cache.get(front_chunk_id)["heading"], "Front")
        self.assertEqual([record.id for record in cache.records_for_keyword_search()], [front_chunk_id, later_chunk_id])
        self.assertEqual([record.id for record in cache.records_for_front_page_search()], [front_chunk_id])

    def _insert_project(self) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO research_projects(name, status, created_at, updated_at)
            VALUES ('Cache Project', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
        return int(cursor.lastrowid)

    def _insert_document(self, *, source_type: str, source_uri: str, title: str) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO knowledge_documents(
              source_type, source_uri, title, raw_content, content_hash,
              metadata_json, indexed_at, created_at, updated_at
            )
            VALUES (?, ?, ?, '', ?, '{}', ?, ?, ?)
            """,
            (source_type, source_uri, title, f"hash-{source_uri}", NOW, NOW, NOW),
        )
        return int(cursor.lastrowid)

    def _insert_note(self, *, path: str, title: str) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES (?, ?, '{}', '[]', ?, 1, ?)
            """,
            (path, title, f"sha-{path}", NOW),
        )
        return int(cursor.lastrowid)

    def _insert_chunk(
        self,
        *,
        chunk_index: int,
        heading: str,
        text: str,
        note_id: int | None = None,
        document_id: int | None = None,
        source: str = "obsidian",
    ) -> int:
        cursor = self.conn.execute(
            """
            INSERT INTO research_chunks(
              note_id, document_id, chunk_index, heading, text, token_count, source, created_at
            )
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (note_id, document_id, chunk_index, heading, text, source, NOW),
        )
        return int(cursor.lastrowid)

    def _link_document(self, project_id: int, document_id: int) -> None:
        self.conn.execute(
            """
            INSERT INTO project_context_documents(project_id, document_id, relation, weight, created_at, updated_at)
            VALUES (?, ?, 'source', 1, ?, ?)
            """,
            (project_id, document_id, NOW, NOW),
        )

    def _link_note(self, project_id: int, note_id: int, *, relation: str = "source") -> None:
        self.conn.execute(
            """
            INSERT INTO project_notes(project_id, note_id, relation, note, created_at, updated_at)
            VALUES (?, ?, ?, '', ?, ?)
            """,
            (project_id, note_id, relation, NOW, NOW),
        )


if __name__ == "__main__":
    unittest.main()
