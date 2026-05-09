from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

SQLITE_BUSY_TIMEOUT_MS = 30_000
JOB_STALE_AFTER_SECONDS = 30 * 60
LEGACY_JOB_STALE_AFTER_SECONDS = 15 * 60


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
  pid INTEGER,
  heartbeat_at TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS daily_run_meta (
  job_id INTEGER PRIMARY KEY REFERENCES job_runs(id) ON DELETE CASCADE,
  source_job_id INTEGER REFERENCES job_runs(id) ON DELETE SET NULL,
  arxiv_batch_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'run-daily',
  settings_hash TEXT NOT NULL DEFAULT '',
  searchers_json TEXT NOT NULL DEFAULT '[]',
  embedding_model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_run_steps (
  job_id INTEGER NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  finished_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(job_id, step_key)
);

CREATE TABLE IF NOT EXISTS daily_run_papers (
  job_id INTEGER NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES arxiv_papers(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'new_arxiv',
  retry_reason TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  prefilter_score REAL,
  prefilter_rank INTEGER,
  prefilter_passed INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 0,
  selection_reason TEXT NOT NULL DEFAULT '',
  text_status TEXT NOT NULL DEFAULT 'pending',
  embedding_status TEXT NOT NULL DEFAULT 'pending',
  global_match_status TEXT NOT NULL DEFAULT 'pending',
  project_match_status TEXT NOT NULL DEFAULT 'pending',
  judgment_status TEXT NOT NULL DEFAULT 'pending',
  recommendation_status TEXT NOT NULL DEFAULT 'pending',
  report_status TEXT NOT NULL DEFAULT 'pending',
  archive_status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id, paper_id)
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
CREATE INDEX IF NOT EXISTS idx_daily_run_meta_mode ON daily_run_meta(mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_run_steps_status ON daily_run_steps(job_id, status);
CREATE INDEX IF NOT EXISTS idx_daily_run_papers_selected ON daily_run_papers(job_id, selected, prefilter_rank);
CREATE INDEX IF NOT EXISTS idx_daily_run_papers_stage ON daily_run_papers(job_id, text_status, global_match_status, project_match_status);
CREATE INDEX IF NOT EXISTS idx_daily_run_papers_paper ON daily_run_papers(paper_id);
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

REQUIRED_TABLES = {
    "obsidian_notes",
    "research_chunks",
    "chunk_embeddings",
    "arxiv_papers",
    "arxiv_paper_tombstones",
    "arxiv_text_chunks",
    "arxiv_chunk_embeddings",
    "arxiv_paper_embeddings",
    "paper_prefilter_runs",
    "matches",
    "user_feedback",
    "job_runs",
    "daily_run_meta",
    "daily_run_steps",
    "daily_run_papers",
    "app_settings",
    "research_projects",
    "project_papers",
    "project_paper_matches",
    "project_paper_judgments",
    "project_paper_recommendations",
    "paper_reading_reports",
    "project_notes",
    "project_artifacts",
}

REQUIRED_INDEXES = {
    "idx_research_chunks_note",
    "idx_arxiv_papers_published",
    "idx_arxiv_paper_tombstones_reason",
    "idx_arxiv_text_chunks_paper",
    "idx_paper_prefilter_runs_paper",
    "idx_matches_paper_score",
    "idx_daily_run_meta_mode",
    "idx_daily_run_steps_status",
    "idx_daily_run_papers_selected",
    "idx_daily_run_papers_stage",
    "idx_daily_run_papers_paper",
    "idx_research_projects_status",
    "idx_research_projects_obsidian_note",
    "idx_project_paper_matches_project_score",
    "idx_project_paper_matches_paper",
    "idx_project_paper_judgments_project_action",
    "idx_project_paper_judgments_paper",
    "idx_project_paper_recommendations_state",
    "idx_project_paper_recommendations_paper",
    "idx_paper_reading_reports_status",
    "idx_project_artifacts_project",
}

REQUIRED_COLUMNS = {
    "arxiv_papers": {
        "pdf_path",
        "text_path",
        "text_extracted_at",
        "text_status",
        "text_error",
        "text_char_count",
    },
    "matches": {"arxiv_chunk_id"},
    "project_paper_matches": {"rank_score", "quality_score"},
    "research_projects": {
        "obsidian_project_path",
        "obsidian_output_dir",
        "obsidian_note_id",
        "obsidian_folder",
        "obsidian_status_tag",
        "discovery_source",
        "source_tags_json",
        "arxiv_categories_json",
        "automation_json",
    },
    "project_paper_recommendations": {
        "importance",
        "relation_type",
        "reason",
        "obsidian_path",
        "attachment_path",
        "source_judgment_hash",
        "synced_at",
    },
    "paper_reading_reports": {
        "prompt",
        "system_prompt",
        "model_provider_id",
        "model",
        "source_text_hash",
        "source_project_ids_json",
        "report_markdown",
        "error_message",
        "started_at",
        "finished_at",
    },
    "job_runs": {
        "pid",
        "heartbeat_at",
    },
    "daily_run_meta": {
        "source_job_id",
        "arxiv_batch_id",
        "mode",
        "settings_hash",
        "searchers_json",
        "embedding_model",
        "created_at",
    },
    "daily_run_steps": {
        "status",
        "started_at",
        "finished_at",
        "error",
        "meta_json",
    },
    "daily_run_papers": {
        "source",
        "retry_reason",
        "published_at",
        "prefilter_score",
        "prefilter_rank",
        "prefilter_passed",
        "selected",
        "selection_reason",
        "text_status",
        "embedding_status",
        "global_match_status",
        "project_match_status",
        "judgment_status",
        "recommendation_status",
        "report_status",
        "archive_status",
        "error",
        "updated_at",
    },
}

OBSOLETE_TABLES = {"llm_explanations"}


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
    conn = sqlite3.connect(db_path, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys = ON")
    _enable_wal_if_possible(conn, db_path)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    if _schema_current(conn):
        return
    conn.executescript(SCHEMA)
    _migrate_db(conn)
    conn.commit()


def _enable_wal_if_possible(conn: sqlite3.Connection, db_path: Path) -> None:
    if str(db_path) == ":memory:":
        return
    try:
        mode_row = conn.execute("PRAGMA journal_mode").fetchone()
        mode = str(mode_row[0] if mode_row else "").lower()
        if mode != "wal":
            conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.OperationalError as exc:
        if "locked" not in str(exc).lower():
            raise


def _sqlite_names(conn: sqlite3.Connection, object_type: str) -> set[str]:
    return {
        str(row["name"])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = ?",
            (object_type,),
        ).fetchall()
    }


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {
        str(row["name"])
        for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }


def _schema_current(conn: sqlite3.Connection) -> bool:
    tables = _sqlite_names(conn, "table")
    if not REQUIRED_TABLES.issubset(tables):
        return False
    if OBSOLETE_TABLES.intersection(tables):
        return False
    indexes = _sqlite_names(conn, "index")
    if not REQUIRED_INDEXES.issubset(indexes):
        return False
    for table, required_columns in REQUIRED_COLUMNS.items():
        if not required_columns.issubset(_table_columns(conn, table)):
            return False
    return True


def _migrate_db(conn: sqlite3.Connection) -> None:
    job_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(job_runs)").fetchall()
    }
    job_migrations = {
        "pid": "ALTER TABLE job_runs ADD COLUMN pid INTEGER",
        "heartbeat_at": "ALTER TABLE job_runs ADD COLUMN heartbeat_at TEXT",
    }
    for column, sql in job_migrations.items():
        if column not in job_columns:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as exc:
                if "duplicate column name" not in str(exc).lower():
                    raise

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
        SET message = ?, meta_json = ?, heartbeat_at = ?
        WHERE id = ?
        """,
        (message, to_json(meta), utc_now(), job_id),
    )
    conn.commit()


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return True
        output = result.stdout.strip()
        return str(pid) in output and "No tasks" not in output and "INFO:" not in output
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def mark_stale_job_runs(
    conn: sqlite3.Connection,
    stale_after_seconds: int = JOB_STALE_AFTER_SECONDS,
    legacy_stale_after_seconds: int = LEGACY_JOB_STALE_AFTER_SECONDS,
) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    now_text = now.isoformat(timespec="seconds")
    rows = conn.execute(
        """
        SELECT id, job_type, started_at, message, pid, heartbeat_at, meta_json
        FROM job_runs
        WHERE status = 'running'
        ORDER BY id
        """
    ).fetchall()
    marked = 0
    for row in rows:
        pid = int(row["pid"] or 0)
        started = _parse_timestamp(row["started_at"])
        reason = ""
        if pid:
            if not _process_is_alive(pid):
                reason = f"process {pid} is no longer running"
        elif started and now - started > timedelta(seconds=legacy_stale_after_seconds):
            reason = f"legacy running job older than {legacy_stale_after_seconds} seconds"
        if not reason:
            continue
        meta = from_json(row["meta_json"], {})
        if not isinstance(meta, dict):
            meta = {}
        meta["stale"] = {
            "marked_at": now_text,
            "reason": reason,
        }
        previous_message = str(row["message"] or "").strip()
        message = f"Marked stale: {reason}"
        if previous_message:
            message = f"{message}; previous message: {previous_message[:500]}"
        conn.execute(
            """
            UPDATE job_runs
            SET status = 'failed',
                finished_at = ?,
                message = ?,
                heartbeat_at = ?,
                meta_json = ?
            WHERE id = ? AND status = 'running'
            """,
            (now_text, message, now_text, to_json(meta), int(row["id"])),
        )
        marked += 1
    if marked:
        conn.commit()
    return {"stale_jobs_checked": len(rows), "stale_jobs_marked": marked}


@contextmanager
def job_run(conn: sqlite3.Connection, job_type: str) -> Iterator[int]:
    started = utc_now()
    cur = conn.execute(
        """
        INSERT INTO job_runs(job_type, status, started_at, pid, heartbeat_at)
        VALUES (?, 'running', ?, ?, ?)
        """,
        (job_type, started, os.getpid(), started),
    )
    job_id = int(cur.lastrowid)
    conn.commit()
    try:
        yield job_id
    except Exception as exc:
        conn.execute(
            """
            UPDATE job_runs
            SET status = 'failed', finished_at = ?, message = ?, heartbeat_at = ?
            WHERE id = ?
            """,
            (utc_now(), str(exc), utc_now(), job_id),
        )
        conn.commit()
        raise
    else:
        conn.execute(
            """
            UPDATE job_runs
            SET status = 'completed', finished_at = ?, heartbeat_at = ?
            WHERE id = ?
            """,
            (utc_now(), utc_now(), job_id),
        )
        conn.commit()
