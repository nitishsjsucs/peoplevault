"""BigQuery authorization runs (production only). Status: written, not yet executed.

purpose_runner: the 48 warehouse-layer cases as each purpose's service account (impersonated, query cache off),
through the same generated named-query SQL the Worker runs.

Ceiling probes (SPEC.md section 15.8): the 48 cases go through views and table functions that already omit denied
columns and filter the restricted population, so on their own they would pass even with tags or row access policies
missing. These 37 probes test the ceilings directly through a temporary dataset pv_authz_probe of views over the core
tables with no filters, authorized on pv_core: 18 denied cells must fail with an access error, 4 masked cells must
come back masked, 5 restricted-population counts must match each purpose's row access policy, and 10 dataset IAM
probes must fail. Reported separately from the 100 cases, never added to them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from peoplevault.policy.model import policy

PROBE_DATASET = "pv_authz_probe"
CORE_TABLES = ["dim_employee", "fct_compensation", "fct_performance", "fct_leave"]
REPRESENTATIVE = {
    "direct_identifier": ("dim_employee", "full_name"), "date_of_birth": ("dim_employee", "birth_date"),
    "compensation": ("fct_compensation", "base_salary"), "performance": ("fct_performance", "rating"),
    "health_leave": ("fct_leave", "leave_type"), "protected_attribute": ("dim_employee", "gender"),
}


@dataclass(frozen=True)
class Probe:
    kind: str  # deny | mask | rows | iam
    purpose: str
    sql: str
    expect: str  # access_denied | all_null | year_only | zero | positive


def probes(project: str) -> list[Probe]:
    p = policy()
    out: list[Probe] = []
    for purpose in p.purposes:
        for cls, vis in p.visibility[purpose].items():
            table, col = REPRESENTATIVE[cls]
            rel = f"`{project}.{PROBE_DATASET}.{table}`"
            if vis == "deny":
                out.append(Probe("deny", purpose, f"SELECT {col} FROM {rel} LIMIT 1", "access_denied"))
            elif vis == "mask_nullify":
                out.append(Probe("mask", purpose, f"SELECT COUNTIF({col} IS NOT NULL) AS n FROM {rel}", "all_null"))
            elif vis == "mask_date_year":
                out.append(Probe("mask", purpose, f"SELECT COUNTIF(EXTRACT(MONTH FROM {col}) != 1 OR EXTRACT(DAY FROM {col}) != 1) AS n FROM {rel}", "year_only"))
    for name, pd in p.purposes.items():
        expect = "zero" if pd.restricted_population == "exclude" else "positive"
        out.append(Probe("rows", name, f"SELECT COUNT(*) AS n FROM `{project}.{PROBE_DATASET}.dim_employee` WHERE is_restricted", expect))
    names = list(p.purposes)
    for i, name in enumerate(names):
        other = names[(i + 1) % len(names)]
        view = next(iter(p.purpose_views[other]))
        out.append(Probe("iam", name, f"SELECT 1 FROM `{project}.{p.purpose_dataset(other)}.{view}` LIMIT 1", "access_denied"))
        out.append(Probe("iam", name, f"SELECT 1 FROM `{project}.pv_core.dim_employee` LIMIT 1", "access_denied"))
    return out


def purpose_client(project: str, purpose: str):
    import google.auth
    from google.auth import impersonated_credentials
    from google.cloud import bigquery

    source, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    sa = f"{policy().purposes[purpose].bq_identity}@{project}.iam.gserviceaccount.com"
    creds = impersonated_credentials.Credentials(source_credentials=source, target_principal=sa, target_scopes=["https://www.googleapis.com/auth/cloud-platform"])
    return bigquery.Client(project=project, credentials=creds, location="US")


def purpose_runner(project: str):
    """(purpose, query_id, params) -> rows, as that purpose's service account, through the compiled BigQuery SQL."""
    from google.cloud import bigquery

    from peoplevault import config

    compiled = json.loads((config.POLICY_DIR / "compiled" / "policy.json").read_text())
    clients: dict[str, object] = {}

    def run(purpose: str, query_id: str, params: dict) -> list[dict]:
        q = compiled["queries"][query_id]
        client = clients.setdefault(purpose, purpose_client(project, purpose))
        qp = []
        for name, typ in q["params"].items():
            v = params[name]
            qp.append(bigquery.ArrayQueryParameter(name, "STRING", v) if typ == "string_array" else
                      bigquery.ScalarQueryParameter(name, {"date": "DATE", "int": "INT64"}.get(typ, "STRING"), v))
        job = client.query(q["sql"]["bigquery"].replace("{project}", project), job_config=bigquery.QueryJobConfig(query_parameters=qp, use_query_cache=False))
        return [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in r.items()} for r in job.result()]

    return run


def setup_probe_dataset(executor_client, project: str, purpose_sas: list[str]) -> None:
    from google.cloud import bigquery

    ds = bigquery.Dataset(f"{project}.{PROBE_DATASET}")
    ds.location = "US"
    ds = executor_client.create_dataset(ds, exists_ok=True)
    for t in CORE_TABLES:
        view = bigquery.Table(f"{project}.{PROBE_DATASET}.{t}")
        view.view_query = f"SELECT * FROM `{project}.pv_core.{t}`"
        executor_client.create_table(view, exists_ok=True)
    core = executor_client.get_dataset(f"{project}.pv_core")
    entries = list(core.access_entries)
    for t in CORE_TABLES:
        entries.append(bigquery.AccessEntry(None, "view", {"projectId": project, "datasetId": PROBE_DATASET, "tableId": t}))
    core.access_entries = entries
    executor_client.update_dataset(core, ["access_entries"])
    ds.access_entries = [*ds.access_entries, *[bigquery.AccessEntry("READER", "userByEmail", sa) for sa in purpose_sas]]
    executor_client.update_dataset(ds, ["access_entries"])


def cleanup_probe_dataset(executor_client, project: str) -> None:
    core = executor_client.get_dataset(f"{project}.pv_core")
    core.access_entries = [e for e in core.access_entries if not (e.entity_type == "view" and e.entity_id.get("datasetId") == PROBE_DATASET)]
    executor_client.update_dataset(core, ["access_entries"])
    executor_client.delete_dataset(f"{project}.{PROBE_DATASET}", delete_contents=True, not_found_ok=True)


def run_probes(project: str) -> dict:
    from google.cloud import bigquery

    from peoplevault.warehouse.bq import executor_credentials

    executor = bigquery.Client(project=project, credentials=executor_credentials(project), location="US")
    sas = [f"{pd.bq_identity}@{project}.iam.gserviceaccount.com" for pd in policy().purposes.values()]
    results = []
    try:
        setup_probe_dataset(executor, project, sas)
        for pr in probes(project):
            client = purpose_client(project, pr.purpose)
            try:
                rows = list(client.query(pr.sql, job_config=bigquery.QueryJobConfig(use_query_cache=False)).result())
                n = rows[0][0] if rows and len(rows[0]) else None
                ok = (pr.expect in ("all_null", "year_only", "zero") and n == 0) or (pr.expect == "positive" and (n or 0) > 0)
            except Exception as e:  # noqa: BLE001
                ok = pr.expect == "access_denied" and ("access denied" in str(e).lower() or "permission" in str(e).lower())
            results.append({"kind": pr.kind, "purpose": pr.purpose, "passed": bool(ok)})
    finally:
        cleanup_probe_dataset(executor, project)
    by_kind: dict[str, dict[str, int]] = {}
    for r in results:
        d = by_kind.setdefault(r["kind"], {"passed": 0, "total": 0})
        d["total"] += 1
        d["passed"] += int(r["passed"])
    return {"passed": sum(r["passed"] for r in results), "total": len(results), "by_kind": by_kind}
