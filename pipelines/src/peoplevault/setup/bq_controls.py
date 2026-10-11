"""`bq_controls.verify()`: after every production dbt invocation (and in doctor), every protected table must still carry
its policy tags and both row access policies (rap_full, rap_non_restricted). BigQuery drops both on CREATE OR REPLACE
TABLE, so a missing control fails the run (ADR 0006). Reads tables.get and rowAccessPolicies.list through injected
callables, so recorded responses test it without credentials."""

from __future__ import annotations

from collections.abc import Callable

from peoplevault.policy.model import TAGGED_CLASSES, policy
from peoplevault.policy.protected import PROTECTED_MODELS

REQUIRED_POLICIES = ("rap_full", "rap_non_restricted")


def verify(get_table: Callable[[str], dict], list_row_policies: Callable[[str], dict], policy_tags: dict[str, str]) -> list[str]:
    """get_table(dataset.table) -> tables.get JSON; list_row_policies(dataset.table) -> rowAccessPolicies.list JSON."""
    classes = policy().column_class
    problems: list[str] = []
    for table in PROTECTED_MODELS.values():
        try:
            t = get_table(table)
        except Exception as e:  # noqa: BLE001
            problems.append(f"{table}: tables.get failed ({type(e).__name__})")
            continue
        fields = {f["name"]: f for f in t.get("schema", {}).get("fields", [])}
        if not fields:
            problems.append(f"{table}: no schema (zero columns)")
        for name, f in fields.items():
            cls = classes.get(name)
            got = (f.get("policyTags") or {}).get("names", [])
            if cls in TAGGED_CLASSES:
                want = [policy_tags[cls]]
                if got != want:
                    problems.append(f"{table}.{name}: policy tag {'missing' if not got else 'wrong'} for class {cls}")
            elif got:
                problems.append(f"{table}.{name}: unexpected policy tag on an untagged column")
        try:
            names = {p["rowAccessPolicyReference"]["policyId"] for p in list_row_policies(table).get("rowAccessPolicies", [])}
        except Exception as e:  # noqa: BLE001
            problems.append(f"{table}: rowAccessPolicies.list failed ({type(e).__name__})")
            continue
        for p in REQUIRED_POLICIES:
            if p not in names:
                problems.append(f"{table}: row access policy {p} missing")
    return problems


def live_verify(project: str) -> list[str]:
    """verify() against the live BigQuery API as pv-executor (written, not yet executed)."""
    import json

    from google.auth.transport.requests import AuthorizedSession
    from google.cloud import bigquery

    from peoplevault import config
    from peoplevault.warehouse.bq import executor_credentials

    creds = executor_credentials(project)
    client = bigquery.Client(project=project, credentials=creds)
    http = AuthorizedSession(creds)
    tags = json.loads((config.SECRETS_DIR / "prod-resources.json").read_text()).get("policy_tags", {})

    def get_table(name: str) -> dict:
        return client.get_table(f"{project}.{name}").to_api_repr()

    def list_policies(name: str) -> dict:
        ds, table = name.split(".")
        r = http.get(f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets/{ds}/tables/{table}/rowAccessPolicies")
        r.raise_for_status()
        return r.json()

    return verify(get_table, list_policies, tags)
