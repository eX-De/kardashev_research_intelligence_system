from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping


Tokenizer = Callable[[str], Iterable[str]]

_PROJECT_CHUNK_SQL = """
SELECT
  0 AS relation_rank,
  c.id,
  c.note_id,
  c.document_id,
  c.chunk_index,
  c.heading,
  c.text,
  c.source,
  COALESCE(n.title, kd.title, '') AS note_title,
  COALESCE(n.path, kd.source_uri, '') AS note_path,
  COALESCE(kd.title, '') AS document_title,
  COALESCE(kd.source_type, '') AS source_type,
  COALESCE(kd.source_uri, '') AS source_uri,
  pcd.relation AS project_relation,
  pcd.weight AS project_weight
FROM project_context_documents pcd
JOIN research_chunks c ON c.document_id = pcd.document_id
LEFT JOIN knowledge_documents kd ON kd.id = c.document_id
LEFT JOIN obsidian_notes n ON n.id = c.note_id
WHERE pcd.project_id = ?
UNION ALL
SELECT
  1 AS relation_rank,
  c.id,
  c.note_id,
  c.document_id,
  c.chunk_index,
  c.heading,
  c.text,
  c.source,
  COALESCE(n.title, kd.title, '') AS note_title,
  COALESCE(n.path, kd.source_uri, '') AS note_path,
  COALESCE(kd.title, '') AS document_title,
  COALESCE(kd.source_type, '') AS source_type,
  COALESCE(kd.source_uri, '') AS source_uri,
  pn.relation AS project_relation,
  1.0 AS project_weight
FROM project_notes pn
JOIN research_chunks c ON c.note_id = pn.note_id
LEFT JOIN knowledge_documents kd ON kd.id = c.document_id
LEFT JOIN obsidian_notes n ON n.id = c.note_id
WHERE pn.project_id = ?
ORDER BY 1, 5, 2, 14
"""

_RECORD_KEYS = (
    "id",
    "note_id",
    "document_id",
    "chunk_index",
    "heading",
    "text",
    "source",
    "note_title",
    "note_path",
    "document_title",
    "source_type",
    "source_uri",
    "project_relation",
    "project_weight",
    "title",
    "path",
    "tokens",
    "token_set",
)


@dataclass(frozen=True)
class ProjectChunkRecord:
    id: int
    note_id: int | None
    document_id: int | None
    chunk_index: int
    heading: str
    text: str
    source: str
    note_title: str
    note_path: str
    document_title: str
    source_type: str
    source_uri: str
    project_relation: str
    project_weight: float
    tokens: tuple[str, ...]
    token_set: frozenset[str]

    @property
    def title(self) -> str:
        return self.document_title or self.note_title

    @property
    def path(self) -> str:
        return self.source_uri or self.note_path

    @property
    def token_text(self) -> str:
        return f"{self.heading} {self.text}"

    def __getitem__(self, key: str) -> object:
        if key == "title":
            return self.title
        if key == "path":
            return self.path
        if key in _RECORD_KEYS:
            return getattr(self, key)
        raise KeyError(key)

    def get(self, key: str, default: object = None) -> object:
        try:
            return self[key]
        except KeyError:
            return default

    def keys(self) -> tuple[str, ...]:
        return _RECORD_KEYS

    def as_dict(self) -> dict[str, object]:
        return {key: self[key] for key in _RECORD_KEYS}


@dataclass(frozen=True)
class ProjectMatchCache:
    project_id: int
    chunks: tuple[ProjectChunkRecord, ...]
    chunks_by_id: Mapping[int, ProjectChunkRecord]
    chunk_ids: frozenset[int]
    tokens_by_id: Mapping[int, tuple[str, ...]]
    token_sets_by_id: Mapping[int, frozenset[str]]

    @classmethod
    def from_chunks(cls, project_id: int, chunks: Iterable[ProjectChunkRecord]) -> "ProjectMatchCache":
        chunk_records = tuple(chunks)
        chunks_by_id = {record.id: record for record in chunk_records}
        return cls(
            project_id=int(project_id),
            chunks=chunk_records,
            chunks_by_id=chunks_by_id,
            chunk_ids=frozenset(chunks_by_id),
            tokens_by_id={record.id: record.tokens for record in chunk_records},
            token_sets_by_id={record.id: record.token_set for record in chunk_records},
        )

    def __bool__(self) -> bool:
        return bool(self.chunk_ids)

    def __contains__(self, chunk_id: object) -> bool:
        try:
            return int(chunk_id) in self.chunk_ids
        except (TypeError, ValueError):
            return False

    def __iter__(self):
        return iter(self.chunks)

    def __len__(self) -> int:
        return len(self.chunks)

    @property
    def chunk_records(self) -> tuple[ProjectChunkRecord, ...]:
        return self.chunks

    def get(self, chunk_id: object, default: ProjectChunkRecord | None = None) -> ProjectChunkRecord | None:
        try:
            key = int(chunk_id)
        except (TypeError, ValueError):
            return default
        return self.chunks_by_id.get(key, default)

    def records_for_keyword_search(self) -> tuple[ProjectChunkRecord, ...]:
        return self.chunks

    def records_for_front_page_search(self) -> tuple[ProjectChunkRecord, ...]:
        return tuple(record for record in self.chunks if record.chunk_index <= 4)


def load_project_match_cache(conn: Any, project_id: int, tokenize_fn: Tokenizer) -> ProjectMatchCache:
    rows = conn.execute(_PROJECT_CHUNK_SQL, (project_id, project_id)).fetchall()
    chunks_by_id: dict[int, ProjectChunkRecord] = {}
    ordered_chunks: list[ProjectChunkRecord] = []
    for row in rows:
        chunk_id = int(_row_value(row, "id"))
        if chunk_id in chunks_by_id:
            continue
        record = _project_chunk_record_from_row(row, tokenize_fn)
        chunks_by_id[chunk_id] = record
        ordered_chunks.append(record)
    return ProjectMatchCache.from_chunks(project_id, ordered_chunks)


def _project_chunk_record_from_row(row: Any, tokenize_fn: Tokenizer) -> ProjectChunkRecord:
    heading = _text_value(_row_value(row, "heading"))
    text = _text_value(_row_value(row, "text"))
    token_text = f"{heading} {text}"
    tokens = tuple(str(token) for token in tokenize_fn(token_text))
    return ProjectChunkRecord(
        id=int(_row_value(row, "id")),
        note_id=_optional_int(_row_value(row, "note_id")),
        document_id=_optional_int(_row_value(row, "document_id")),
        chunk_index=int(_row_value(row, "chunk_index")),
        heading=heading,
        text=text,
        source=_text_value(_row_value(row, "source")),
        note_title=_text_value(_row_value(row, "note_title")),
        note_path=_text_value(_row_value(row, "note_path")),
        document_title=_text_value(_row_value(row, "document_title")),
        source_type=_text_value(_row_value(row, "source_type")),
        source_uri=_text_value(_row_value(row, "source_uri")),
        project_relation=_text_value(_row_value(row, "project_relation")),
        project_weight=float(_row_value(row, "project_weight") or 0),
        tokens=tokens,
        token_set=frozenset(tokens),
    )


def _row_value(row: Any, key: str) -> object:
    return row[key]


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    return int(value)


def _text_value(value: object) -> str:
    if value is None:
        return ""
    return str(value)
