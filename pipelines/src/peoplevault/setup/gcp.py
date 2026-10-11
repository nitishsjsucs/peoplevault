"""`pv setup gcp [--dry-run]`: idempotent Google Cloud setup from infra/bigquery/*.json (SPEC.md sections 15 and 22.2).

Every step reads the current state first and creates only what is missing: APIs, 7 service accounts, the custom role
pvTimeTravelReader, project and service-account IAM (Token Creator for the owner on pv-executor and the purpose
readers, for pv-gateway on the purpose readers), 10 datasets with max_time_travel_hours = 48 on the data datasets,
the dataset grant of the custom role, the policy tag taxonomy and its 6 tags (resource names recorded in
.secrets/prod-resources.json for `pv dbt --vars`), Fine-Grained Reader grants, data masking policies, and one key: the
pv-gateway key (created only if none is recorded locally). Status: written, not yet executed against Google Cloud;
the dry-run plans are golden-tested with a fake client (tests/test_setup_gcp_dryrun.py).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Protocol

from peoplevault import config

INFRA = config.REPO_ROOT / "infra" / "bigquery"


def spec(name: str):
    return json.loads((INFRA / f"{name}.json").read_text())["spec"]


def fill(value, project: str, user: str):
    if isinstance(value, str):
        return value.replace("{project}", project).replace("{user}", user)
    if isinstance(value, list):
        return [fill(v, project, user) for v in value]
    if isinstance(value, dict):
        return {k: fill(v, project, user) for k, v in value.items()}
    return value


class GcpClient(Protocol):
    def enabled_apis(self) -> set[str]: ...
    def enable_apis(self, apis: list[str]) -> None: ...
    def service_accounts(self) -> set[str]: ...
    def create_service_account(self, account_id: str, display_name: str) -> None: ...
    def custom_roles(self) -> set[str]: ...
    def create_custom_role(self, role: dict) -> None: ...
    def project_bindings(self) -> set[tuple[str, str]]: ...
    def add_project_bindings(self, bindings: list[tuple[str, str]]) -> None: ...
    def sa_bindings(self, sa_email: str) -> set[tuple[str, str]]: ...
    def add_sa_binding(self, sa_email: str, role: str, member: str) -> None: ...
    def datasets(self) -> dict[str, dict]: ...
    def create_dataset(self, ds: dict) -> None: ...
    def set_time_travel(self, dataset: str, hours: int) -> None: ...
    def add_dataset_access(self, dataset: str, role: str, member: str) -> None: ...
    def taxonomy(self, display_name: str) -> dict | None: ...
    def create_taxonomy(self, tax: dict) -> dict: ...
    def create_policy_tag(self, taxonomy_name: str, display_name: str, description: str) -> str: ...
    def tag_readers(self, tag_name: str) -> set[str]: ...
    def add_tag_reader(self, tag_name: str, member: str) -> None: ...
    def data_policies(self) -> set[str]: ...
    def create_data_policy(self, dp: dict, tag_name: str) -> None: ...
    def create_sa_key(self, sa_email: str) -> str: ...


@dataclass
class Step:
    action: str
    detail: str
    run: object = None  # zero-argument callable

    def line(self) -> str:
        return f"{self.action}: {self.detail}"


@dataclass
class SetupResult:
    steps: list[Step] = field(default_factory=list)
    resources: dict = field(default_factory=dict)


FGR = "roles/datacatalog.categoryFineGrainedReader"


def plan(client: GcpClient, project: str, user: str, *, gateway_key_recorded: bool) -> SetupResult:
    """Reads state and returns the ordered create steps (empty when everything exists)."""
    out = SetupResult()
    add = out.steps.append
    iam = fill(spec("iam_bindings"), project, user)
    missing_apis = sorted(set(iam["apis"]) - client.enabled_apis())
    if missing_apis:
        add(Step("enable apis", " ".join(missing_apis), lambda: client.enable_apis(missing_apis)))
    have_sas = client.service_accounts()
    for s in spec("service_accounts"):
        if s["account_id"] not in have_sas:
            add(Step("create service account", s["account_id"], lambda s=s: client.create_service_account(s["account_id"], s["display_name"])))
    roles = client.custom_roles()
    for r in spec("custom_roles"):
        if r["role_id"] not in roles:
            add(Step("create custom role", f"projects/{project}/roles/{r['role_id']} ({', '.join(r['permissions'])})", lambda r=r: client.create_custom_role(r)))
    have_bindings = client.project_bindings()
    missing = [(b["role"], b["member"]) for b in iam["project"] if (b["role"], b["member"]) not in have_bindings]
    if missing:
        add(Step("add project iam bindings", "; ".join(f"{r} -> {m}" for r, m in missing), lambda: client.add_project_bindings(missing)))
    for b in iam["service_account"]:
        if (b["role"], b["member"]) not in client.sa_bindings(b["service_account"]):
            add(Step("add service account iam binding", f"{b['service_account']}: {b['role']} -> {b['member']}", lambda b=b: client.add_sa_binding(b["service_account"], b["role"], b["member"])))
    have_ds = client.datasets()
    for ds in fill(spec("datasets"), project, user):
        cur = have_ds.get(ds["dataset"])
        if cur is None:
            add(Step("create dataset", f"{project}.{ds['dataset']} (US)", lambda ds=ds: client.create_dataset(ds)))
            cur = {"max_time_travel_hours": None, "access": set()}
        if ds["max_time_travel_hours"] and cur.get("max_time_travel_hours") != ds["max_time_travel_hours"]:
            add(Step("set time travel window", f"ALTER SCHEMA {ds['dataset']} SET OPTIONS (max_time_travel_hours = {ds['max_time_travel_hours']})",
                     lambda ds=ds: client.set_time_travel(ds["dataset"], ds["max_time_travel_hours"])))
        for a in ds["access"]:
            if (a["role"], a["member"]) not in cur["access"]:
                add(Step("grant dataset access", f"{ds['dataset']}: {a['role']} -> {a['member']}", lambda ds=ds, a=a: client.add_dataset_access(ds["dataset"], a["role"], a["member"])))
    for r in fill(spec("custom_roles"), project, user):
        for g in r["grants"]:
            role = f"projects/{project}/roles/{r['role_id']}"
            if (role, g["member"]) not in (have_ds.get(g["dataset"]) or {"access": set()})["access"]:
                add(Step("grant custom role on dataset", f"{g['dataset']}: {role} -> {g['member']}", lambda g=g, role=role: client.add_dataset_access(g["dataset"], role, g["member"])))
    tax_spec = spec("taxonomy")
    tax = client.taxonomy(tax_spec["display_name"])
    tags: dict[str, str] = dict((tax or {}).get("tags", {}))
    if tax is None:
        add(Step("create taxonomy", f"{tax_spec['display_name']} in {tax_spec['location']} (fine-grained access control)", None))
    for t in tax_spec["policy_tags"]:
        if t["display_name"] not in tags:
            add(Step("create policy tag", t["display_name"], None))
    readers = iam["fine_grained_reader"]
    for cls, members in readers.items():
        have = client.tag_readers(tags[cls]) if cls in tags else set()
        for m in members:
            if m not in have:
                add(Step("grant fine-grained reader", f"{cls}: {FGR} -> {m}", None))
    have_dp = client.data_policies()
    for dp in fill(spec("data_policies"), project, user):
        if dp["data_policy_id"] not in have_dp:
            add(Step("create data masking policy", f"{dp['data_policy_id']} ({dp['predefined_expression']} on {dp['policy_tag']}; grantees {', '.join(dp['grantees'])})", None))
    if not gateway_key_recorded:
        add(Step("create service account key", f"pv-gateway@{project}.iam.gserviceaccount.com -> .secrets/worker-secrets.env (GCP_GATEWAY_SA_KEY)", None))
    out.resources["policy_tags"] = tags
    return out


def apply(client: GcpClient, project: str, user: str, *, gateway_key_recorded: bool) -> SetupResult:
    """Executes the plan in order; taxonomy, tags, tag IAM, data policies and the key need results of earlier calls."""
    result = plan(client, project, user, gateway_key_recorded=gateway_key_recorded)
    for s in result.steps:
        if s.run is not None:
            s.run()
    tax_spec = spec("taxonomy")
    tax = client.taxonomy(tax_spec["display_name"]) or client.create_taxonomy(tax_spec)
    tags = dict(tax.get("tags", {}))
    for t in tax_spec["policy_tags"]:
        if t["display_name"] not in tags:
            tags[t["display_name"]] = client.create_policy_tag(tax["name"], t["display_name"], t["description"])
    for cls, members in fill(spec("iam_bindings"), project, user)["fine_grained_reader"].items():
        have = client.tag_readers(tags[cls])
        for m in members:
            if m not in have:
                client.add_tag_reader(tags[cls], m)
    have_dp = client.data_policies()
    for dp in fill(spec("data_policies"), project, user):
        if dp["data_policy_id"] not in have_dp:
            client.create_data_policy(dp, tags[dp["policy_tag"]])
    result.resources["policy_tags"] = tags
    result.resources["taxonomy"] = tax["name"]
    if not gateway_key_recorded:
        result.resources["gateway_key"] = client.create_sa_key(f"pv-gateway@{project}.iam.gserviceaccount.com")
    return result


def record(resources: dict) -> None:
    """Merges policy tag names into .secrets/prod-resources.json and writes the gateway key into worker-secrets.env."""
    config.SECRETS_DIR.mkdir(mode=0o700, exist_ok=True)
    path = config.SECRETS_DIR / "prod-resources.json"
    current = json.loads(path.read_text()) if path.exists() else {}
    current["policy_tags"] = resources.get("policy_tags", current.get("policy_tags", {}))
    if resources.get("taxonomy"):
        current["taxonomy"] = resources["taxonomy"]
    path.write_text(json.dumps(current, indent=2) + "\n")
    os.chmod(path, 0o600)
    if resources.get("gateway_key"):
        secrets = config.SECRETS_DIR / "worker-secrets.env"
        lines = [line for line in (secrets.read_text().splitlines() if secrets.exists() else []) if not line.startswith("GCP_GATEWAY_SA_KEY=")]
        lines.append("GCP_GATEWAY_SA_KEY=" + json.dumps(json.loads(resources["gateway_key"]), separators=(",", ":")))
        secrets.write_text("\n".join(lines) + "\n")
        os.chmod(secrets, 0o600)


def gateway_key_recorded() -> bool:
    secrets = config.SECRETS_DIR / "worker-secrets.env"
    return secrets.exists() and any(line.startswith("GCP_GATEWAY_SA_KEY=") and len(line) > 30 for line in secrets.read_text().splitlines())
