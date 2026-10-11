"""`pv load --target prod` (SPEC.md section 22.2 step 6). Status: written, not yet executed against BigQuery.

As peoplevault-executor: create the raw and restricted tables, sync the suppression list from the deployed Worker, upsert the
identity xref, land each export object (replacing rows of its export_date), replay the 13 weekly snapshots, run
`dbt build --target bigquery` (merge-only protected tables), verify every tag and row access policy, and append the
Iceberg history to the Basin Catalog after the self-test. Any zero count or missing control fails.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from peoplevault import config
from peoplevault.bqjob import load_kwargs, run_query
from peoplevault.load.schema import BQ_TYPES, EXPORT_FIELDS, FAMILY_TABLE, all_tables  # noqa: F401
from peoplevault.pseudo import Pseudonymizer

PROD_GENERATED = config.REPO_ROOT / "data" / "generated-prod"


def _bq_schema(cols):
    from google.cloud import bigquery

    return [bigquery.SchemaField(c, BQ_TYPES[t]) for c, t in cols]


def ensure_tables(client, project: str) -> None:
    from google.cloud import bigquery

    for table, cols in all_tables().items():
        client.create_table(bigquery.Table(f"{project}.{table}", schema=_bq_schema(cols)), exists_ok=True)


def _json_rows(arrow_table) -> list[dict]:
    rows = arrow_table.to_pylist()
    for r in rows:
        for k, v in list(r.items()):
            if hasattr(v, "isoformat"):
                r[k] = v.isoformat()
    return rows


def load_prod(*, from_r2: bool = False) -> dict:
    from google.cloud import bigquery

    from peoplevault.dbtrun import run as dbt_run
    from peoplevault.executor.prod import prod_api
    from peoplevault.lake.catalog import open_catalog
    from peoplevault.load import lake, raw
    from peoplevault.load.raw import LoadReport
    from peoplevault.setup.bq_controls import live_verify
    from peoplevault.sources import local_files, wrangler_r2
    from peoplevault.warehouse.bq import executor_credentials

    env = config.prod_env()
    project = env["PV_GCP_PROJECT"]
    master = env.get("PV_PSEUDONYM_MASTER_KEY") or _worker_secret("PV_PSEUDONYM_MASTER_KEY")
    import base64

    ps = Pseudonymizer(base64.b64decode(master))
    client = bigquery.Client(project=project, credentials=executor_credentials(project), location="US")
    ensure_tables(client, project)
    sup = prod_api().suppression()
    # production synth output (written by `npm run seed:prod` with the production master key), never data/generated
    objects = list(wrangler_r2.iter_objects(remote=True, config_path="infra/cloudflare/wrangler.production.jsonc", root=PROD_GENERATED) if from_r2
                   else local_files.iter_objects(PROD_GENERATED))
    loaded_at = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    report = LoadReport()
    hris_ids = sorted({json.loads(line)["employee_id"] for o in objects if o.family == "hris" for line in o.body.splitlines() if line.strip()})
    xref = [{"employee_id": e, "employee_key": r["warehouse_key"], "employee_ref": r["employee_ref"], "analytics_id": r["analytics_id"], "subject_ref": r["subject_ref"]}
            for e in hris_ids for r in [ps.all(e)] if r["subject_ref"] not in sup]
    stage = f"{project}.peoplevault_restricted._xref_stage"
    client.load_table_from_json(xref, stage, job_config=bigquery.LoadJobConfig(schema=_bq_schema(all_tables()["peoplevault_restricted.identity_xref"]), write_disposition="WRITE_TRUNCATE"), **load_kwargs()).result()
    run_query(client, f"MERGE `{project}.peoplevault_restricted.identity_xref` t USING `{stage}` s ON t.employee_id = s.employee_id "
              "WHEN NOT MATCHED THEN INSERT ROW").result()
    client.delete_table(stage, not_found_ok=True)
    for obj in objects:
        try:
            rows = raw.parse_rows(obj)
        except raw.QuarantineError as q:
            raw.write_quarantine(str(q))
            report.quarantined.append(obj.key)
            continue
        arrow = raw.transform(obj, rows, ps, sup, loaded_at, report)
        table = FAMILY_TABLE[obj.family]
        run_query(client, f"DELETE FROM `{project}.{table}` WHERE export_date = @d", [bigquery.ScalarQueryParameter("d", "DATE", obj.basis_date)]).result()
        load_config = bigquery.LoadJobConfig(schema=_bq_schema(all_tables()[table]), write_disposition="WRITE_APPEND")
        client.load_table_from_json(_json_rows(arrow), f"{project}.{table}", job_config=load_config, **load_kwargs()).result()
        report.objects_loaded += 1
        report.rows_loaded[table] = report.rows_loaded.get(table, 0) + arrow.num_rows
    for d in sorted(o.basis_date for o in objects if o.family == "hris"):
        if not dbt_run(["snapshot", "--target", "bigquery", "--vars", json.dumps({"pv_snapshot_export_date": d})]).success:
            raise RuntimeError(f"dbt snapshot failed for export {d}")
    if not dbt_run(["build", "--target", "bigquery"]).success:
        raise RuntimeError("dbt build --target bigquery failed")
    problems = live_verify(project)
    if problems:
        raise RuntimeError(f"protected table controls missing after the build: {len(problems)} problem(s)")
    lake_report = lake.load_employee_monthly(open_catalog("prod"), ps, sup, history_dir=PROD_GENERATED / "history" / "employee_monthly")
    return {"identity_xref": len(xref), "raw": report.__dict__, "snapshot_replays": sum(1 for o in objects if o.family == "hris"), "lake": lake_report}


def _worker_secret(name: str) -> str:
    path = config.SECRETS_DIR / "worker-secrets.env"
    values = config.parse_env_file(path)
    if not values.get(name):
        raise RuntimeError(f"{name} missing from .secrets/worker-secrets.env (run `npm run setup:prod`)")
    return values[name]
