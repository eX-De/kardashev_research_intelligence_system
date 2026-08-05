from __future__ import annotations

import http.client
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from worker.compute_service import ComputeApplication, RequestRegistry, create_server
from worker.compute_contract import ComputeRequestCancelled
from worker.paper_reader import generate_reader_followup_questions, paper_reader_chat_stream


class _Connection:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def commit(self) -> None:
        pass

    def execute(self, *_args, **_kwargs):
        return _Cursor()


class _Cursor:
    lastrowid = 9

    def fetchone(self):
        return {"id": 4, "library_paper_id": 7, "role": "assistant", "content": "anchor", "source": "chat", "model_provider_id": "", "model": "", "context_json": "{}", "created_at": "now"}


class ComputeApplicationTests(unittest.TestCase):
    def test_registry_propagates_cancel_and_releases_request(self) -> None:
        registry = RequestRegistry()
        app = ComputeApplication("secret", registry)
        conn = _Connection()
        entered = threading.Event()
        finished = threading.Event()
        errors: list[Exception] = []

        def operation(_conn, _settings, cancelled):
            entered.set()
            self.assertTrue(finished.wait(2))
            if cancelled():
                raise ComputeRequestCancelled()

        def run() -> None:
            try:
                with (
                    patch("worker.compute_service.connect", return_value=conn),
                    patch("worker.compute_service.load_settings", return_value=object()),
                    patch("worker.compute_service.apply_stored_settings", return_value=object()),
                ):
                    app.run("req-1", operation)
            except Exception as exc:
                errors.append(exc)

        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(2))
        self.assertTrue(registry.cancel("req-1"))
        finished.set()
        thread.join(2)
        self.assertIsInstance(errors[0], ComputeRequestCancelled)
        self.assertFalse(registry.cancel("req-1"))
        self.assertTrue(conn.closed)

    def test_chat_pre_cancel_never_reads_context_or_calls_provider(self) -> None:
        provider = unittest.mock.Mock()
        with (
            patch("worker.paper_reader._reader_paper_record") as paper_record,
            patch("worker.paper_reader._iter_chat_text_chunks", provider),
            self.assertRaises(ComputeRequestCancelled),
        ):
            paper_reader_chat_stream(_Connection(), SimpleNamespace(), 7, {"message": "why"}, lambda *_: None, cancelled=lambda: True)
        paper_record.assert_not_called()
        provider.assert_not_called()

    def test_chat_cancelled_by_start_event_does_not_open_provider_stream(self) -> None:
        cancelled = False
        provider = unittest.mock.Mock()

        def emit(event, _data):
            nonlocal cancelled
            if event == "start":
                cancelled = True

        with (
            patch("worker.paper_reader._reader_paper_record", return_value={"id": 7}),
            patch("worker.paper_reader.paper_reader_messages", return_value=[]),
            patch("worker.paper_reader._ensure_full_text", return_value="paper text"),
            patch("worker.paper_reader._reference_paper_contexts", return_value=[]),
            patch("worker.paper_reader._report_seed_messages", return_value=[]),
            patch("worker.paper_reader._reader_chat_model", return_value=("provider", "model")),
            patch("worker.paper_reader._build_chat_messages", return_value=[]),
            patch("worker.paper_reader._iter_chat_text_chunks", provider),
            self.assertRaises(ComputeRequestCancelled),
        ):
            paper_reader_chat_stream(_Connection(), SimpleNamespace(), 7, {"message": "why"}, emit, cancelled=lambda: cancelled)
        provider.assert_not_called()

    def test_followup_cancelled_during_context_loading_never_calls_provider(self) -> None:
        cancelled = False
        provider = unittest.mock.Mock()

        def paper_record(_conn, _paper_id):
            nonlocal cancelled
            cancelled = True
            return {"id": 7, "title": "Paper"}

        with (
            patch("worker.paper_reader._reader_message_payload", return_value={"content": "anchor"}),
            patch("worker.paper_reader._reader_paper_record", side_effect=paper_record),
            patch("worker.paper_reader._call_chat_text", provider),
            self.assertRaises(ComputeRequestCancelled),
        ):
            generate_reader_followup_questions(
                _Connection(),
                SimpleNamespace(),
                7,
                {"selected_text": "selection", "anchor_message_id": 4},
                cancelled=lambda: cancelled,
            )
        provider.assert_not_called()


class ComputeHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = create_server("127.0.0.1", 0, "secret")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = int(self.server.server_address[1])

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, method: str, path: str, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        raw = json.dumps(body or {}) if body is not None else None
        conn.request(method, path, body=raw, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        conn.close()
        return result

    def test_requires_token_and_replaces_unsafe_request_id(self) -> None:
        status, _, _ = self.request("POST", "/v1/search/deep", {})
        self.assertEqual(status, 401)
        status, headers, _ = self.request("GET", "/healthz", headers={"x-request-id": "bad id"})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["x-request-id"], "bad id")

    def test_deep_search_is_direct_json_and_uses_request_id(self) -> None:
        conn = _Connection()
        with (
            patch("worker.compute_service.connect", return_value=conn),
            patch("worker.compute_service.load_settings", return_value=object()),
            patch("worker.compute_service.apply_stored_settings", return_value=object()),
            patch("worker.compute_service.deep_search", return_value={"mode": "deep", "results": [], "stats": {}}) as deep,
        ):
            status, headers, raw = self.request(
                "POST",
                "/v1/search/deep",
                {"query": "retrieval"},
                {"authorization": "Bearer secret", "content-type": "application/json", "x-request-id": "req.deep-1"},
            )
        self.assertEqual(status, 200)
        self.assertEqual(headers["x-request-id"], "req.deep-1")
        self.assertEqual(json.loads(raw)["mode"], "deep")
        self.assertEqual(deep.call_args.args[2]["query"], "retrieval")
        self.assertTrue(conn.closed)

    def test_chat_error_stays_inside_already_started_stream(self) -> None:
        conn = _Connection()
        with (
            patch("worker.compute_service.connect", return_value=conn),
            patch("worker.compute_service.load_settings", return_value=object()),
            patch("worker.compute_service.apply_stored_settings", return_value=object()),
            patch("worker.compute_service.paper_reader_chat_stream", side_effect=RuntimeError("upstream failed")),
        ):
            status, headers, raw = self.request(
                "POST",
                "/v1/reader/papers/7/chat",
                {"message": "why"},
                {"authorization": "Bearer secret", "content-type": "application/json"},
            )
        self.assertEqual(status, 200)
        self.assertIn("application/x-ndjson", headers["content-type"])
        events = [json.loads(line) for line in raw.decode().splitlines() if line]
        self.assertEqual(events, [{"event": "error", "data": {"error": "upstream failed", "code": "compute_failed"}}])


if __name__ == "__main__":
    unittest.main()
