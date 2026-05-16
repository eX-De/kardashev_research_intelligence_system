from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

from worker.db import clean_unicode, postgres_schema_sql
from worker.pg import IDENTITY_TABLES, TABLE_ORDER


def _load_dotenv(path: Path = Path(".env")) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def _sqlite_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def _sqlite_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"])


def _connect_pg(database_url: str):
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("PostgreSQL migration requires psycopg. Run: pip install -r requirements.txt") from exc
    return psycopg.connect(database_url)


def _reset_public_schema(pg_conn: Any) -> None:
    with pg_conn.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS public CASCADE")
        cur.execute("CREATE SCHEMA public")
    pg_conn.commit()


def _target_has_rows(pg_conn: Any) -> bool:
    with pg_conn.cursor() as cur:
        for table in TABLE_ORDER:
            cur.execute(
                """
                SELECT to_regclass(%s)
                """,
                (f"public.{table}",),
            )
            if not cur.fetchone()[0]:
                continue
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            if int(cur.fetchone()[0] or 0):
                return True
    return False


def _insert_table(sqlite_conn: sqlite3.Connection, pg_conn: Any, table: str, batch_size: int) -> int:
    columns = _sqlite_columns(sqlite_conn, table)
    if not columns:
        return 0
    column_sql = ", ".join(columns)
    placeholders = ", ".join("%s" for _ in columns)
    insert_sql = f"INSERT INTO {table}({column_sql}) VALUES ({placeholders})"
    total = 0
    source = sqlite_conn.execute(f"SELECT {column_sql} FROM {table}")
    with pg_conn.cursor() as cur:
        while True:
            rows = source.fetchmany(batch_size)
            if not rows:
                break
            values = [tuple(clean_unicode(row[column]) for column in columns) for row in rows]
            cur.executemany(insert_sql, values)
            total += len(values)
    pg_conn.commit()
    return total


def _reset_identity_sequences(pg_conn: Any) -> None:
    with pg_conn.cursor() as cur:
        for table in sorted(IDENTITY_TABLES):
            cur.execute(
                f"""
                SELECT setval(
                  pg_get_serial_sequence(%s, 'id'),
                  COALESCE((SELECT MAX(id) FROM {table}), 0) + 1,
                  false
                )
                """,
                (table,),
            )
    pg_conn.commit()


def migrate(args: argparse.Namespace) -> dict[str, int]:
    _load_dotenv()
    sqlite_path = Path(args.sqlite_path)
    if not sqlite_path.exists():
        raise RuntimeError(f"SQLite database does not exist: {sqlite_path}")

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    try:
        source_counts = {table: _sqlite_count(sqlite_conn, table) for table in TABLE_ORDER}
        if args.dry_run:
            return source_counts

        database_url = str(args.database_url or os.environ.get("DATABASE_URL", "")).strip()
        if not database_url:
            raise RuntimeError("Provide --database-url or set DATABASE_URL")

        pg_conn = _connect_pg(database_url)
        try:
            if args.reset_sequences_only:
                _reset_identity_sequences(pg_conn)
                return {}
            if args.reset:
                _reset_public_schema(pg_conn)
            with pg_conn.cursor() as cur:
                cur.execute(postgres_schema_sql())
            pg_conn.commit()
            if not args.reset and _target_has_rows(pg_conn):
                raise RuntimeError("Target PostgreSQL database is not empty. Re-run with --reset to replace it.")

            copied: dict[str, int] = {}
            for table in TABLE_ORDER:
                copied[table] = _insert_table(sqlite_conn, pg_conn, table, args.batch_size)
                print(f"{table}: {copied[table]} rows", flush=True)
            _reset_identity_sequences(pg_conn)

            mismatches = {
                table: source_counts[table]
                for table in TABLE_ORDER
                if copied.get(table, 0) != source_counts[table]
            }
            if mismatches:
                raise RuntimeError(f"Migration row-count mismatch: {mismatches}")
            return copied
        finally:
            pg_conn.close()
    finally:
        sqlite_conn.close()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate Research Intelligence SQLite data to PostgreSQL.")
    parser.add_argument("--sqlite-path", default="data/research_intelligence.sqlite")
    parser.add_argument("--database-url", default="")
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--reset", action="store_true", help="Drop and recreate the target public schema before import.")
    parser.add_argument("--reset-sequences-only", action="store_true", help="Only reset PostgreSQL identity sequences.")
    parser.add_argument("--dry-run", action="store_true", help="Only print source table counts.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        result = migrate(parse_args(argv))
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"ok: {sum(result.values())} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
