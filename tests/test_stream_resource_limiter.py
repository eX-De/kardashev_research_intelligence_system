from __future__ import annotations

import os
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch
import urllib.error

from worker.paper_reports import _iter_chat_text_chunks
from worker.resource_limiter import outbound_request_slot


class FakeResponse:
    def __init__(self, lines):
        self.lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def __iter__(self):
        yield from self.lines


class BrokenResponse(FakeResponse):
    def __iter__(self):
        raise urllib.error.URLError("stream broke")
        yield b""


class StreamResourceLimiterTests(unittest.TestCase):
    def settings(self):
        provider = SimpleNamespace(id="p", api_key="key", base_url="https://provider.test/v1", provider_type="openai")
        return SimpleNamespace(
            llm_chat_provider_id="p", llm_chat_model="m", global_llm_request_concurrency=1,
            provider=lambda provider_id: provider if provider_id == "p" else None,
        )

    def test_stream_holds_slot_until_generator_close_and_releases_on_error(self) -> None:
        env = {"KRIS_RESOURCE_LIMITER_BACKEND": "local"}
        response = FakeResponse([b'data: {"choices":[{"delta":{"content":"one"}}]}\n'])
        with patch.dict(os.environ, env), patch("worker.paper_reports.urllib.request.urlopen", return_value=response):
            stream = _iter_chat_text_chunks(self.settings(), [{"role": "user", "content": "x"}])
            self.assertEqual(next(stream), "one")
            acquired = threading.Event()

            def contender() -> None:
                with outbound_request_slot("llm", 1):
                    acquired.set()

            thread = threading.Thread(target=contender)
            thread.start()
            self.assertFalse(acquired.wait(0.05))
            stream.close()
            self.assertTrue(acquired.wait(1))
            thread.join()

        with patch.dict(os.environ, env), patch("worker.paper_reports.urllib.request.urlopen", return_value=BrokenResponse([])):
            with self.assertRaisesRegex(RuntimeError, "stream broke"):
                list(_iter_chat_text_chunks(self.settings(), [{"role": "user", "content": "x"}]))
            with outbound_request_slot("llm", 1):
                pass


if __name__ == "__main__":
    unittest.main()
