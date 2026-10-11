"""`pv serve`: the local process that owns the DuckDB file (one read-write process per database file).

Runs the warehouse shim on 127.0.0.1:8893 (PV_SHIM_PORT overrides) and the executor loop (polling the local Worker every
500 ms) with in-process dbt, so the shim, the executor and dbt share one DuckDB file in one process.
"""

from __future__ import annotations

import logging
import signal
import threading

from peoplevault import config
from peoplevault.shim.server import start
from peoplevault.warehouse.duck import DuckWarehouse

log = logging.getLogger("peoplevault.serve")


def serve(port: int | None = None, *, executor: bool = True) -> None:
    settings = config.local_settings()
    wh = DuckWarehouse.open()
    server, _ = start(wh, settings.shim_token, port or config.SHIM_PORT)
    stop = threading.Event()
    extra_threads = []
    if executor:
        from peoplevault.executor.local import local_api, local_context
        from peoplevault.executor.loop import start_thread

        extra_threads.append(lambda w, s: start_thread(local_api(), local_context(w), s))

    def _stop(*_):
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    workers = [t(wh, stop) for t in (extra_threads or [])]
    print(f"pv serve: shim listening on 127.0.0.1:{server.server_address[1]}; executor {'on' if executor else 'off'}", flush=True)
    try:
        stop.wait()
    finally:
        server.shutdown()
        for w in workers:
            w.join(timeout=10)
        wh.close()
