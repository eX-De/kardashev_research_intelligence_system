from __future__ import annotations

import os
import threading
import time
import unittest
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

from worker.embeddings import embed_text
from worker.llm import call_chat_json
from worker.resource_limiter import outbound_request_slot


class ResourceLimiterTests(unittest.TestCase):
    def test_local_fallback_caps_parallel_requests_and_releases_after_error(self) -> None:
        active = 0
        maximum = 0
        lock = threading.Lock()

        def request() -> None:
            nonlocal active, maximum
            with outbound_request_slot("llm", 2):
                with lock:
                    active += 1
                    maximum = max(maximum, active)
                time.sleep(0.03)
                with lock:
                    active -= 1

        with patch.dict(os.environ, {"KRIS_RESOURCE_LIMITER_BACKEND": "local"}):
            threads = [threading.Thread(target=request) for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(maximum, 2)
            with self.assertRaisesRegex(RuntimeError, "boom"):
                with outbound_request_slot("embedding", 1):
                    raise RuntimeError("boom")
            with outbound_request_slot("embedding", 1):
                pass

    def test_local_controlled_embedding_provider_observes_global_cap_without_429(self) -> None:
        state = {"active": 0, "maximum": 0, "requests": 0, "rate_limited": 0}
        lock = threading.Lock()

        class ProviderHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                with lock:
                    state["active"] += 1
                    state["requests"] += 1
                    state["maximum"] = max(state["maximum"], state["active"])
                    over_limit = state["active"] > 2
                    if over_limit:
                        state["rate_limited"] += 1
                try:
                    time.sleep(0.04)
                    body = json.dumps({"data": [{"embedding": [1.0, 0.0]}]}).encode("utf-8")
                    self.send_response(429 if over_limit else 200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                finally:
                    with lock:
                        state["active"] -= 1

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        provider = SimpleNamespace(api_key="test", base_url=f"http://127.0.0.1:{server.server_port}")
        settings = SimpleNamespace(
            llm_embedding_model="controlled-embedding",
            global_embedding_request_concurrency=2,
            embedding_provider=lambda: provider,
        )
        results: list[list[float] | None] = []
        with patch.dict(os.environ, {"KRIS_RESOURCE_LIMITER_BACKEND": "local"}):
            callers = [threading.Thread(target=lambda: results.append(embed_text(settings, "sample"))) for _ in range(8)]
            for caller in callers: caller.start()
            for caller in callers: caller.join()
        self.assertEqual(len(results), 8)
        self.assertEqual(state, {"active": 0, "maximum": 2, "requests": 8, "rate_limited": 0})

    def test_local_controlled_llm_provider_observes_global_cap_without_429(self) -> None:
        state = {"active": 0, "maximum": 0, "requests": 0, "rate_limited": 0}
        lock = threading.Lock()

        class ProviderHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                with lock:
                    state["active"] += 1; state["requests"] += 1
                    state["maximum"] = max(state["maximum"], state["active"])
                    over_limit = state["active"] > 2
                    if over_limit: state["rate_limited"] += 1
                try:
                    time.sleep(0.04)
                    body = json.dumps({"choices": [{"message": {"content": "{\"ok\":true}"}}]}).encode("utf-8")
                    self.send_response(429 if over_limit else 200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                finally:
                    with lock: state["active"] -= 1

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        provider = SimpleNamespace(
            id="controlled", api_key="test", base_url=f"http://127.0.0.1:{server.server_port}",
            provider_type="openai_compatible", openrouter_model_policies={},
        )
        settings = SimpleNamespace(
            llm_chat_provider_id="controlled", llm_chat_model="controlled-chat",
            global_llm_request_concurrency=2, provider=lambda _provider_id: provider,
        )
        results: list[dict | None] = []
        with patch.dict(os.environ, {"KRIS_RESOURCE_LIMITER_BACKEND": "local"}):
            callers = [threading.Thread(target=lambda: results.append(call_chat_json(settings, "sample"))) for _ in range(8)]
            for caller in callers: caller.start()
            for caller in callers: caller.join()
        self.assertEqual(results, [{"ok": True}] * 8)
        self.assertEqual(state, {"active": 0, "maximum": 2, "requests": 8, "rate_limited": 0})


if __name__ == "__main__":
    unittest.main()
