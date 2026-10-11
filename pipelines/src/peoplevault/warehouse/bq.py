"""BigQuery implementation of the Warehouse protocol (production). Status: written, not yet executed against BigQuery.

Always runs as pv-executor by impersonation on top of the owner's user ADC (no key on the laptop); running as the
owner's own user is refused, because the owner is in no row access policy and would silently read zero rows.
Writes run as one multi-statement transaction; a transaction aborted by a concurrent update (two executor runs
overlapping) is retried up to 5 times with backoff. The query cache is always off.
"""

from __future__ import annotations

import re
import time
from datetime import date

from peoplevault.warehouse.base import TableRef

CONCURRENT = re.compile(r"concurrent update|could not serialize access|aborted due to concurrent", re.I)
_PARAM = re.compile(r"\$(\w+)")


def executor_credentials(project: str):
    import google.auth
    from google.auth import impersonated_credentials

    source, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    target = f"pv-executor@{project}.iam.gserviceaccount.com"
    if getattr(source, "service_account_email", None) == target:
        return source  # the P1 Actions job runs with the pv-executor key itself
    return impersonated_credentials.Credentials(source_credentials=source, target_principal=target, target_scopes=["https://www.googleapis.com/auth/cloud-platform"], lifetime=3600)


def _param(name: str, value):
    from google.cloud import bigquery

    if isinstance(value, list):
        return bigquery.ArrayQueryParameter(name, "STRING", [str(v) for v in value])
    if isinstance(value, bool):
        return bigquery.ScalarQueryParameter(name, "BOOL", value)
    if isinstance(value, int):
        return bigquery.ScalarQueryParameter(name, "INT64", value)
    if isinstance(value, date):
        return bigquery.ScalarQueryParameter(name, "DATE", value)
    return bigquery.ScalarQueryParameter(name, "STRING", None if value is None else str(value))


class BqWarehouse:
    dialect = "bigquery"

    def __init__(self, project: str, location: str = "US", client=None, sleep=time.sleep):
        if client is None:
            from google.cloud import bigquery

            client = bigquery.Client(project=project, credentials=executor_credentials(project), location=location)
        self.client = client
        self.project = project
        self.location = location
        self.sleep = sleep

    def _config(self, params: dict | None):
        from google.cloud import bigquery

        return bigquery.QueryJobConfig(query_parameters=[_param(k, v) for k, v in (params or {}).items()], use_query_cache=False, labels={"app": "peoplevault", "role": "executor"})

    def query(self, sql: str, params: dict | None = None) -> list[dict]:
        job = self.client.query(_PARAM.sub(r"@\1", sql), job_config=self._config(params))
        return [dict(r.items()) for r in job.result()]

    def build_script(self, statements: list[tuple[str, dict]]) -> tuple[str, dict]:
        """One transaction; parameters are prefixed per statement so names never collide."""
        parts, params = ["BEGIN TRANSACTION;"], {}
        for i, (sql, p) in enumerate(statements):
            renamed = re.sub(r"[@$](\w+)", lambda m, i=i: f"@s{i}_{m.group(1)}", sql)
            parts.append(renamed.rstrip(";") + ";")
            params.update({f"s{i}_{k}": v for k, v in (p or {}).items()})
        parts.append("COMMIT TRANSACTION;")
        return "\n".join(parts), params

    def execute_script(self, statements: list[tuple[str, dict]], attempts: int = 5) -> list[int]:
        script, params = self.build_script(statements)
        for attempt in range(1, attempts + 1):
            try:
                job = self.client.query(script, job_config=self._config(params))
                job.result()
                children = sorted(self.client.list_jobs(parent_job=job.job_id), key=lambda j: j.created)
                dml = [int(c.num_dml_affected_rows or 0) for c in children if getattr(c, "statement_type", "") in ("DELETE", "UPDATE", "INSERT", "MERGE")]
                return dml
            except Exception as e:  # noqa: BLE001
                if attempt < attempts and CONCURRENT.search(str(e)):
                    self.sleep(min(30, 2**attempt))
                    continue
                raise
        raise RuntimeError("unreachable")

    def list_datasets(self) -> list[str]:
        return sorted(d.dataset_id for d in self.client.list_datasets())

    def list_base_tables(self, datasets: list[str]) -> list[TableRef]:
        out = []
        for ds in datasets:
            rows = self.query(f"SELECT table_name FROM `{self.project}.{ds}.INFORMATION_SCHEMA.TABLES` WHERE table_type = 'BASE TABLE' ORDER BY table_name")
            out.extend(TableRef(ds, r["table_name"]) for r in rows)
        return out

    def string_columns(self, table: TableRef) -> list[str]:
        rows = self.query(
            f"SELECT column_name FROM `{self.project}.{table.dataset}.INFORMATION_SCHEMA.COLUMNS` WHERE table_name = @t AND data_type = 'STRING' ORDER BY ordinal_position",
            {"t": table.table},
        )
        return [r["column_name"] for r in rows]

    def time_travel_hours(self, dataset: str) -> int | None:
        ds = self.client.get_dataset(f"{self.project}.{dataset}")
        return int(ds.max_time_travel_hours) if ds.max_time_travel_hours else None

    def close(self) -> None:
        self.client.close()
