"""Local executor context: the DuckDB warehouse shared with the shim, the pyiceberg SqlCatalog and in-process dbt."""

from __future__ import annotations

from peoplevault import config
from peoplevault.dbtrun import run as dbt_run
from peoplevault.executor.api import WorkerApi
from peoplevault.executor.auth import DevJwtAuth
from peoplevault.executor.handlers import ExecContext
from peoplevault.lake.catalog import open_catalog


def local_context(wh) -> ExecContext:
    import os

    os.environ.setdefault("PV_DUCKDB_PATH", str(config.DUCKDB_PATH))
    return ExecContext(wh=wh, catalog=open_catalog("local"), target="local", dbt=lambda args: dbt_run([*args, "--target", "local"]).success)


def local_api() -> WorkerApi:
    return WorkerApi(f"http://127.0.0.1:{config.WORKER_PORT}", DevJwtAuth.from_local_settings())
