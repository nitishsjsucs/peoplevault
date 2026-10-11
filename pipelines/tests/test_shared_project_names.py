"""The shared Google Cloud project (SPEC.md sections 18.5 and 30.3.8): every name this repo creates starts with the
policy's prefix, the only project-level role is roles/bigquery.jobUser, and the verifier scans only this repo's
datasets."""

import json

import pytest
import yaml

from peoplevault import config
from peoplevault.policy.model import Policy, policy
from peoplevault.verify.warehouse_scan import repo_datasets, scan_warehouse

INFRA = config.REPO_ROOT / "infra" / "bigquery"
PREFIX = "peoplevault"


def spec(name: str):
    return json.loads((INFRA / f"{name}.json").read_text())["spec"]


def test_the_prefix_comes_from_the_policy():
    assert policy().naming.prefix == PREFIX


def test_every_generated_name_carries_the_prefix():
    assert all(d["dataset"].startswith(f"{PREFIX}_") for d in spec("datasets"))
    assert {d["dataset"] for d in spec("datasets")} >= {f"{PREFIX}_authz_probe", f"{PREFIX}_scratch"}
    for s in spec("service_accounts"):
        assert s["account_id"].startswith(f"{PREFIX}-") and 6 <= len(s["account_id"]) <= 30, s
    assert all(r["role_id"].startswith(PREFIX) for r in spec("custom_roles"))
    assert all(dp["data_policy_id"].startswith(f"{PREFIX}_") for dp in spec("data_policies"))
    assert spec("taxonomy")["display_name"] == PREFIX
    assert policy().probe_dataset == f"{PREFIX}_authz_probe" and policy().scratch_dataset == f"{PREFIX}_scratch"
    for a in policy().assets:
        if a.store == "warehouse":
            assert all(p.name.startswith(f"{PREFIX}_") for p in a.parts), a.id


def test_every_member_is_one_of_this_repos_identities():
    members = json.dumps([spec(n) for n in ("datasets", "custom_roles", "iam_bindings", "data_policies")])
    for m in json.loads(json.dumps([x for x in members.split('"') if x.startswith("serviceAccount:")])):
        assert m.startswith(f"serviceAccount:{PREFIX}-"), m


def test_the_only_project_level_role_is_job_user():
    iam = spec("iam_bindings")
    assert {b["role"] for b in iam["project"]} == {"roles/bigquery.jobUser"}
    executor = f"serviceAccount:{PREFIX}-executor@{{project}}.iam.gserviceaccount.com"
    assert iam["taxonomy"] == [{"role": "roles/datacatalog.viewer", "member": executor}]
    # the executor owns exactly this repo's datasets and holds the time travel role on the three row-policy datasets
    owned = [d["dataset"] for d in spec("datasets") if {"role": "OWNER", "member": executor} in d["access"]]
    assert len(owned) == len(spec("datasets")) == 12
    assert [g["dataset"] for g in spec("custom_roles")[0]["grants"]] == [f"{PREFIX}_core", f"{PREFIX}_snapshots", f"{PREFIX}_marts"]


def test_the_policy_refuses_a_name_without_the_prefix():
    raw = yaml.safe_load((config.POLICY_DIR / "policy.yaml").read_text())
    bad = json.loads(json.dumps(raw))
    bad["datasets"]["data"][0] = "pv_raw"
    with pytest.raises(ValueError, match="must start with peoplevault_"):
        Policy.model_validate(bad)
    bad = json.loads(json.dumps(raw))
    bad["purposes"]["employee_relations"]["bq_identity"] = "pv-er-reader"
    with pytest.raises(ValueError, match="must start with peoplevault-"):
        Policy.model_validate(bad)


def test_the_verifier_scans_only_this_repos_datasets():
    assert repo_datasets(["peoplevault_core", "otherrepo_core", "pv_core", "information_schema", "peoplevault_scratch"]) == ["peoplevault_core", "peoplevault_scratch"]
    seen = []

    class FakeWarehouse:
        dialect = "duckdb"

        def list_datasets(self):
            return ["otherrepo_core", "peoplevault_core"]

        def list_base_tables(self, datasets):
            seen.extend(datasets)
            return []

    assert scan_warehouse(FakeWarehouse(), {"E00042": "employee_id"}) == []
    assert seen == ["peoplevault_core"]
