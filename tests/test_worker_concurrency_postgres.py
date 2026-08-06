from __future__ import annotations

import os
import json
import socket
import subprocess
import sys
import threading
import tempfile
import time
import unittest
import urllib.request
import statistics
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from helpers import connect_test_db, connect_test_db_peer, reset_test_db
from worker.db import init_db
from worker.db import to_json
from worker.db import utc_now
from worker.queue import claim_next_worker_job, cleanup_stale_worker_jobs, enqueue_worker_job
from worker.resource_limiter import outbound_request_slot


class WorkerConcurrencyPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.conn = connect_test_db()
        cls.database_url = cls.conn.database_url
        cls.schema = cls.conn.test_schema

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()

    def setUp(self) -> None:
        reset_test_db(self.conn)

    def connection(self):
        return connect_test_db_peer(self.conn)

    def enqueue(self, job_type: str, payload: dict, *, now: str = "2026-08-05T10:00:00+00:00") -> int:
        return int(enqueue_worker_job(self.conn, job_type, payload, now=now, commit=True)["id"])

    def test_two_workers_claim_distinct_jobs_without_duplicates(self) -> None:
        ids = {
            self.enqueue("reader-import-url", {"body": {"url": "https://a.test"}}),
            self.enqueue("reader-import-url", {"body": {"url": "https://b.test"}}),
        }
        barrier = threading.Barrier(2)
        claimed: list[int] = []

        def run(worker: str) -> None:
            conn = self.connection()
            try:
                barrier.wait()
                for _ in range(20):
                    result = claim_next_worker_job(conn, worker, now="2026-08-05T10:01:00+00:00")
                    if result:
                        claimed.append(int(result["worker_job"]["id"]))
                        break
                    time.sleep(0.01)
            finally:
                conn.close()

        threads = [threading.Thread(target=run, args=(f"worker-{index}",)) for index in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(set(claimed), ids)

    def test_daily_running_manual_start_benchmark_with_real_services(self) -> None:
        def rss_mib(pid: int) -> float:
            if os.name == "nt":
                import ctypes
                from ctypes import wintypes
                class Counters(ctypes.Structure):
                    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
                handle = ctypes.windll.kernel32.OpenProcess(0x1000 | 0x0400, False, pid)
                counters = Counters(); counters.cb = ctypes.sizeof(counters)
                try:
                    if not ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                        raise OSError("GetProcessMemoryInfo failed")
                    return round(counters.WorkingSetSize / 1024 / 1024, 1)
                finally:
                    ctypes.windll.kernel32.CloseHandle(handle)
            pages = int(open(f"/proc/{pid}/statm", encoding="ascii").read().split()[1])
            return round(pages * os.sysconf("SC_PAGE_SIZE") / 1024 / 1024, 1)

        self.conn.execute("""
            CREATE OR REPLACE FUNCTION benchmark_daily_handler_delay() RETURNS trigger AS $$
            BEGIN
              IF NEW.job_type IN ('run-daily', 'resume-daily', 'retry-daily')
                 AND jsonb_exists(NEW.meta_json::jsonb, 'daily_mode')
                 AND NOT jsonb_exists(OLD.meta_json::jsonb, 'daily_mode') THEN
                PERFORM pg_advisory_xact_lock(724099, 1);
                PERFORM pg_sleep(3.0);
                RAISE EXCEPTION 'controlled benchmark daily stop';
              END IF;
              RETURN NEW;
            END; $$ LANGUAGE plpgsql
        """)
        self.conn.execute("DROP TRIGGER IF EXISTS benchmark_daily_handler_delay_trigger ON job_runs")
        self.conn.execute("""
            CREATE TRIGGER benchmark_daily_handler_delay_trigger BEFORE UPDATE OF meta_json ON job_runs
            FOR EACH ROW EXECUTE FUNCTION benchmark_daily_handler_delay()
        """)
        self.conn.commit()

        def run_case(replicas: int) -> dict:
            self.setUp()
            app_name = f"kris-stage6-benchmark-{replicas}"
            env = {**os.environ, "DATABASE_URL": self.database_url,
                   "PGOPTIONS": f"-c search_path={self.schema}", "PGAPPNAME": app_name,
                   "KRIS_WORKER_POLL_INTERVAL_MS": "100", "KRIS_WORKER_INIT_DB_ON_START": "false",
                   "KRIS_WORKER_HEARTBEAT_INTERVAL_SECONDS": "1"}
            workers = [subprocess.Popen(
                [sys.executable, "-m", "worker.service"], cwd=os.getcwd(),
                env={**env, "KRIS_WORKER_ID": f"benchmark-{replicas}-{index}"},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ) for index in range(replicas)]
            try:
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    online = int(self.conn.execute(
                        "SELECT COUNT(*) AS count FROM worker_instances WHERE worker_id LIKE ?",
                        (f"benchmark-{replicas}-%",),
                    ).fetchone()["count"])
                    if online == replicas: break
                    time.sleep(0.05)
                self.assertEqual(online, replicas)
                idle_rss = [rss_mib(worker.pid) for worker in workers]
                def peak_connections(duration: float) -> int:
                    peak = 0; sample_deadline = time.monotonic() + duration
                    while time.monotonic() < sample_deadline:
                        peak = max(peak, int(self.conn.execute(
                            "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE application_name = ?", (app_name,),
                        ).fetchone()["count"]))
                        time.sleep(0.005)
                    return peak
                idle_connections = peak_connections(1.2)
                daily_id = self.enqueue("run-daily", {}, now=utc_now())
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    daily = self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (daily_id,)).fetchone()
                    sleeping = int(self.conn.execute(
                        "SELECT COUNT(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 724099 AND objid = 1 AND granted"
                    ).fetchone()["count"])
                    if daily and daily["status"] == "running" and sleeping: break
                    time.sleep(0.02)
                self.assertEqual((daily["status"], sleeping), ("running", 1))
                running_rss = [rss_mib(worker.pid) for worker in workers]
                running_connections = peak_connections(1.2)
                connection_sample_stop = threading.Event()
                connection_peak = {"value": 0}
                def sample_active_connections() -> None:
                    sample_conn = self.connection()
                    try:
                        while not connection_sample_stop.is_set():
                            count = int(sample_conn.execute(
                                "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE application_name = ?", (app_name,),
                            ).fetchone()["count"])
                            connection_peak["value"] = max(connection_peak["value"], count)
                            time.sleep(0.001)
                    finally:
                        sample_conn.close()
                connection_sampler = threading.Thread(target=sample_active_connections)
                connection_sampler.start()
                manual_ids = {
                    "reader-import-url": self.enqueue("reader-import-url", {"body": {"urls": []}}, now=utc_now()),
                    "paper-report": self.enqueue("paper-report", {"paper_id": 999999}, now=utc_now()),
                    "artifact-index": self.enqueue("artifact-index", {"artifact_id": 999999}, now=utc_now()),
                }
                deadline = time.monotonic() + 15
                rows = []
                while time.monotonic() < deadline:
                    rows = self.conn.execute(
                        "SELECT id, created_at, started_at, finished_at, attempts FROM worker_jobs WHERE id = ANY(?) ORDER BY id",
                        (list(manual_ids.values()),),
                    ).fetchall()
                    if len(rows) == 3 and all(row["finished_at"] for row in rows): break
                    time.sleep(0.05)
                self.assertEqual(len(rows), 3)
                self.assertTrue(all(row["finished_at"] for row in rows))
                connection_sample_stop.set(); connection_sampler.join(timeout=5)
                self.assertFalse(connection_sampler.is_alive())
                parse = lambda value: datetime.fromisoformat(str(value).replace("Z", "+00:00"))
                waits = [(parse(row["started_at"]) - parse(row["created_at"])).total_seconds() * 1000 for row in rows]
                durations = [(parse(row["finished_at"]) - parse(row["started_at"])).total_seconds() * 1000 for row in rows]
                waits_by_type = {job_type: waits[index] for index, job_type in enumerate(manual_ids)}
                return {"replicas": replicas, "queue_wait_ms": waits,
                        "queue_wait_by_type_ms": waits_by_type,
                        "queue_wait_p50_ms": round(statistics.median(waits), 1), "queue_wait_p95_ms": round(max(waits), 1),
                        "handler_p50_ms": round(statistics.median(durations), 1), "handler_p95_ms": round(max(durations), 1),
                        "idle_rss_mib": idle_rss, "running_rss_mib": running_rss,
                        "idle_rss_total_mib": round(sum(idle_rss), 1), "running_rss_total_mib": round(sum(running_rss), 1),
                        "postgres_idle_connections": idle_connections, "postgres_running_connections": running_connections,
                        "postgres_daily_manual_peak_connections": connection_peak["value"],
                        "retried_jobs": sum(int(row["attempts"]) > 1 for row in rows)}
            finally:
                for worker in workers:
                    if worker.poll() is None: worker.kill()
                for worker in workers:
                    worker.wait(timeout=10)
                if "connection_sample_stop" in locals(): connection_sample_stop.set()
                if "connection_sampler" in locals(): connection_sampler.join(timeout=5)

        try:
            samples = [run_case(1), run_case(2)]
            print("STAGE6_BENCHMARK " + json.dumps(samples, sort_keys=True))
            self.assertGreater(samples[0]["queue_wait_p50_ms"], samples[1]["queue_wait_p50_ms"] + 800)
            self.assertLess(samples[1]["running_rss_total_mib"], 128)
            self.assertLessEqual(samples[1]["postgres_running_connections"], 3)
        finally:
            self.conn.execute("DROP TRIGGER IF EXISTS benchmark_daily_handler_delay_trigger ON job_runs")
            self.conn.execute("DROP FUNCTION IF EXISTS benchmark_daily_handler_delay()")
            self.conn.commit()

    def test_concurrent_reader_url_enqueue_deduplicates_canonical_url_set(self) -> None:
        barrier = threading.Barrier(2)
        results: list[dict] = []
        payloads = [
            {"body": {"urls": ["HTTPS://Example.test:443/paper?b=2&a=1#part", "https://b.test/x"]}},
            {"body": {"urls": ["https://b.test/x", "https://example.test/paper?a=1&b=2"]}},
        ]

        def run(payload: dict) -> None:
            conn = self.connection()
            try:
                barrier.wait()
                results.append(enqueue_worker_job(conn, "reader-import-url", payload, commit=True))
            finally:
                conn.close()

        threads = [threading.Thread(target=run, args=(payload,)) for payload in payloads]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(len(results), 2)
        self.assertEqual(len({int(item["id"]) for item in results}), 1)
        self.assertEqual(sorted(bool(item["deduplicated"]) for item in results), [False, True])
        self.assertEqual(
            int(self.conn.execute("SELECT COUNT(*) AS count FROM worker_jobs WHERE job_type = 'reader-import-url'").fetchone()["count"]),
            1,
        )
        self.assertEqual(
            int(self.conn.execute("SELECT COUNT(*) AS count FROM app_events WHERE event_type = 'task.started'").fetchone()["count"]),
            1,
        )

    def test_group_limits_key_mutex_and_independent_groups(self) -> None:
        self.enqueue("run-daily", {})
        self.enqueue("resume-daily", {})
        daily = claim_next_worker_job(self.conn, "daily-a", now="2026-08-05T10:01:00+00:00")
        self.assertEqual(daily["worker_job"]["concurrency_group"], "daily")
        other = self.connection()
        try:
            self.assertIsNone(claim_next_worker_job(other, "daily-b", now="2026-08-05T10:01:01+00:00"))
            self.enqueue("reader-import-url", {"body": {"url": "https://parallel.test"}})
            imported = claim_next_worker_job(other, "import", now="2026-08-05T10:01:02+00:00")
            self.assertEqual(imported["worker_job"]["job_type"], "reader-import-url")
        finally:
            other.close()

        self.setUp()
        self.enqueue("artifact-index", {"artifact_id": 1})
        self.enqueue("artifact-index", {"artifact_id": 1})
        self.enqueue("artifact-index", {"artifact_id": 2})
        first = claim_next_worker_job(self.conn, "artifact-a", now="2026-08-05T10:01:00+00:00")
        other = self.connection()
        try:
            second = claim_next_worker_job(other, "artifact-b", now="2026-08-05T10:01:01+00:00")
            self.assertEqual({first["worker_job"]["concurrency_key"], second["worker_job"]["concurrency_key"]}, {"artifact:1", "artifact:2"})
        finally:
            other.close()

        self.setUp()
        self.enqueue("paper-report", {"paper_id": 40})
        self.enqueue("paper-report", {"paper_id": 40})
        self.enqueue("paper-report", {"paper_id": 41})
        first = claim_next_worker_job(self.conn, "report-a", now="2026-08-05T10:01:00+00:00")
        other = self.connection()
        try:
            second = claim_next_worker_job(other, "report-b", now="2026-08-05T10:01:01+00:00")
            self.assertEqual(
                {first["worker_job"]["concurrency_key"], second["worker_job"]["concurrency_key"]},
                {"paper:40:report", "paper:41:report"},
            )
        finally:
            other.close()

        self.setUp()
        left = self.enqueue("artifact-index", {"artifact_id": 30})
        right = self.enqueue("library-paper-index", {"paper_id": 31})
        self.conn.execute("UPDATE worker_jobs SET concurrency_key = 'shared:mutex' WHERE id IN (?, ?)", (left, right))
        self.conn.commit()
        claim_next_worker_job(self.conn, "key-a", now="2026-08-05T10:01:00+00:00")
        other = self.connection()
        try:
            self.assertIsNone(claim_next_worker_job(other, "key-b", now="2026-08-05T10:01:01+00:00"))
        finally:
            other.close()

    def test_obsidian_serialization_aging_and_more_than_one_page_of_blocked_jobs(self) -> None:
        self.enqueue("sync-obsidian", {})
        self.enqueue("artifact-export-obsidian", {"destination_path": "C:/Vault/a.md", "artifact_id": 1})
        claim_next_worker_job(self.conn, "obsidian-a", now="2026-08-05T10:01:00+00:00")
        other = self.connection()
        try:
            self.assertIsNone(claim_next_worker_job(other, "obsidian-b", now="2026-08-05T10:01:01+00:00"))
        finally:
            other.close()

        self.setUp()
        old = self.enqueue("artifact-index-backfill", {}, now="2026-08-05T06:00:00+00:00")
        self.enqueue("reader-import-url", {"body": {"url": "https://new.test"}}, now="2026-08-05T10:00:00+00:00")
        aged = claim_next_worker_job(self.conn, "aging", now="2026-08-05T10:01:00+00:00")
        self.assertEqual(int(aged["worker_job"]["id"]), old)

        self.setUp()
        self.enqueue("run-daily", {})
        claim_next_worker_job(self.conn, "daily-running", now="2026-08-05T10:01:00+00:00")
        for _ in range(120):
            job_id = self.enqueue("resume-daily", {})
            self.conn.execute("UPDATE worker_jobs SET priority = 100 WHERE id = ?", (job_id,))
        self.conn.commit()
        target = self.enqueue("reader-import-url", {"body": {"url": "https://after-page.test"}})
        other = self.connection()
        try:
            claimed = claim_next_worker_job(other, "page-scan", now="2026-08-05T10:02:00+00:00")
            self.assertEqual(int(claimed["worker_job"]["id"]), target)
        finally:
            other.close()

    def test_postgres_global_slots_cap_threads_and_release_after_process_kill(self) -> None:
        active = 0
        maximum = 0
        gate = threading.Lock()

        def request() -> None:
            nonlocal active, maximum
            with outbound_request_slot("embedding", 2):
                with gate:
                    active += 1
                    maximum = max(maximum, active)
                time.sleep(0.08)
                with gate:
                    active -= 1

        with patch.dict(os.environ, {"DATABASE_URL": self.database_url, "KRIS_RESOURCE_LIMITER_BACKEND": "postgres"}):
            threads = [threading.Thread(target=request) for _ in range(6)]
            for thread in threads: thread.start()
            for thread in threads: thread.join()
            self.assertEqual(maximum, 2)

            code = (
                "import os,time; from worker.resource_limiter import outbound_request_slot; "
                "ctx=outbound_request_slot('llm',1); ctx.__enter__(); print('READY',flush=True); time.sleep(60)"
            )
            child_env = {**os.environ, "DATABASE_URL": self.database_url, "KRIS_RESOURCE_LIMITER_BACKEND": "postgres"}
            child = subprocess.Popen([sys.executable, "-c", code], cwd=os.getcwd(), env=child_env, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), "READY")
                child.kill()
                child.wait(timeout=10)
                child.stdout.close()
                started = time.monotonic()
                with outbound_request_slot("llm", 1):
                    pass
                self.assertLess(time.monotonic() - started, 2)
            finally:
                if child.poll() is None:
                    child.kill()

    def test_killed_running_worker_requeues_and_second_worker_completes(self) -> None:
        first_request = threading.Event()
        release_request = threading.Event()

        class BlockingPdfHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                first_request.set()
                release_request.wait(timeout=10)
                body = b"%PDF-1.4\n" + b"0" * 1500
                try:
                    self.send_response(200); self.send_header("content-type", "application/pdf")
                    self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass
            def log_message(self, _format: str, *_args: object) -> None: return

        provider = ThreadingHTTPServer(("127.0.0.1", 0), BlockingPdfHandler)
        self.addCleanup(provider.server_close); self.addCleanup(provider.shutdown)
        threading.Thread(target=provider.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as temp_dir:
            env = {**os.environ, "DATABASE_URL": self.database_url,
                   "PGOPTIONS": f"-c search_path={self.schema}", "KRIS_WORKER_INIT_DB_ON_START": "false",
                   "KRIS_WORKER_POLL_INTERVAL_MS": "100", "ARXIV_PDF_DIR": os.path.join(temp_dir, "pdf"),
                   "ARXIV_TEXT_DIR": os.path.join(temp_dir, "text")}
            job_id = self.enqueue("reader-import-url", {
                "body": {"urls": [f"http://127.0.0.1:{provider.server_port}/crash.pdf"]}
            }, now=utc_now())
            worker_a = subprocess.Popen(
                [sys.executable, "-m", "worker.service"], cwd=os.getcwd(),
                env={**env, "KRIS_WORKER_ID": "crash-worker-a"},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            worker_b = None
            try:
                self.assertTrue(first_request.wait(timeout=10))
                running = self.conn.execute("SELECT status, attempts FROM worker_jobs WHERE id = ?", (job_id,)).fetchone()
                self.assertEqual((running["status"], int(running["attempts"])), ("running", 1))
                worker_a.kill(); worker_a.wait(timeout=10)
                future = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(timespec="milliseconds")
                recovered = cleanup_stale_worker_jobs(self.conn, stale_after_seconds=1, now=future)
                self.assertEqual(recovered["stale_worker_jobs_requeued"], 1)
                queued = self.conn.execute("SELECT status, locked_by, locked_at FROM worker_jobs WHERE id = ?", (job_id,)).fetchone()
                self.assertEqual((queued["status"], queued["locked_by"], queued["locked_at"]), ("queued", "", None))
                release_request.set()
                worker_b = subprocess.Popen(
                    [sys.executable, "-m", "worker.service"], cwd=os.getcwd(),
                    env={**env, "KRIS_WORKER_ID": "crash-worker-b"},
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    terminal = self.conn.execute("SELECT status, attempts FROM worker_jobs WHERE id = ?", (job_id,)).fetchone()
                    if terminal["status"] in {"completed", "failed"}: break
                    time.sleep(0.05)
                self.assertEqual((terminal["status"], int(terminal["attempts"])), ("completed", 2))
                events = self.conn.execute(
                    "SELECT event_type, payload_json FROM app_events WHERE (payload_json::jsonb #>> '{task,worker_job_id}')::bigint = ? ORDER BY id",
                    (job_id,),
                ).fetchall()
                payloads = [(row["event_type"], json.loads(row["payload_json"])) for row in events]
                statuses = [(event_type, payload["task"]["status"]) for event_type, payload in payloads]
                self.assertEqual(sum(event_type == "task.started" for event_type, _payload in payloads), 4)
                self.assertTrue(any(event_type == "task.started" and payload.get("stale") is True
                                    and payload["task"]["status"] == "queued" for event_type, payload in payloads))
                self.assertIn(("task.finished", "completed"), statuses)
            finally:
                release_request.set()
                for worker in (worker_a, worker_b):
                    if worker and worker.poll() is None: worker.kill()
                for worker in (worker_a, worker_b):
                    if worker: worker.wait(timeout=10)

    def test_init_rebinds_active_policy_and_terminalizes_unknown_legacy_job(self) -> None:
        self.conn.execute(
            "DELETE FROM app_settings WHERE key = 'schema_migration.worker_ownership_stage7'"
        )
        known = self.enqueue("paper-report", {"paper_id": 77})
        self.conn.execute(
            "UPDATE worker_jobs SET concurrency_group = 'wrong', concurrency_key = '', policy_version = 0 WHERE id = ?",
            (known,),
        )
        now = "2026-08-05T10:00:00+00:00"
        run_id = int(self.conn.execute(
            """INSERT INTO job_runs(job_type, status, started_at, heartbeat_at, meta_json)
               VALUES ('generate-paper-reports', 'running', ?, ?, '{}') RETURNING id""",
            (now, now),
        ).fetchone()["id"])
        legacy = int(self.conn.execute(
            """INSERT INTO worker_jobs(job_run_id, job_type, status, payload_json, locked_by, locked_at,
                   created_at, updated_at) VALUES (?, 'generate-paper-reports', 'running', ?, 'dead-worker', ?, ?, ?)
               RETURNING id""",
            (run_id, to_json({"command": "generate-paper-reports"}), now, now, now),
        ).fetchone()["id"])
        paper_id = int(self.conn.execute(
            """INSERT INTO papers(canonical_key, title, created_at, updated_at)
               VALUES ('stage7:migration', 'Stage 7 migration paper', ?, ?) RETURNING id""",
            (now, now),
        ).fetchone()["id"])
        self.conn.execute(
            """INSERT INTO artifacts(scope_type, scope_id, artifact_type, title, content_markdown,
                   content_json, status, source_json, created_at, updated_at)
               VALUES ('paper', ?, 'paper_report', 'Queued report', '', ?, 'queued', '{}', ?, ?)""",
            (paper_id, to_json({"prompt": "Preserve this prompt"}), now, now),
        )
        self.conn.commit()

        init_db(self.conn)
        rebound = self.conn.execute(
            "SELECT concurrency_group, concurrency_key, policy_version FROM worker_jobs WHERE id = ?", (known,)
        ).fetchone()
        self.assertEqual((rebound["concurrency_group"], rebound["concurrency_key"], int(rebound["policy_version"])),
                         ("paper-report", "paper:77:report", 1))
        cancelled = self.conn.execute(
            "SELECT status, locked_by, locked_at FROM worker_jobs WHERE id = ?", (legacy,)
        ).fetchone()
        self.assertEqual((cancelled["status"], cancelled["locked_by"], cancelled["locked_at"]), ("cancelled", "", None))
        self.assertEqual(self.conn.execute("SELECT status FROM job_runs WHERE id = ?", (run_id,)).fetchone()["status"], "cancelled")
        report_jobs = self.conn.execute(
            """SELECT payload_json, concurrency_key FROM worker_jobs
               WHERE job_type = 'paper-report' AND status IN ('queued', 'running')
                 AND payload_json::jsonb ->> 'paper_id' = ?""",
            (str(paper_id),),
        ).fetchall()
        self.assertEqual(len(report_jobs), 1)
        self.assertEqual(report_jobs[0]["concurrency_key"], f"paper:{paper_id}:report")

        event_count_after_first_init = int(
            self.conn.execute("SELECT COUNT(*) AS count FROM app_events").fetchone()["count"]
        )
        init_db(self.conn)
        self.assertEqual(
            self.conn.execute(
                """SELECT COUNT(*) AS count FROM worker_jobs
                   WHERE job_type = 'paper-report' AND status IN ('queued', 'running')
                     AND payload_json::jsonb ->> 'paper_id' = ?""",
                (str(paper_id),),
            ).fetchone()["count"],
            1,
        )
        self.assertEqual(
            int(self.conn.execute("SELECT COUNT(*) AS count FROM app_events").fetchone()["count"]),
            event_count_after_first_init,
        )

    def test_stage7_migration_rolls_back_and_retries_after_failure(self) -> None:
        now = "2026-08-05T11:00:00+00:00"
        self.conn.execute("DELETE FROM app_settings WHERE key = 'schema_migration.worker_ownership_stage7'")
        paper_id = int(self.conn.execute(
            """INSERT INTO papers(canonical_key, title, created_at, updated_at)
               VALUES ('stage7:retry', 'Stage 7 retry paper', ?, ?) RETURNING id""",
            (now, now),
        ).fetchone()["id"])
        self.conn.execute(
            """INSERT INTO artifacts(scope_type, scope_id, artifact_type, title, content_markdown,
                   content_json, status, source_json, created_at, updated_at)
               VALUES ('paper', ?, 'paper_report', 'Retry report', '', '{}', 'queued', '{}', ?, ?)""",
            (paper_id, now, now),
        )
        pump_id = int(self.conn.execute(
            """INSERT INTO worker_jobs(job_type, status, payload_json, created_at, updated_at)
               VALUES ('generate-paper-reports', 'running', '{}', ?, ?) RETURNING id""",
            (now, now),
        ).fetchone()["id"])
        self.conn.commit()

        with patch(
            "worker.paper_reports.ensure_paper_report_worker_job",
            side_effect=RuntimeError("controlled migration failure"),
        ):
            with self.assertRaisesRegex(RuntimeError, "controlled migration failure"):
                init_db(self.conn)

        self.assertEqual(
            self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (pump_id,)).fetchone()["status"],
            "running",
        )
        self.assertIsNone(self.conn.execute(
            "SELECT 1 FROM app_settings WHERE key = 'schema_migration.worker_ownership_stage7'"
        ).fetchone())

        init_db(self.conn)
        self.assertEqual(
            self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (pump_id,)).fetchone()["status"],
            "cancelled",
        )
        self.assertIsNotNone(self.conn.execute(
            "SELECT 1 FROM app_settings WHERE key = 'schema_migration.worker_ownership_stage7'"
        ).fetchone())

    def test_two_real_worker_services_execute_each_job_once(self) -> None:
        env = {
            **os.environ,
            "DATABASE_URL": self.database_url,
            "PGOPTIONS": f"-c search_path={self.schema}",
            "KRIS_WORKER_POLL_INTERVAL_MS": "20",
            "KRIS_WORKER_HEARTBEAT_INTERVAL_SECONDS": "1",
            "KRIS_WORKER_INIT_DB_ON_START": "false",
            "KRIS_RESOURCE_LIMITER_BACKEND": "postgres",
        }
        log_files = [tempfile.TemporaryFile(mode="w+", encoding="utf-8") for _ in range(2)]
        workers = [
            subprocess.Popen([sys.executable, "-m", "worker.service"], cwd=os.getcwd(), env={**env, "KRIS_WORKER_ID": f"pg-test-worker-{index}"},
                             stdout=log_files[index], stderr=log_files[index])
            for index in range(2)
        ]
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                count = int(self.conn.execute(
                    "SELECT COUNT(*) AS count FROM worker_instances WHERE worker_id LIKE ? AND status <> 'stopped'",
                    ("pg-test-worker-%",),
                ).fetchone()["count"])
                if count >= 2:
                    break
                time.sleep(0.05)
            self.assertGreaterEqual(count, 2)
            self.assertTrue(all(worker.poll() is None for worker in workers))
            ids = [self.enqueue("artifact-index", {"artifact_id": 1000 + index}) for index in range(5)]
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                active = int(self.conn.execute(
                    "SELECT COUNT(*) AS count FROM worker_jobs WHERE id = ANY(?) AND status IN ('queued','running')",
                    (ids,),
                ).fetchone()["count"])
                if active == 0:
                    break
                time.sleep(0.05)
            rows = self.conn.execute(
                "SELECT id, attempts, locked_by, status FROM worker_jobs WHERE id = ANY(?) ORDER BY id", (ids,)
            ).fetchall()
            self.assertEqual(len(rows), 5)
            self.assertTrue(all(int(row["attempts"]) == 1 for row in rows))
        finally:
            for worker in workers:
                worker.kill()
            for worker in workers:
                worker.wait(timeout=10)
        logs = []
        for log_file in log_files:
            log_file.seek(0)
            logs.append(log_file.read())
            log_file.close()
        self.assertTrue(all('"event": "worker_job.running"' in content for content in logs), logs)

    def test_node_restart_replays_worker_completion_from_outbox_once(self) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        request_started = threading.Event()
        release_provider = threading.Event()

        class BlockingPdfHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                request_started.set()
                release_provider.wait(timeout=10)
                body = b"%PDF-1.4\n" + b"0" * 1500
                self.send_response(200)
                self.send_header("content-type", "application/pdf")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        provider = ThreadingHTTPServer(("127.0.0.1", 0), BlockingPdfHandler)
        self.addCleanup(provider.server_close)
        self.addCleanup(provider.shutdown)
        provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
        provider_thread.start()
        with tempfile.TemporaryDirectory() as temp_dir:
            base_env = {
                **os.environ,
                "DATABASE_URL": self.database_url,
                "PGOPTIONS": f"-c search_path={self.schema}",
                "PORT": str(port),
                "PANEL_PASSWORD": "",
                "KRIS_UPDATE_CHECK_ENABLED": "false",
                "KRIS_OUTBOX_POLLER_ENABLED": "true",
                "KRIS_OUTBOX_POLL_INTERVAL_MS": "1000",
                "ARXIV_PDF_DIR": os.path.join(temp_dir, "pdf"),
                "ARXIV_TEXT_DIR": os.path.join(temp_dir, "text"),
            }

            def start_node() -> subprocess.Popen:
                process = subprocess.Popen(
                    ["node", "server.js"], cwd=os.getcwd(), env=base_env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        self.fail(f"Node server exited early with code {process.returncode}")
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/jobs/status", timeout=0.3):
                            return process
                    except Exception:
                        time.sleep(0.05)
                process.kill()
                self.fail("Node server did not become ready")

            worker_env = {
                **base_env,
                "KRIS_WORKER_ID": "outbox-restart-worker",
                "KRIS_WORKER_INIT_DB_ON_START": "false",
                "KRIS_WORKER_POLL_INTERVAL_MS": "100",
            }
            worker = subprocess.Popen(
                [sys.executable, "-m", "worker.service"], cwd=os.getcwd(), env=worker_env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            node_a = None
            node_b = None
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    online = self.conn.execute(
                        "SELECT 1 FROM worker_instances WHERE worker_id = 'outbox-restart-worker' AND status <> 'stopped'"
                    ).fetchone()
                    if online:
                        break
                    time.sleep(0.05)
                self.assertIsNotNone(online)
                node_a = start_node()
                pdf_url = f"http://127.0.0.1:{provider.server_port}/blocked.pdf"
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/reader/papers/urls",
                    data=json.dumps({"urls": [pdf_url]}).encode("utf-8"),
                    headers={"content-type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    queued = json.loads(response.read().decode("utf-8"))
                job_id = int(queued["worker_job_id"])
                self.assertTrue(request_started.wait(timeout=10))
                row = self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (job_id,)).fetchone()
                self.assertEqual(row["status"], "running")
                node_a.kill()
                node_a.wait(timeout=10)
                node_a = None
                release_provider.set()
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    row = self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (job_id,)).fetchone()
                    if row and row["status"] == "completed":
                        break
                    time.sleep(0.05)
                self.assertEqual(row["status"], "completed")

                event_row = self.conn.execute(
            """SELECT id FROM app_events
               WHERE event_type = 'task.finished' AND published_at IS NULL
                 AND (payload_json::jsonb #>> '{task,worker_job_id}')::bigint = ?
               ORDER BY id DESC LIMIT 1""",
            (job_id,),
        ).fetchone()
                self.assertIsNotNone(event_row)
                event_id = int(event_row["id"])
                node_b = start_node()
                received: list[dict] = []

                def consume_sse() -> None:
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/events", timeout=5) as stream:
                            event_name = ""
                            while node_b and node_b.poll() is None:
                                line = stream.readline().decode("utf-8").strip()
                                if line.startswith("event:"):
                                    event_name = line.split(":", 1)[1].strip()
                                elif line.startswith("data:"):
                                    payload = json.loads(line.split(":", 1)[1].strip())
                                    event_data = payload.get("data", {})
                                    if event_name == "task.finished" and int(event_data.get("task", {}).get("worker_job_id") or 0) == job_id:
                                        received.append(payload)
                    except Exception:
                        pass

                sse_thread = threading.Thread(target=consume_sse, daemon=True)
                sse_thread.start()
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and len(received) < 1:
                    time.sleep(0.05)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    published = self.conn.execute("SELECT published_at FROM app_events WHERE id = ?", (event_id,)).fetchone()
                    if published["published_at"] is not None:
                        break
                    time.sleep(0.05)
                self.assertIsNotNone(published["published_at"])
                time.sleep(3.2)
                self.assertEqual(len(received), 1)
            finally:
                release_provider.set()
                for process in (node_a, node_b, worker):
                    if process and process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
                if "sse_thread" in locals():
                    sse_thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
