from __future__ import annotations

import argparse
import json
from typing import Any

from .config import load_settings
from .db import connect, from_json
from .db_types import DbConnection


def audit_job_run_mirrors(conn: DbConnection, *, sample_limit: int = 100) -> dict[str, Any]:
    """Read-only, idempotent audit of legacy worker-job mirror rows in job_runs."""
    rows = conn.execute(
        """
        SELECT jr.id AS job_run_id, jr.job_type AS job_run_type, jr.status AS job_run_status,
               jr.meta_json, wj.id AS worker_job_id, wj.job_type AS worker_job_type
        FROM job_runs jr
        LEFT JOIN worker_jobs wj ON wj.job_run_id = jr.id
        ORDER BY jr.id, wj.id
        """
    ).fetchall()
    grouped: dict[int, dict[str, Any]] = {}
    for row in rows:
        job_run_id = int(row["job_run_id"])
        item = grouped.setdefault(
            job_run_id,
            {
                "job_run_id": job_run_id,
                "job_run_type": str(row["job_run_type"] or ""),
                "job_run_status": str(row["job_run_status"] or ""),
                "meta": from_json(row["meta_json"], {}),
                "worker_jobs": [],
            },
        )
        if row["worker_job_id"] is not None:
            item["worker_jobs"].append(
                {
                    "worker_job_id": int(row["worker_job_id"]),
                    "worker_job_type": str(row["worker_job_type"] or ""),
                }
            )

    mirrors = [item for item in grouped.values() if bool((item["meta"] or {}).get("worker_job"))]
    orphans = [item for item in mirrors if not item["worker_jobs"]]
    mismatches = [
        item
        for item in mirrors
        if len(item["worker_jobs"]) > 1
        or any(job["worker_job_type"] != item["job_run_type"] for job in item["worker_jobs"])
    ]

    def samples(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "job_run_id": item["job_run_id"],
                "job_run_type": item["job_run_type"],
                "job_run_status": item["job_run_status"],
                "worker_jobs": item["worker_jobs"],
            }
            for item in items[: max(0, int(sample_limit))]
        ]

    return {
        "read_only": True,
        "deletes_performed": 0,
        "job_runs_scanned": len(grouped),
        "mirror_job_runs": {"count": len(mirrors), "samples": samples(mirrors)},
        "orphan_mirrors": {"count": len(orphans), "samples": samples(orphans)},
        "mismatched_mirrors": {"count": len(mismatches), "samples": samples(mismatches)},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only audit of historical job_runs rows created as worker_jobs mirrors."
    )
    parser.add_argument("--sample-limit", type=int, default=100)
    args = parser.parse_args(argv)
    load_settings()
    conn = connect()
    try:
        result = audit_job_run_mirrors(conn, sample_limit=args.sample_limit)
        conn.rollback()
    finally:
        conn.close()
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
