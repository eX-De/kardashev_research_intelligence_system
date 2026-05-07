from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS obsidian_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  sha256 TEXT NOT NULL,
  mtime REAL NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES obsidian_notes(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'obsidian',
  created_at TEXT NOT NULL,
  UNIQUE(note_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES research_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arxiv_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arxiv_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  authors_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  categories_json TEXT NOT NULL DEFAULT '[]',
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  link TEXT NOT NULL,
  pdf_link TEXT NOT NULL DEFAULT '',
  pdf_path TEXT NOT NULL DEFAULT '',
  text_path TEXT NOT NULL DEFAULT '',
  text_extracted_at TEXT,
  text_status TEXT NOT NULL DEFAULT 'pending',
  text_error TEXT NOT NULL DEFAULT '',
  text_char_count INTEGER NOT NULL DEFAULT 0,
  fetched_batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arxiv_paper_tombstones (
  arxiv_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  authors_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  categories_json TEXT NOT NULL DEFAULT '[]',
  published_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  pdf_link TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT 'no_match',
  original_fetched_batch_id TEXT NOT NULL DEFAULT '',
  seen_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  tombstoned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arxiv_text_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'full_text',
  page_start INTEGER,
  page_end INTEGER,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  char_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(paper_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS arxiv_chunk_embeddings (
  arxiv_chunk_id INTEGER PRIMARY KEY REFERENCES arxiv_text_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS arxiv_paper_embeddings (
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(paper_id, model)
);

CREATE TABLE IF NOT EXISTS paper_prefilter_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  score REAL NOT NULL,
  rank INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  top_chunks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  arxiv_chunk_id INTEGER,
  chunk_id INTEGER NOT NULL REFERENCES research_chunks(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  searchers_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(paper_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS user_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, status)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  message TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  obsidian_project_path TEXT NOT NULL DEFAULT '',
  obsidian_output_dir TEXT NOT NULL DEFAULT '',
  obsidian_note_id INTEGER,
  obsidian_folder TEXT NOT NULL DEFAULT '',
  obsidian_status_tag TEXT NOT NULL DEFAULT '',
  discovery_source TEXT NOT NULL DEFAULT 'manual',
  source_tags_json TEXT NOT NULL DEFAULT '[]',
  arxiv_categories_json TEXT NOT NULL DEFAULT '[]',
  automation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_papers (
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'candidate',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, paper_id)
);

CREATE TABLE IF NOT EXISTS project_paper_matches (
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  rank_score REAL NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 0,
  best_arxiv_chunk_id INTEGER REFERENCES arxiv_text_chunks(id) ON DELETE SET NULL,
  best_obsidian_chunk_id INTEGER REFERENCES research_chunks(id) ON DELETE SET NULL,
  searchers_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  match_type TEXT NOT NULL DEFAULT 'project_context',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, paper_id)
);

CREATE TABLE IF NOT EXISTS project_paper_judgments (
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'none',
  relevance_score REAL NOT NULL DEFAULT 0,
  usefulness_score REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  suggested_action TEXT NOT NULL DEFAULT 'ignore',
  reason TEXT NOT NULL DEFAULT '',
  evidence_mapping_json TEXT NOT NULL DEFAULT '[]',
  missing_evidence TEXT NOT NULL DEFAULT '',
  input_hash TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, paper_id)
);

CREATE TABLE IF NOT EXISTS project_paper_recommendations (
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending',
  importance TEXT NOT NULL DEFAULT '',
  relation_type TEXT NOT NULL DEFAULT 'indirect',
  reason TEXT NOT NULL DEFAULT '',
  obsidian_path TEXT NOT NULL DEFAULT '',
  attachment_path TEXT NOT NULL DEFAULT '',
  source_judgment_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT,
  PRIMARY KEY(project_id, paper_id)
);

CREATE TABLE IF NOT EXISTS paper_reading_reports (
  paper_id INTEGER PRIMARY KEY REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  prompt TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model_provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  source_text_hash TEXT NOT NULL DEFAULT '',
  source_project_ids_json TEXT NOT NULL DEFAULT '[]',
  report_markdown TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS project_notes (
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL REFERENCES obsidian_notes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'source',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, note_id)
);

CREATE TABLE IF NOT EXISTS project_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  obsidian_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, artifact_type, obsidian_path)
);

CREATE INDEX IF NOT EXISTS idx_research_chunks_note ON research_chunks(note_id);
CREATE INDEX IF NOT EXISTS idx_arxiv_papers_published ON arxiv_papers(published_at);
CREATE INDEX IF NOT EXISTS idx_arxiv_paper_tombstones_reason ON arxiv_paper_tombstones(reason, tombstoned_at DESC);
CREATE INDEX IF NOT EXISTS idx_arxiv_text_chunks_paper ON arxiv_text_chunks(paper_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_paper_prefilter_runs_paper ON paper_prefilter_runs(paper_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_paper_score ON matches(paper_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_research_projects_status ON research_projects(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_paper_matches_project_score ON project_paper_matches(project_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_project_paper_matches_paper ON project_paper_matches(paper_id);
CREATE INDEX IF NOT EXISTS idx_project_paper_judgments_project_action ON project_paper_judgments(project_id, suggested_action, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_project_paper_judgments_paper ON project_paper_judgments(paper_id);
CREATE INDEX IF NOT EXISTS idx_project_paper_recommendations_state ON project_paper_recommendations(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_paper_recommendations_paper ON project_paper_recommendations(paper_id);
CREATE INDEX IF NOT EXISTS idx_paper_reading_reports_status ON paper_reading_reports(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_artifacts_project ON project_artifacts(project_id, updated_at DESC);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_unicode(value: Any) -> Any:
    if isinstance(value, str):
        try:
            text = value.encode("utf-16", "surrogatepass").decode("utf-16")
        except UnicodeError:
            text = value
        return text.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, list):
        return [clean_unicode(item) for item in value]
    if isinstance(value, tuple):
        return tuple(clean_unicode(item) for item in value)
    if isinstance(value, dict):
        return {
            clean_unicode(key): clean_unicode(item)
            for key, item in value.items()
        }
    return value


def to_json(value: Any) -> str:
    return json.dumps(clean_unicode(value), ensure_ascii=False, sort_keys=True)


def from_json(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return clean_unicode(json.loads(value))
    except json.JSONDecodeError:
        return default


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    _migrate_db(conn)
    conn.commit()


def _migrate_db(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(arxiv_papers)").fetchall()
    }
    migrations = {
        "pdf_path": "ALTER TABLE arxiv_papers ADD COLUMN pdf_path TEXT NOT NULL DEFAULT ''",
        "text_path": "ALTER TABLE arxiv_papers ADD COLUMN text_path TEXT NOT NULL DEFAULT ''",
        "text_extracted_at": "ALTER TABLE arxiv_papers ADD COLUMN text_extracted_at TEXT",
        "text_status": "ALTER TABLE arxiv_papers ADD COLUMN text_status TEXT NOT NULL DEFAULT 'pending'",
        "text_error": "ALTER TABLE arxiv_papers ADD COLUMN text_error TEXT NOT NULL DEFAULT ''",
        "text_char_count": "ALTER TABLE arxiv_papers ADD COLUMN text_char_count INTEGER NOT NULL DEFAULT 0",
    }
    for column, sql in migrations.items():
        if column not in columns:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
    match_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(matches)").fetchall()
    }
    if "arxiv_chunk_id" not in match_columns:
        try:
            conn.execute("ALTER TABLE matches ADD COLUMN arxiv_chunk_id INTEGER")
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
    project_match_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(project_paper_matches)").fetchall()
    }
    project_match_migrations = {
        "rank_score": "ALTER TABLE project_paper_matches ADD COLUMN rank_score REAL NOT NULL DEFAULT 0",
        "quality_score": "ALTER TABLE project_paper_matches ADD COLUMN quality_score REAL NOT NULL DEFAULT 0",
    }
    for column, sql in project_match_migrations.items():
        if column not in project_match_columns:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
    project_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(research_projects)").fetchall()
    }
    project_migrations = {
        "obsidian_project_path": "ALTER TABLE research_projects ADD COLUMN obsidian_project_path TEXT NOT NULL DEFAULT ''",
        "obsidian_output_dir": "ALTER TABLE research_projects ADD COLUMN obsidian_output_dir TEXT NOT NULL DEFAULT ''",
        "obsidian_note_id": "ALTER TABLE research_projects ADD COLUMN obsidian_note_id INTEGER",
        "obsidian_folder": "ALTER TABLE research_projects ADD COLUMN obsidian_folder TEXT NOT NULL DEFAULT ''",
        "obsidian_status_tag": "ALTER TABLE research_projects ADD COLUMN obsidian_status_tag TEXT NOT NULL DEFAULT ''",
        "discovery_source": "ALTER TABLE research_projects ADD COLUMN discovery_source TEXT NOT NULL DEFAULT 'manual'",
        "source_tags_json": "ALTER TABLE research_projects ADD COLUMN source_tags_json TEXT NOT NULL DEFAULT '[]'",
        "arxiv_categories_json": "ALTER TABLE research_projects ADD COLUMN arxiv_categories_json TEXT NOT NULL DEFAULT '[]'",
        "automation_json": "ALTER TABLE research_projects ADD COLUMN automation_json TEXT NOT NULL DEFAULT '{}'",
    }
    for column, sql in project_migrations.items():
        if column not in project_columns:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_research_projects_obsidian_note ON research_projects(obsidian_note_id)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS project_paper_recommendations (
          project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
          state TEXT NOT NULL DEFAULT 'pending',
          importance TEXT NOT NULL DEFAULT '',
          relation_type TEXT NOT NULL DEFAULT 'indirect',
          reason TEXT NOT NULL DEFAULT '',
          obsidian_path TEXT NOT NULL DEFAULT '',
          attachment_path TEXT NOT NULL DEFAULT '',
          source_judgment_hash TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          synced_at TEXT,
          PRIMARY KEY(project_id, paper_id)
        )
        """
    )
    rec_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(project_paper_recommendations)").fetchall()
    }
    rec_migrations = {
        "importance": "ALTER TABLE project_paper_recommendations ADD COLUMN importance TEXT NOT NULL DEFAULT ''",
        "relation_type": "ALTER TABLE project_paper_recommendations ADD COLUMN relation_type TEXT NOT NULL DEFAULT 'indirect'",
        "reason": "ALTER TABLE project_paper_recommendations ADD COLUMN reason TEXT NOT NULL DEFAULT ''",
        "obsidian_path": "ALTER TABLE project_paper_recommendations ADD COLUMN obsidian_path TEXT NOT NULL DEFAULT ''",
        "attachment_path": "ALTER TABLE project_paper_recommendations ADD COLUMN attachment_path TEXT NOT NULL DEFAULT ''",
        "source_judgment_hash": "ALTER TABLE project_paper_recommendations ADD COLUMN source_judgment_hash TEXT NOT NULL DEFAULT ''",
        "synced_at": "ALTER TABLE project_paper_recommendations ADD COLUMN synced_at TEXT",
    }
    for column, sql in rec_migrations.items():
        if column not in rec_columns:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_paper_recommendations_state ON project_paper_recommendations(state, updated_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_paper_recommendations_paper ON project_paper_recommendations(paper_id)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS paper_reading_reports (
          paper_id INTEGER PRIMARY KEY REFERENCES arxiv_papers(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'queued',
          prompt TEXT NOT NULL DEFAULT '',
          system_prompt TEXT NOT NULL DEFAULT '',
          model_provider_id TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          source_text_hash TEXT NOT NULL DEFAULT '',
          source_project_ids_json TEXT NOT NULL DEFAULT '[]',
          report_markdown TEXT NOT NULL DEFAULT '',
          error_message TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        )
        """
    )
    report_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(paper_reading_reports)").fetchall()
    }
    report_migrations = {
        "prompt": "ALTER TABLE paper_reading_reports ADD COLUMN prompt TEXT NOT NULL DEFAULT ''",
        "system_prompt": "ALTER TABLE paper_reading_reports ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''",
        "model_provider_id": "ALTER TABLE paper_reading_reports ADD COLUMN model_provider_id TEXT NOT NULL DEFAULT ''",
        "model": "ALTER TABLE paper_reading_reports ADD COLUMN model TEXT NOT NULL DEFAULT ''",
        "source_text_hash": "ALTER TABLE paper_reading_reports ADD COLUMN source_text_hash TEXT NOT NULL DEFAULT ''",
        "source_project_ids_json": "ALTER TABLE paper_reading_reports ADD COLUMN source_project_ids_json TEXT NOT NULL DEFAULT '[]'",
        "report_markdown": "ALTER TABLE paper_reading_reports ADD COLUMN report_markdown TEXT NOT NULL DEFAULT ''",
        "error_message": "ALTER TABLE paper_reading_reports ADD COLUMN error_message TEXT NOT NULL DEFAULT ''",
        "started_at": "ALTER TABLE paper_reading_reports ADD COLUMN started_at TEXT",
        "finished_at": "ALTER TABLE paper_reading_reports ADD COLUMN finished_at TEXT",
    }
    for column, sql in report_migrations.items():
        if column not in report_columns:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_paper_reading_reports_status ON paper_reading_reports(status, updated_at DESC)"
    )
    conn.execute("DROP TABLE IF EXISTS llm_explanations")


def update_job_meta(
    conn: sqlite3.Connection,
    job_id: int,
    message: str,
    meta: dict[str, Any],
) -> None:
    conn.execute(
        """
        UPDATE job_runs
        SET message = ?, meta_json = ?
        WHERE id = ?
        """,
        (message, to_json(meta), job_id),
    )
    conn.commit()


@contextmanager
def job_run(conn: sqlite3.Connection, job_type: str) -> Iterator[int]:
    started = utc_now()
    cur = conn.execute(
        "INSERT INTO job_runs(job_type, status, started_at) VALUES (?, 'running', ?)",
        (job_type, started),
    )
    job_id = int(cur.lastrowid)
    conn.commit()
    try:
        yield job_id
    except Exception as exc:
        conn.execute(
            """
            UPDATE job_runs
            SET status = 'failed', finished_at = ?, message = ?
            WHERE id = ?
            """,
            (utc_now(), str(exc), job_id),
        )
        conn.commit()
        raise
    else:
        conn.execute(
            """
            UPDATE job_runs
            SET status = 'completed', finished_at = ?
            WHERE id = ?
            """,
            (utc_now(), job_id),
        )
        conn.commit()
