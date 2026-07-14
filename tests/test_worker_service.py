from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from worker import service


class WorkerServiceDispatchTests(unittest.TestCase):
    def test_dispatch_generate_paper_reports_parses_limit_payload(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 7,
            "job_run_id": 42,
            "job_type": "generate-paper-reports",
            "payload": {"command": "generate-paper-reports", "args": ["--limit", "1"]},
        }
        with patch("worker.service.run_generate_paper_reports_job", return_value={"ok": True}) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"ok": True})

        run.assert_called_once_with(conn, settings, limit=1, job_id=42)

    def test_dispatch_resume_daily_uses_payload_job_id(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 8,
            "job_run_id": 43,
            "job_type": "resume-daily",
            "payload": {"command": "resume-daily", "job_id": 41},
        }
        with patch("worker.service.run_daily_job", return_value={"ok": True}) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"ok": True})

        run.assert_called_once_with(
            conn,
            settings,
            requested_mode="resume-daily",
            resume=True,
            requested_job_id=41,
            job_id=43,
        )

    def test_dispatch_project_index_uses_payload_project_id(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 10,
            "job_run_id": 45,
            "job_type": "project-index",
            "payload": {"command": "project-index", "project_id": 5, "export_to_obsidian": True},
        }
        with patch("worker.service.generate_project_index", return_value={"project": {"id": 5}}) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"project": {"id": 5}})

        run.assert_called_once_with(conn, settings, 5, worker_job["payload"])

    def test_dispatch_project_context_saves_context_and_returns_detail(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 11,
            "job_run_id": 46,
            "job_type": "project-context",
            "payload": {"command": "project-context", "project_id": 5, "raw_context": "context"},
        }
        with patch("worker.service.save_manual_project_context", return_value={"document_id": 7}) as save_context, \
            patch("worker.service.project_detail", return_value={"project": {"id": 5}}):
            result = service.dispatch_worker_job(conn, settings, worker_job)

        self.assertEqual(result["context_document"], {"document_id": 7})
        save_context.assert_called_once()

    def test_dispatch_artifact_export_uses_payload_body(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 14,
            "job_run_id": 49,
            "job_type": "artifact-export-obsidian",
            "payload": {"command": "artifact-export-obsidian", "artifact_id": 9, "body": {"relative_path": "A.md"}},
        }
        with patch("worker.service.export_artifact", return_value={"ok": True}) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"ok": True})

        run.assert_called_once_with(conn, settings, 9, {"relative_path": "A.md"})

    def test_dispatch_reader_import_upload_uses_payload_body(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 15,
            "job_run_id": 50,
            "job_type": "reader-import-upload",
            "payload": {"command": "reader-import-upload", "body": {"files": []}},
        }
        with patch("worker.service.import_reader_pdfs", return_value={"ok": True}) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"ok": True})

        run.assert_called_once_with(conn, settings, {"files": []})

    def test_dispatch_reader_import_upload_fails_the_job_when_every_file_failed(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 15,
            "job_run_id": 50,
            "job_type": "reader-import-upload",
            "payload": {"command": "reader-import-upload", "body": {"files": []}},
        }
        with patch("worker.service.import_reader_pdfs", return_value={"ok": False, "errors": [{"error": "staged file missing"}]}) as run:
            with self.assertRaisesRegex(RuntimeError, "staged file missing"):
                service.dispatch_worker_job(conn, settings, worker_job)

        run.assert_called_once_with(conn, settings, {"files": []})

    def test_dispatch_paper_report_uses_payload_body(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 16,
            "job_run_id": 51,
            "job_type": "paper-report",
            "payload": {"command": "paper-report", "paper_id": 101, "body": {"force": True}},
        }
        with patch("worker.service.generate_paper_reading_report", return_value={"ok": True}) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"ok": True})

        run.assert_called_once_with(conn, settings, 101, {"force": True})

    def test_run_once_claims_and_completes_a_worker_job(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 9,
            "job_run_id": 44,
            "job_type": "generate-reports",
            "payload": {"command": "generate-reports", "source": "manual", "args": []},
            "started_at": "2026-07-06T10:00:00+00:00",
            "finished_at": None,
        }
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.insert_app_event") as insert_event, \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value={"message": "done"}), \
            patch("worker.service.complete_worker_job", return_value={"worker_job": {**worker_job, "status": "completed"}, "job_run": {}}):
            result = service.run_once("worker-test")

        self.assertTrue(result["claimed"])
        self.assertEqual(insert_event.call_args_list[0].args[1], "task.started")
        self.assertEqual(insert_event.call_args_list[1].args[1], "task.finished")
        started_payload = insert_event.call_args_list[0].args[2]
        self.assertEqual(started_payload["task"]["id"], 44)
        self.assertEqual(started_payload["task"]["worker_job_id"], 9)
        self.assertNotIn("job_id", started_payload["task"])
        finished_payload = insert_event.call_args_list[1].args[2]
        self.assertEqual(finished_payload["task"]["id"], 44)
        self.assertEqual(finished_payload["task"]["worker_job_id"], 9)
        self.assertEqual(finished_payload["task"]["result"], {"message": "done"})
        conn.close.assert_called_once_with()

    def test_run_once_loads_dotenv_before_connecting(self) -> None:
        order: list[str] = []
        conn = Mock()

        def load_settings():
            order.append("load_settings")
            return object()

        def connect():
            order.append("connect")
            return conn

        with patch("worker.service.load_settings", side_effect=load_settings), \
            patch("worker.service.connect", side_effect=connect), \
            patch("worker.service.claim_next_worker_job", return_value=None):
            self.assertEqual(service.run_once("worker-test"), {"claimed": False})

        self.assertEqual(order, ["load_settings", "connect"])
        conn.close.assert_called_once_with()

    def test_main_loads_dotenv_before_startup_schema_connect(self) -> None:
        order: list[str] = []
        conn = Mock()

        def load_settings():
            order.append("load_settings")
            return object()

        def connect():
            order.append("connect")
            return conn

        with patch("worker.service._worker_id", return_value="worker-test"), \
            patch("worker.service._env_int", return_value=100), \
            patch("worker.service._env_flag", return_value=True), \
            patch("worker.service.load_settings", side_effect=load_settings), \
            patch("worker.service.connect", side_effect=connect), \
            patch("worker.service.init_db"), \
            patch("worker.service.cleanup_stale_worker_jobs"), \
            patch("worker.service.run_once", side_effect=KeyboardInterrupt):
            self.assertEqual(service.main(), 0)

        self.assertEqual(order, ["load_settings", "connect"])
        conn.close.assert_called_once_with()

    def test_run_once_publishes_project_domain_events(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 12,
            "job_run_id": 47,
            "job_type": "project-index",
            "payload": {"command": "project-index", "source": "project-index", "project_id": 5},
            "started_at": "2026-07-06T10:00:00+00:00",
            "finished_at": None,
        }
        result_payload = {
            "project": {"id": 5, "name": "P", "status": "active", "updated_at": "now"},
            "generated_artifact": {
                "id": 9,
                "artifact_type": "project_index",
                "title": "Index",
                "scope_type": "project",
                "scope_id": 5,
                "status": "draft",
                "updated_at": "now",
            },
        }
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.insert_app_event") as insert_event, \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value=result_payload), \
            patch("worker.service.complete_worker_job", return_value={"worker_job": {**worker_job, "status": "completed"}, "job_run": {}}):
            service.run_once("worker-test")

        event_names = [call.args[1] for call in insert_event.call_args_list]
        self.assertIn("task.finished", event_names)
        self.assertIn("project.updated", event_names)
        self.assertIn("artifact.created", event_names)

    def test_run_once_publishes_artifact_export_domain_event(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 17,
            "job_run_id": 52,
            "job_type": "artifact-export-obsidian",
            "payload": {"command": "artifact-export-obsidian", "source": "artifact-export", "artifact_id": 9},
            "started_at": "2026-07-06T10:00:00+00:00",
            "finished_at": None,
        }
        result_payload = {
            "artifact": {
                "id": 9,
                "artifact_type": "experiment_report",
                "title": "Report",
                "scope_type": "project",
                "scope_id": 5,
                "status": "ready",
                "updated_at": "now",
            }
        }
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.insert_app_event") as insert_event, \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value=result_payload), \
            patch("worker.service.complete_worker_job", return_value={"worker_job": {**worker_job, "status": "completed"}, "job_run": {}}):
            service.run_once("worker-test")

        artifact_events = [call for call in insert_event.call_args_list if call.args[1] == "artifact.updated"]
        self.assertEqual(len(artifact_events), 1)
        self.assertEqual(artifact_events[0].args[2]["artifact_id"], 9)
        self.assertEqual(artifact_events[0].args[2]["project_id"], 5)

    def test_run_once_publishes_paper_report_domain_event(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 13,
            "job_run_id": 48,
            "job_type": "generate-paper-reports",
            "payload": {"command": "generate-paper-reports", "source": "manual", "args": []},
            "started_at": "2026-07-06T10:00:00+00:00",
            "finished_at": None,
        }
        result_payload = {
            "paper_reports_candidates": 3,
            "paper_reports_queued": 1,
            "paper_reports_done": 2,
            "paper_reports_failed": 0,
        }
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.insert_app_event") as insert_event, \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value=result_payload), \
            patch("worker.service.complete_worker_job", return_value={"worker_job": {**worker_job, "status": "completed"}, "job_run": {}}):
            service.run_once("worker-test")

        report_events = [call for call in insert_event.call_args_list if call.args[1] == "paper_report.updated"]
        self.assertEqual(len(report_events), 1)
        payload = report_events[0].args[2]
        self.assertIsNone(payload["paper_id"])
        self.assertEqual(payload["status"], "done")
        self.assertEqual(payload["result"]["paper_reports_done"], 2)

    def test_run_once_publishes_daily_result_domain_events(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 18,
            "job_run_id": 53,
            "job_type": "run-daily",
            "payload": {"command": "run-daily", "source": "manual", "args": []},
            "started_at": "2026-07-08T10:00:00+00:00",
            "finished_at": None,
        }
        result_payload = {
            "arxiv_papers_inserted": 5,
            "daily_filtered_papers_archived": 2,
            "project_paper_matches_created": 3,
            "paper_recommendations_created": 1,
            "paper_reports_candidates": 3,
            "paper_reports_queued": 2,
            "daily_reports_created": 1,
            "daily_report_artifact_id": 36,
        }
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.insert_app_event") as insert_event, \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value=result_payload), \
            patch("worker.service.complete_worker_job", return_value={"worker_job": {**worker_job, "status": "completed"}, "job_run": {}}):
            service.run_once("worker-test")

        event_names = [call.args[1] for call in insert_event.call_args_list]
        self.assertIn("task.finished", event_names)
        self.assertIn("artifact.updated", event_names)
        self.assertIn("paper_report.updated", event_names)
        self.assertIn("papers.changed", event_names)
        self.assertIn("project.updated", event_names)

        artifact_event = next(call for call in insert_event.call_args_list if call.args[1] == "artifact.updated")
        self.assertEqual(artifact_event.args[2]["artifact_id"], 36)
        self.assertEqual(artifact_event.args[2]["artifact"]["artifact_type"], "daily_report")

        report_event = next(call for call in insert_event.call_args_list if call.args[1] == "paper_report.updated")
        self.assertEqual(report_event.args[2]["status"], "queued")
        self.assertEqual(report_event.args[2]["result"]["paper_reports_queued"], 2)

        papers_event = next(call for call in insert_event.call_args_list if call.args[1] == "papers.changed")
        self.assertEqual(papers_event.args[2]["result"]["arxiv_papers_inserted"], 5)

        project_event = next(call for call in insert_event.call_args_list if call.args[1] == "project.updated")
        self.assertEqual(project_event.args[2]["reason"], "worker_result")
        self.assertEqual(project_event.args[2]["result"]["project_paper_matches_created"], 3)


if __name__ == "__main__":
    unittest.main()
