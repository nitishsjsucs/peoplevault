"""Byte-capped BigQuery jobs (SPEC.md section 30.3.8).

The Google Cloud project is shared by four repos and planned inside BigQuery's free tier, so every query job this
package starts goes through `run_query` (or uses `job_config`): `maximum_bytes_billed` is always set (a capped query
fails without being billed, and the executor then reports ok: false, fail closed), the query cache is off, the job
carries the `app: peoplevault` label and its id starts with `peoplevault_`. Load jobs get the same id prefix through
`load_kwargs`. `tests/test_bq_bytes_cap.py` fails if any module builds a QueryJobConfig or calls a BigQuery client's
`query` anywhere else.
"""

from __future__ import annotations

MAX_BYTES_BILLED = 1 << 30  # 1 GiB for the executor, loaders, verifiers, residual checks and the authz runner
CEILING_PROBE_BYTES = 100 * 1024 * 1024  # 100 MiB, the same cap as the Worker's purpose queries
JOB_ID_PREFIX = "peoplevault_"
LABELS = {"app": "peoplevault"}


def job_config(params: list | None = None, *, max_bytes: int = MAX_BYTES_BILLED, labels: dict[str, str] | None = None):
    from google.cloud import bigquery

    return bigquery.QueryJobConfig(
        query_parameters=list(params or []),
        use_query_cache=False,
        maximum_bytes_billed=int(max_bytes),
        labels={**LABELS, **(labels or {})},
    )


def run_query(client, sql: str, params: list | None = None, *, max_bytes: int = MAX_BYTES_BILLED, labels: dict[str, str] | None = None):
    """Starts one byte-capped query job and returns the job (call `.result()` on it)."""
    return client.query(sql, job_config=job_config(params, max_bytes=max_bytes, labels=labels), job_id_prefix=JOB_ID_PREFIX)


def dry_run(client, sql: str):
    """Validates `sql` on BigQuery without running it (a dry run reads and bills nothing) and returns the job, whose
    `total_bytes_processed` is the estimate. Used by the live suite to catch dialect errors before `seed:prod`."""
    from google.cloud import bigquery

    cfg = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False, maximum_bytes_billed=MAX_BYTES_BILLED, labels=dict(LABELS))
    return client.query(sql, job_config=cfg, job_id_prefix=JOB_ID_PREFIX)


def load_kwargs() -> dict:
    """Keyword arguments for `load_table_from_json` and friends: the job id prefix (load jobs read no bytes)."""
    return {"job_id_prefix": JOB_ID_PREFIX}
