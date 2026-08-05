from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from worker import service
from worker.job_inventory import worker_job_concurrency_group, worker_job_inventory
from worker.paper_reports import _paper_report_result
from worker.queue import task_event_payload


class WorkerServiceDispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cancel_checkpoint_patcher = patch(
            "worker.service.cancel_worker_job_before_dispatch",
            return_value={"worker_job": None, "job_run": None, "cancelled": False},
        )
        self.cancel_checkpoint = self.cancel_checkpoint_patcher.start()
        self.addCleanup(self.cancel_checkpoint_patcher.stop)

    def test_dispatch_inventory_has_labels_and_observation_groups(self) -> None:
        entries = worker_job_inventory()
        inventory_types = {str(entry["type"]) for entry in entries}
        self.assertEqual(inventory_types, set(service.SUPPORTED_WORKER_JOB_TYPES))
        self.assertEqual(len(entries), 20)
        for entry in entries:
            self.assertTrue(str(entry.get("label") or "").strip(), entry["type"])
            self.assertTrue(worker_job_concurrency_group(str(entry["type"])).strip(), entry["type"])

    def test_python_task_event_payloads_match_shared_cross_language_contract(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "task-event-contract.json"
        contract = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.assertEqual(
            [item["name"] for item in contract["cases"]],
            ["queued", "running", "completed", "failed", "requeued", "cancelled"],
        )
        for item in contract["cases"]:
            options = dict(item["options"])
            status = options.pop("status")
            actual = task_event_payload(item["job"], status, **options)
            self.assertEqual(actual, item["expected"], item["name"])

    def test_job_observation_separates_queue_wait_from_handler_duration(self) -> None:
        worker_job = {
            "id": 91,
            "job_type": "paper-report",
            "attempts": 2,
            "created_at": "2026-08-05T10:00:00+00:00",
        }
        self.assertEqual(
            service._queue_wait_seconds(
                worker_job,
                now=datetime(2026, 8, 5, 10, 0, 9, 250000, tzinfo=timezone.utc),
            ),
            9.25,
        )
        with patch("worker.service._queue_wait_seconds", return_value=9.25), \
            patch("worker.service.sys.stdout"):
            observation = service._log_job_observation(
                "worker_job.completed",
                worker_job,
                "worker-test",
                handler_duration_seconds=2.1256,
            )
        self.assertEqual(observation["queue_wait_seconds"], 9.25)
        self.assertEqual(observation["handler_duration_seconds"], 2.126)
        self.assertEqual(observation["job_type"], "paper-report")
        self.assertEqual(observation["worker_id"], "worker-test")
        self.assertEqual(observation["attempt"], 2)
        self.assertEqual(observation["concurrency_group"], "paper-report")

    def test_paper_report_result_marks_reader_sources_as_manual_imports(self) -> None:
        base = {
            "paper_id": 7,
            "artifact_id": 21,
            "title": "Imported paper",
            "status": "done",
            "arxiv_id": "",
            "finished_at": "2026-07-21T10:00:00+00:00",
        }
        for source_type in ("upload", "url", "web", "manual"):
            result = _paper_report_result({**base, "source_type": source_type})
            self.assertTrue(result["manual_import"], source_type)

        automatic = _paper_report_result({**base, "source_type": "arxiv", "arxiv_id": "2607.00001"})
        self.assertFalse(automatic["manual_import"])

    def test_dispatch_generate_paper_reports_is_removed(self) -> None:
        worker_job = {
            "id": 7,
            "job_run_id": 42,
            "job_type": "generate-paper-reports",
            "payload": {"command": "generate-paper-reports", "args": ["--limit", "1"]},
        }
        with self.assertRaisesRegex(RuntimeError, "Unsupported worker job type"):
            service.dispatch_worker_job(object(), object(), worker_job)

    def test_dispatch_ordinary_cli_job_disables_implicit_job_run_tracking(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 8,
            "job_run_id": None,
            "job_type": "sync-obsidian",
            "payload": {"command": "sync-obsidian", "args": []},
        }
        run = Mock(return_value={"ok": True})
        with patch.dict(service.DISPATCHERS, {"sync-obsidian": run}):
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"ok": True})

        run.assert_called_once_with(conn, settings, job_id=None, track_job_run=False)

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

    def test_removed_project_index_worker_dispatcher_is_rejected(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 10,
            "job_run_id": 45,
            "job_type": "project-index",
            "payload": {"command": "project-index", "project_id": 5, "export_to_obsidian": True},
        }
        with self.assertRaisesRegex(RuntimeError, "Unsupported worker job type: project-index"):
            service.dispatch_worker_job(conn, settings, worker_job)

    def test_dispatch_knowledge_document_index_uses_identity_and_content_hash_only(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 11,
            "job_run_id": 46,
            "job_type": "knowledge-document-index",
            "payload": {"document_id": 7, "project_id": 5, "content_hash": "abc123"},
        }
        with patch("worker.service.index_knowledge_document", return_value={"document_id": 7}) as index_document:
            result = service.dispatch_worker_job(conn, settings, worker_job)

        self.assertEqual(result, {"document_id": 7})
        index_document.assert_called_once_with(
            conn,
            settings,
            document_id=7,
            project_id=5,
            expected_content_hash="abc123",
        )

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

    def test_dispatch_artifact_index_uses_current_settings_model(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 15,
            "job_run_id": None,
            "job_type": "artifact-index",
            "payload": {
                "artifact_id": 9,
                "action": "index",
                "content_hash": "expected-content",
                "model": "old-queued-model",
            },
        }
        with patch("worker.service.index_artifact", return_value={"artifact_id": 9}) as index:
            result = service.dispatch_worker_job(conn, settings, worker_job)

        self.assertEqual(result, {"artifact_id": 9})
        index.assert_called_once_with(
            conn,
            settings,
            9,
            expected_content_hash="expected-content",
        )

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

    def test_dispatch_reader_import_url_uses_payload_body(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 16,
            "job_run_id": 51,
            "job_type": "reader-import-url",
            "payload": {"command": "reader-import-url", "body": {"urls": ["https://example.test/paper.pdf"]}},
        }
        expected = {"ok": True, "imported": [{"paper_id": 27}], "errors": []}
        with patch("worker.service.import_reader_urls", return_value=expected) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), expected)

        run.assert_called_once_with(conn, settings, {"urls": ["https://example.test/paper.pdf"]})

    def test_dispatch_reader_import_url_fails_when_no_paper_was_imported(self) -> None:
        worker_job = {
            "id": 16,
            "job_run_id": 51,
            "job_type": "reader-import-url",
            "payload": {"body": {"urls": ["https://example.test/paper.pdf"]}},
        }
        with patch(
            "worker.service.import_reader_urls",
            return_value={"ok": False, "imported": [], "errors": [{"error": "HTTP Error 403: Forbidden"}]},
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP Error 403: Forbidden"):
                service.dispatch_worker_job(object(), object(), worker_job)

    def test_dispatch_reader_import_web_uses_payload_body(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 17,
            "job_run_id": 52,
            "job_type": "reader-import-web",
            "payload": {"command": "reader-import-web", "body": {"urls": ["https://example.test/article"]}},
        }
        with patch("worker.service.import_reader_webpages", return_value={"ok": True, "imported": []}) as run:
            self.assertEqual(
                service.dispatch_worker_job(conn, settings, worker_job),
                {"ok": True, "imported": []},
            )

        run.assert_called_once_with(conn, settings, {"urls": ["https://example.test/article"]})

    def test_dispatch_reader_import_web_fails_when_no_page_was_imported(self) -> None:
        worker_job = {
            "id": 18,
            "job_run_id": 53,
            "job_type": "reader-import-web",
            "payload": {"body": {"urls": ["https://example.test/article"]}},
        }
        with patch(
            "worker.service.import_reader_webpages",
            return_value={"ok": False, "errors": [{"error": "正文过短"}]},
        ):
            with self.assertRaisesRegex(RuntimeError, "正文过短"):
                service.dispatch_worker_job(object(), object(), worker_job)

    def test_dispatch_paper_report_uses_payload_body(self) -> None:
        conn = object()
        settings = object()
        worker_job = {
            "id": 16,
            "job_run_id": 51,
            "job_type": "paper-report",
            "payload": {"command": "paper-report", "paper_id": 101, "body": {"force": True}},
        }
        with patch("worker.service.run_paper_report_worker_job", return_value={"ok": True}) as run:
            self.assertEqual(service.dispatch_worker_job(conn, settings, worker_job), {"ok": True})

        run.assert_called_once_with(conn, settings, worker_job)

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
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value={"message": "done"}), \
            patch("worker.service.complete_worker_job", return_value={"worker_job": {**worker_job, "status": "completed"}, "job_run": {}}) as complete:
            job_changes = []
            result = service.run_once("worker-test", job_changes.append)

        self.assertTrue(result["claimed"])
        self.assertEqual(complete.call_args.kwargs["worker_id"], "worker-test")
        self.assertEqual(complete.call_args.kwargs["lease_attempt"], 1)
        self.assertEqual(job_changes, [(9, 1), None])
        conn.close.assert_called_once_with()

    def test_run_once_confirms_requested_cancellation_before_dispatch(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 9,
            "job_run_id": 44,
            "job_type": "generate-reports",
            "payload": {"command": "generate-reports", "source": "manual", "args": []},
            "attempts": 1,
        }
        cancelled_job = {**worker_job, "status": "cancelled", "cancel_requested_at": "now"}
        self.cancel_checkpoint.return_value = {
            "worker_job": cancelled_job,
            "job_run": {"status": "cancelled"},
            "cancelled": True,
        }
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job") as dispatch, \
            patch("worker.service.complete_worker_job") as complete:
            result = service.run_once("worker-test")

        self.assertTrue(result["cancelled"])
        dispatch.assert_not_called()
        complete.assert_not_called()

    def test_handler_error_wins_over_late_cancel_request_and_fails_job(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 48,
            "job_run_id": 115,
            "job_type": "reader-import-url",
            "payload": {"command": "reader-import-url", "source": "reader-url", "args": []},
            "started_at": "2026-07-23T03:38:18+00:00",
            "finished_at": None,
        }
        failed_job = {
            **worker_job,
            "status": "failed",
            "error_message": "HTTP Error 403: Forbidden",
            "finished_at": "2026-07-23T03:38:19+00:00",
            "cancel_requested_at": "2026-07-23T03:38:18.500000+00:00",
        }
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", side_effect=RuntimeError("HTTP Error 403: Forbidden")), \
            patch("worker.service.fail_worker_job", return_value={"worker_job": failed_job, "job_run": {}}) as fail:
            with self.assertRaisesRegex(RuntimeError, "HTTP Error 403: Forbidden"):
                service.run_once("worker-test")

        payload = fail.call_args.kwargs["event_extra"]["notification"]
        self.assertEqual(payload["channels"], ["toast"])
        self.assertEqual(payload["severity"], "bad")
        self.assertEqual(payload["title"], "URL 导入失败")
        self.assertEqual(payload["detail"], "HTTP Error 403: Forbidden")
        self.assertEqual(fail.call_args.kwargs["lease_attempt"], 1)
        self.assertEqual(failed_job["status"], "failed")
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
            patch("worker.service.WorkerHeartbeat") as heartbeat_class, \
            patch("worker.service.WorkerStaleRecovery") as stale_recovery_class, \
            patch("worker.service.run_once", side_effect=KeyboardInterrupt):
            self.assertEqual(service.main(), 0)

        self.assertEqual(order, ["load_settings", "connect"])
        conn.close.assert_called_once_with()
        heartbeat_class.return_value.start.assert_called_once_with()
        heartbeat_class.return_value.stop.assert_called_once_with()
        stale_recovery_class.return_value.start.assert_called_once_with()
        stale_recovery_class.return_value.stop.assert_called_once_with()

    def test_stale_recovery_scan_uses_an_independent_connection(self) -> None:
        conn = Mock()
        with patch("worker.service.connect", return_value=conn), \
            patch(
                "worker.service.cleanup_stale_worker_jobs",
                return_value={"stale_worker_jobs_requeued": 1},
            ) as cleanup:
            recovery = service.WorkerStaleRecovery(5, 90)
            result = recovery.scan_once()

        self.assertEqual(result["stale_worker_jobs_requeued"], 1)
        cleanup.assert_called_once_with(conn, stale_after_seconds=90)
        conn.close.assert_called_once_with()

    def test_handler_success_wins_over_late_cancel_without_removed_project_events(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 12,
            "job_run_id": 47,
            "job_type": "generate-reports",
            "payload": {"command": "generate-reports", "source": "manual"},
            "started_at": "2026-07-06T10:00:00+00:00",
            "finished_at": None,
        }
        result_payload = {"ok": True}
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.insert_app_event") as insert_event, \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value=result_payload), \
            patch("worker.service.complete_worker_job", return_value={"worker_job": {**worker_job, "status": "completed"}, "job_run": {}}):
            service.run_once("worker-test")

        event_names = [call.args[1] for call in insert_event.call_args_list]
        self.assertNotIn("task.finished", event_names)
        self.assertNotIn("project.updated", event_names)
        self.assertNotIn("artifact.created", event_names)

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

    def test_run_once_does_not_publish_legacy_aggregate_report_event(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 13,
            "job_run_id": 48,
            "job_type": "rank-papers",
            "payload": {"command": "rank-papers", "source": "manual", "args": []},
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
        self.assertEqual(report_events, [])

    def test_run_once_toasts_when_manual_import_report_completes(self) -> None:
        conn = Mock()
        worker_job = {
            "id": 14,
            "job_run_id": None,
            "job_type": "paper-report",
            "payload": {"command": "paper-report", "source": "reader-import", "paper_id": 27},
            "started_at": "2026-07-21T10:00:00+00:00",
            "finished_at": None,
        }
        report_event = {
            "event_type": "paper_report.updated",
            "payload": {
                "paper_id": 27,
                "artifact_id": 61,
                "status": "done",
                "notification": {"channels": ["toast"], "severity": "ok", "title": "论文报告生成完成", "detail": "A Manually Imported Paper"},
            },
        }
        result_payload = {"paper_reports_done": 1, "domain_events": [report_event]}
        completed_result = {"worker_job": {**worker_job, "status": "completed"}, "job_run": {}, "cancelled": False}
        with patch("worker.service.connect", return_value=conn), \
            patch("worker.service.claim_next_worker_job", return_value={"worker_job": worker_job, "job_run": {}}), \
            patch("worker.service.insert_app_event") as insert_event, \
            patch("worker.service.load_settings", return_value=object()), \
            patch("worker.service.apply_stored_settings", return_value=object()), \
            patch("worker.service.dispatch_worker_job", return_value=result_payload), \
            patch("worker.service.complete_worker_job", return_value=completed_result) as complete:
            service.run_once("worker-test")

        self.assertEqual([call for call in insert_event.call_args_list if call.args[1] == "paper_report.updated"], [])
        self.assertEqual(complete.call_args.kwargs["domain_events"], [report_event])

    def test_reader_import_domain_event_toasts_success_and_partial_failure(self) -> None:
        worker_job = {
            "id": 49,
            "job_run_id": 116,
            "job_type": "reader-import-url",
            "payload": {"command": "reader-import-url", "source": "reader-url"},
        }
        with patch("worker.service.insert_app_event") as insert_event:
            service._publish_reader_domain_events(
                object(),
                worker_job,
                {
                    "ok": True,
                    "imported": [{"paper_id": 27, "title": "Imported paper"}],
                    "errors": [{"url": "https://example.test/missing.pdf", "error": "HTTP 404"}],
                },
            )

        insert_event.assert_called_once()
        self.assertEqual(insert_event.call_args.args[1], "reader.papers.imported")
        payload = insert_event.call_args.args[2]
        self.assertEqual(payload["imported_count"], 1)
        self.assertEqual(payload["error_count"], 1)
        self.assertEqual(payload["notification"]["channels"], ["toast"])
        self.assertEqual(payload["notification"]["severity"], "warn")
        self.assertEqual(payload["notification"]["title"], "URL 导入完成")
        self.assertEqual(payload["notification"]["detail"], "成功 1 篇，失败 1 篇")
        self.assertEqual(payload["notification"]["data"]["import_type"], "url")
        self.assertEqual(payload["notification"]["data"]["imported_count"], 1)
        self.assertEqual(payload["notification"]["data"]["error_count"], 1)

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
        self.assertNotIn("task.finished", event_names)
        self.assertIn("artifact.updated", event_names)
        self.assertNotIn("paper_report.updated", event_names)
        self.assertIn("papers.changed", event_names)
        self.assertIn("project.updated", event_names)

        artifact_event = next(call for call in insert_event.call_args_list if call.args[1] == "artifact.updated")
        self.assertEqual(artifact_event.args[2]["artifact_id"], 36)
        self.assertEqual(artifact_event.args[2]["artifact"]["artifact_type"], "daily_report")

        papers_event = next(call for call in insert_event.call_args_list if call.args[1] == "papers.changed")
        self.assertEqual(papers_event.args[2]["result"]["arxiv_papers_inserted"], 5)

        project_event = next(call for call in insert_event.call_args_list if call.args[1] == "project.updated")
        self.assertEqual(project_event.args[2]["reason"], "worker_result")
        self.assertEqual(project_event.args[2]["result"]["project_paper_matches_created"], 3)


if __name__ == "__main__":
    unittest.main()
