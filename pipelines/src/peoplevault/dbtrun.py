"""In-process dbt runner (`dbtRunner`) with the repository's project and profiles directories.

- Always `--log-level warn` (dbt output can echo SQL with literals; nothing below warn is emitted), or `none` under
  public logs (PV_PUBLIC_LOGS=true, the executor.yml job), and never `store_failures`, so test failures cannot write a
  subject's rows into an audit table or a log.
- Target `bigquery`: refuses `--full-refresh` (ADR 0006: protected tables are created once and then changed
  only by MERGE and DML) and passes `--vars` with the policy tag resource names recorded by `pv setup gcp`.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Sequence
from dataclasses import dataclass

from peoplevault import config

log = logging.getLogger("peoplevault.dbt")

PROD_TARGETS = {"bigquery", "bigquery_actions"}
ALL_TARGETS = {"local", "bigquery_ci", *PROD_TARGETS}


class DbtRefused(RuntimeError):
    """A dbt invocation that the governance rules forbid."""


@dataclass
class DbtResult:
    success: bool
    args: list[str]
    exception: str | None = None


def _target_of(args: Sequence[str]) -> str:
    for i, a in enumerate(args):
        if a == "--target" and i + 1 < len(args):
            return args[i + 1]
        if a.startswith("--target="):
            return a.split("=", 1)[1]
    return "local"


def build_args(args: Sequence[str], *, policy_tags: dict[str, str] | None = None, log_level: str = "warn") -> list[str]:
    """Returns the full dbt argument list, applying the repository rules. Pure (no I/O) for testing.

    `log_level` is `warn` everywhere except public logs (the executor.yml job), where it is `none`: dbt prints its
    own console output outside Python logging, so the redacting filter cannot reach it."""
    if log_level not in ("warn", "none"):
        raise DbtRefused("dbt console output is warn (or none for public logs), never more verbose")
    args = list(args)
    target = _target_of(args)
    if target not in ALL_TARGETS:
        raise DbtRefused(f"unknown dbt target {target!r}")
    if any(a in ("--full-refresh", "-f") for a in args) and target in PROD_TARGETS:
        raise DbtRefused("--full-refresh is refused on BigQuery: protected tables are merge-only (ADR 0006)")
    if any(a.startswith("--store-failures") for a in args):
        raise DbtRefused("store_failures is never used: failing rows could contain a subject's data")
    out = list(args)
    if "--target" not in out and not any(a.startswith("--target=") for a in out):
        out += ["--target", target]
    if target in PROD_TARGETS:
        if not policy_tags:
            raise DbtRefused("policy tag names missing; run `npm run setup:prod` (pv setup gcp records them)")
        merged: dict = {}
        if "--vars" in out:
            i = out.index("--vars")
            merged = json.loads(out[i + 1])
            del out[i : i + 2]
        if "pv_policy_tags" in merged:
            raise DbtRefused("policy tag names come only from .secrets/prod-resources.json (or PV_POLICY_TAGS_JSON in executor.yml)")
        merged["pv_policy_tags"] = policy_tags
        out += ["--vars", json.dumps(merged, sort_keys=True)]
    out += ["--project-dir", str(config.DBT_DIR), "--profiles-dir", str(config.DBT_DIR)]
    if "--log-level" in out:
        raise DbtRefused("--log-level is set by pv dbt (warn, or none for public logs)")
    return ["--log-level", log_level, *out]


def run(args: Sequence[str]) -> DbtResult:
    from dbt.cli.main import dbtRunner  # imported lazily: dbt is slow to import

    target = _target_of(args)
    tags = None
    if target in PROD_TARGETS:
        tags = config.prod_resources().get("policy_tags")
        project = config.prod_env().get("PV_GCP_PROJECT")
        if not project:
            raise DbtRefused("PV_GCP_PROJECT missing from .secrets/prod.env")
        os.environ["PV_GCP_PROJECT"] = project
    public = config.public_logs()
    full = build_args(args, policy_tags=tags, log_level="none" if public else "warn")
    os.environ.setdefault("PV_DUCKDB_PATH", str(config.DUCKDB_PATH))
    res = dbtRunner().invoke(full)
    exc = None if res.exception is None else type(res.exception).__name__
    if public and not res.success:
        log.warning("dbt failed: %s", ", ".join(failed_nodes(res.result)) or exc or "no node results")
    return DbtResult(success=bool(res.success), args=full, exception=exc)


def failed_nodes(result) -> list[str]:
    """Unique ids of nodes that errored or failed (model and test names only, never rows or messages)."""
    out: list[str] = []
    for r in getattr(result, "results", None) or []:
        status = str(getattr(r, "status", "")).lower()
        if status.endswith(("error", "fail")):
            out.append(getattr(getattr(r, "node", None), "unique_id", "unknown"))
    return out
