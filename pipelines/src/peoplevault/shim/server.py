"""HTTP shim on 127.0.0.1:8893: POST /v1/query {purpose, query_id, params} with X-PV-Shim-Token."""

from __future__ import annotations

import hmac
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from peoplevault.shim.queries import ShimError, run_named

log = logging.getLogger("peoplevault.shim")
MAX_BODY = 64 * 1024


def make_handler(wh, token: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # never log request lines (they could carry parameters)
            return

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True, "backend": "duckdb-shim"})
            return self._send(404, {"error": "not_found"})

        def do_POST(self):
            if self.path != "/v1/query":
                return self._send(404, {"error": "not_found"})
            given = self.headers.get("X-PV-Shim-Token", "")
            if not hmac.compare_digest(given.encode(), token.encode()):
                return self._send(401, {"error": "unauthorized"})
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self._send(400, {"error": "bad_request"})
            try:
                req = json.loads(self.rfile.read(length))
                rows = run_named(wh, req.get("purpose", ""), req.get("query_id", ""), req.get("params") or {})
            except ShimError as e:
                return self._send(e.status, {"error": e.code})
            except (ValueError, TypeError):
                return self._send(400, {"error": "bad_request"})
            except Exception as e:  # noqa: BLE001
                log.warning("shim query failed: %s", type(e).__name__)
                return self._send(500, {"error": "query_failed"})
            return self._send(200, {"rows": rows, "backend": "duckdb-shim"})

    return Handler


def start(wh, token: str, port: int, host: str = "127.0.0.1") -> tuple[ThreadingHTTPServer, threading.Thread]:
    server = ThreadingHTTPServer((host, port), make_handler(wh, token))
    t = threading.Thread(target=server.serve_forever, name="pv-shim", daemon=True)
    t.start()
    return server, t
