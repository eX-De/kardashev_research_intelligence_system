from __future__ import annotations

import hmac
import json
import os
import re
import signal
import threading
import time
import traceback
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from .config import load_settings
from .compute_contract import ComputeRequestCancelled
from .db import connect
from .paper_reader import generate_reader_followup_questions, paper_reader_chat_stream
from .settings_store import apply_stored_settings
from .unified_search import deep_search


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 2 * 1024 * 1024
SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _secret(name: str) -> str:
    file_name = str(os.environ.get(f"{name}_FILE") or "").strip()
    if file_name:
        return Path(file_name).read_text(encoding="utf-8").rstrip("\r\n")
    return str(os.environ.get(name) or "")


class RequestRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: dict[str, threading.Event] = {}

    def start(self, request_id: str) -> threading.Event:
        with self._lock:
            if request_id in self._requests:
                raise ValueError("request_id is already active")
            cancelled = threading.Event()
            self._requests[request_id] = cancelled
            return cancelled

    def cancel(self, request_id: str) -> bool:
        with self._lock:
            cancelled = self._requests.get(request_id)
            if cancelled is None:
                return False
            cancelled.set()
            return True

    def finish(self, request_id: str) -> None:
        with self._lock:
            self._requests.pop(request_id, None)


class ComputeApplication:
    def __init__(self, token: str, registry: RequestRegistry | None = None) -> None:
        if not token:
            raise RuntimeError("KRIS_COMPUTE_TOKEN or KRIS_COMPUTE_TOKEN_FILE is required")
        self.token = token
        self.registry = registry or RequestRegistry()

    def authenticated(self, authorization: str) -> bool:
        scheme, _, value = authorization.partition(" ")
        return scheme.lower() == "bearer" and hmac.compare_digest(value, self.token)

    def run(
        self,
        request_id: str,
        operation: Callable[[Any, Any, Callable[[], bool]], Any],
    ) -> Any:
        cancelled = self.registry.start(request_id)
        conn = None
        try:
            conn = connect()
            settings = apply_stored_settings(conn, load_settings())
            return operation(conn, settings, cancelled.is_set)
        finally:
            try:
                if conn is not None:
                    conn.close()
            finally:
                self.registry.finish(request_id)


class ComputeHandler(BaseHTTPRequestHandler):
    server_version = "KRISCompute/1"

    @property
    def app(self) -> ComputeApplication:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: object) -> None:
        print(f"compute {self.address_string()} {format % args}", flush=True)

    def _json(self, status: int, payload: dict[str, object], request_id: str = "") -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        if request_id:
            self.send_header("x-request-id", request_id)
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, request_id: str) -> bool:
        if self.app.authenticated(str(self.headers.get("authorization") or "")):
            return True
        self._json(HTTPStatus.UNAUTHORIZED, {"error": "Authentication required", "code": "compute_auth_required"}, request_id)
        return False

    def _request_id(self) -> str:
        supplied = str(self.headers.get("x-request-id") or "").strip()
        return supplied if SAFE_REQUEST_ID.fullmatch(supplied) else str(uuid.uuid4())

    def _body(self) -> dict[str, object]:
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError as exc:
            raise ValueError("Invalid content-length") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("Request body is too large")
        raw = self.rfile.read(length) if length else b"{}"
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON request body must be an object")
        return value

    def _request_log(self, request_id: str, path: str, started: float, outcome: str, error: str = "") -> None:
        print(json.dumps({
            "event": "compute.request",
            "request_id": request_id,
            "path": path,
            "outcome": outcome,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
            **({"error": error[:500]} if error else {}),
        }, ensure_ascii=False), flush=True)

    def do_GET(self) -> None:
        request_id = self._request_id()
        if urlparse(self.path).path == "/healthz":
            self._json(HTTPStatus.OK, {"ok": True, "service": "compute"}, request_id)
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"}, request_id)

    def do_DELETE(self) -> None:
        request_id = self._request_id()
        if not self._authorized(request_id):
            return
        path = urlparse(self.path).path
        prefix = "/v1/requests/"
        if path.startswith(prefix) and path.endswith("/cancel"):
            target_id = path[len(prefix) : -len("/cancel")].strip("/")
            self._json(HTTPStatus.OK, {"ok": True, "request_id": target_id, "cancelled": self.app.registry.cancel(target_id)}, request_id)
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"}, request_id)

    def do_POST(self) -> None:
        request_id = self._request_id()
        path = urlparse(self.path).path
        started = time.perf_counter()
        if not self._authorized(request_id):
            self._request_log(request_id, path, started, "unauthorized")
            return
        try:
            body = self._body()
            if path == "/v1/search/deep":
                result = self.app.run(
                    request_id,
                    lambda conn, settings, cancelled: deep_search(conn, settings, body, cancelled=cancelled),
                )
                self._json(HTTPStatus.OK, result, request_id)
                self._request_log(request_id, path, started, "completed")
                return
            chat_match = _paper_route(path, "/chat")
            if chat_match is not None:
                outcome, error = self._stream_chat(request_id, chat_match, body)
                self._request_log(request_id, path, started, outcome, error)
                return
            followup_match = _paper_route(path, "/followups")
            if followup_match is not None:
                result = self.app.run(
                    request_id,
                    lambda conn, settings, cancelled: _run_followups(
                        conn, settings, followup_match, body, cancelled
                    ),
                )
                self._json(HTTPStatus.OK, result, request_id)
                self._request_log(request_id, path, started, "completed")
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"}, request_id)
            self._request_log(request_id, path, started, "not_found")
        except ComputeRequestCancelled:
            self._json(499, {"error": "Compute request cancelled", "code": "compute_cancelled"}, request_id)
            self._request_log(request_id, path, started, "cancelled")
        except ValueError as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc), "code": "invalid_request"}, request_id)
            self._request_log(request_id, path, started, "invalid", str(exc))
        except (BrokenPipeError, ConnectionResetError):
            self.app.registry.cancel(request_id)
            self._request_log(request_id, path, started, "disconnected")
        except Exception as exc:
            traceback.print_exc()
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc), "code": "compute_failed"}, request_id)
            self._request_log(request_id, path, started, "failed", str(exc))

    def _stream_chat(self, request_id: str, paper_id: int, body: dict[str, object]) -> tuple[str, str]:
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", "application/x-ndjson; charset=utf-8")
        self.send_header("cache-control", "no-cache, no-transform")
        self.send_header("x-request-id", request_id)
        self.end_headers()

        def operation(conn: Any, settings: Any, cancelled: Callable[[], bool]) -> None:
            def emit(event: str, data: dict[str, object]) -> None:
                if cancelled():
                    raise ComputeRequestCancelled()
                line = json.dumps({"event": event, "data": data}, ensure_ascii=False).encode("utf-8") + b"\n"
                self.wfile.write(line)
                self.wfile.flush()

            paper_reader_chat_stream(conn, settings, paper_id, body, emit, cancelled=cancelled)

        try:
            self.app.run(request_id, operation)
            return "completed", ""
        except ComputeRequestCancelled:
            return "cancelled", ""
        except (BrokenPipeError, ConnectionResetError):
            self.app.registry.cancel(request_id)
            return "disconnected", ""
        except Exception as exc:
            try:
                line = json.dumps(
                    {"event": "error", "data": {"error": str(exc), "code": "compute_failed"}},
                    ensure_ascii=False,
                ).encode("utf-8") + b"\n"
                self.wfile.write(line)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                self.app.registry.cancel(request_id)
            return "failed", str(exc)


def _paper_route(path: str, suffix: str) -> int | None:
    prefix = "/v1/reader/papers/"
    if not path.startswith(prefix) or not path.endswith(suffix):
        return None
    raw = path[len(prefix) : -len(suffix)].strip("/")
    return int(raw) if raw.isdigit() and int(raw) > 0 else None


def _run_followups(conn: Any, settings: Any, paper_id: int, body: dict[str, object], cancelled: Callable[[], bool]) -> dict[str, object]:
    if cancelled():
        raise ComputeRequestCancelled()
    result = generate_reader_followup_questions(conn, settings, paper_id, body, cancelled=cancelled)
    if cancelled():
        raise ComputeRequestCancelled()
    return result


def create_server(host: str | None = None, port: int | None = None, token: str | None = None) -> ThreadingHTTPServer:
    resolved_host = host or str(os.environ.get("KRIS_COMPUTE_HOST") or DEFAULT_HOST)
    resolved_port = port or int(os.environ.get("KRIS_COMPUTE_PORT") or DEFAULT_PORT)
    resolved_token = token if token is not None else _secret("KRIS_COMPUTE_TOKEN")
    server = ThreadingHTTPServer((resolved_host, resolved_port), ComputeHandler)
    server.daemon_threads = True
    server.app = ComputeApplication(resolved_token)  # type: ignore[attr-defined]
    return server


def main() -> None:
    # Source-mode launches rely on worker.config to load the repository .env
    # before the service identity is resolved.
    load_settings()
    server = create_server()
    stop = lambda *_args: threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    host, port = server.server_address[:2]
    print(f"KRIS compute service listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
