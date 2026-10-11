"""Production executor context (SPEC.md section 14.2). Status: written, not yet executed.

Runs as peoplevault-executor: from the owner's machine by impersonation, or in the scheduled executor.yml job with the
peoplevault-executor key (PV_DBT_TARGET=bigquery_actions, GOOGLE_APPLICATION_CREDENTIALS). It works against the Basin Catalog
through the Iceberg REST protocol and talks to the deployed Worker with the pv-executor Access service token; Access
issues the JWT at the edge. Every production dbt invocation is followed by bq_controls.verify() and fails closed.
"""

from __future__ import annotations

from peoplevault import config
from peoplevault.dbtrun import run as dbt_run
from peoplevault.executor.api import WorkerApi
from peoplevault.executor.auth import AccessServiceTokenAuth
from peoplevault.executor.handlers import ExecContext
from peoplevault.lake.catalog import open_catalog


def _require(env: dict, *names: str) -> list[str]:
    missing = [n for n in names if not env.get(n)]
    if missing:
        raise RuntimeError("missing from .secrets/prod.env: " + ", ".join(missing) + " (run `npm run setup:prod`)")
    return [env[n] for n in names]


def prod_api() -> WorkerApi:
    env = config.prod_env()
    base, cid, secret = _require(env, "PV_BASE_URL", "PV_CF_ACCESS_CLIENT_ID_EXECUTOR", "PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR")
    return WorkerApi(base, AccessServiceTokenAuth(cid, secret))


def prod_dbt(project: str):
    from peoplevault.setup.bq_controls import live_verify

    target = config.prod_dbt_target(project)

    def run(args: list[str]) -> bool:
        if not dbt_run([*args, "--target", target]).success:
            return False
        return live_verify(project) == []

    return run


def prod_context() -> ExecContext:
    from peoplevault.warehouse.bq import BqWarehouse

    (project,) = _require(config.prod_env(), "PV_GCP_PROJECT")
    return ExecContext(wh=BqWarehouse(project), catalog=open_catalog("prod"), target="prod", dbt=prod_dbt(project))
