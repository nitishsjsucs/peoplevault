"""`pv doctor gcp`: every line has a status and every non-ok line names its fix; nothing secret is echoed."""

import json

from peoplevault.setup.doctor_gcp import (
    bigquery_checks,
    catalog_check,
    gcloud_checks,
    required_apis,
    run_checks,
    to_json,
)

PROJECT = "pv-test"
ENV = {"PV_GCP_PROJECT": PROJECT, "PV_R2_CATALOG_TOKEN": "tok", "PV_CATALOG_URI": "https://catalog.example.test", "PV_CATALOG_WAREHOUSE": "acct_pv-lake"}
SECRET = "ya29.secret-access-token"


def runner(overrides: dict | None = None):
    answers = {
        ("gcloud", "--version"): (0, "Google Cloud SDK 587.0.0\nbq 2.1\n"),
        ("gcloud", "auth", "list", "--format=json"): (0, json.dumps([{"account": "owner@example.test", "status": "ACTIVE"}])),
        ("gcloud", "auth", "application-default", "print-access-token"): (0, SECRET),
        ("gcloud", "config", "get-value", "project"): (0, PROJECT + "\n"),
        ("gcloud", "billing", "projects", "describe", PROJECT, "--format=json"): (0, json.dumps({"billingEnabled": True})),
        ("gcloud", "services", "list", "--enabled", "--project", PROJECT, "--format=json"): (0, json.dumps([{"config": {"name": a}} for a in required_apis()])),
    }
    answers.update(overrides or {})
    calls = []

    def run(args):
        calls.append(tuple(args))
        return answers.get(tuple(args), (1, ""))

    run.calls = calls
    return run


class FakeProbes:
    def __init__(self, steps=(), fail_sa=(), problems=(), leftover=False, counts=None, ns_error=False):
        self.steps, self.fail_sa, self.problems, self.leftover, self._counts, self.ns_error = list(steps), set(fail_sa), list(problems), leftover, counts, ns_error

    def setup_steps(self):
        return self.steps

    def impersonate(self, sa):
        if sa.split("@")[0] in self.fail_sa:
            raise PermissionError("denied")

    def controls(self):
        return self.problems

    def probe_dataset_leftovers(self):
        return 3 if self.leftover else 0

    def counts(self, tables):
        return self._counts if self._counts is not None else {t: 10 for t in tables}

    def catalog_namespaces(self):
        if self.ns_error:
            raise ConnectionError("401")
        return [("hr_history",)]


def adc(tmp_path, quota=PROJECT):
    p = tmp_path / "adc.json"
    p.write_text(json.dumps({"type": "authorized_user", "quota_project_id": quota}))
    return p


def test_all_ok(tmp_path):
    from peoplevault import config

    seeded = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())["warehouse"]
    checks = run_checks(runner(), ENV, FakeProbes(counts=seeded), adc(tmp_path))
    assert [c.status for c in checks if c.status != "ok"] == []
    assert SECRET not in to_json(checks)


def test_missing_gcloud_stops_with_the_install_command(tmp_path):
    checks, can_query = gcloud_checks(runner({("gcloud", "--version"): (127, "")}), ENV, adc(tmp_path))
    assert not can_query and [(c.name, c.status, c.fix) for c in checks] == [("gcloud", "missing", "brew install --cask gcloud-cli")]


def test_quota_project_billing_and_apis_name_their_fixes(tmp_path):
    run = runner({
        ("gcloud", "billing", "projects", "describe", PROJECT, "--format=json"): (0, json.dumps({"billingEnabled": False})),
        ("gcloud", "services", "list", "--enabled", "--project", PROJECT, "--format=json"): (0, json.dumps([{"config": {"name": "bigquery.googleapis.com"}}])),
    })
    checks, _ = gcloud_checks(run, ENV, adc(tmp_path, quota="other"))
    by = {c.name: c for c in checks}
    assert by["ADC quota project"].fix == f"gcloud auth application-default set-quota-project {PROJECT}"
    assert by["billing"].status == "missing" and "gcloud billing projects link" in by["billing"].fix
    assert by["APIs"].status == "missing" and by["APIs"].fix.startswith("npm run setup:prod (pv setup gcp enables them), or gcloud services enable ")
    # only the APIs that are off, so the command can be pasted as it is
    assert "bigquery.googleapis.com " not in by["APIs"].fix + " " and "cloudresourcemanager.googleapis.com" in by["APIs"].fix
    for c in checks:
        assert c.status == "ok" or c.fix


def test_the_apis_are_the_ones_setup_enables():
    assert required_apis() == ["bigquery.googleapis.com", "datacatalog.googleapis.com", "bigquerydatapolicy.googleapis.com", "iamcredentials.googleapis.com", "iam.googleapis.com",
                               "cloudresourcemanager.googleapis.com"]


def test_billing_names_the_billing_account_the_project_already_points_to(tmp_path):
    # the shared project on 2026-10-11: a billing account is named but billing is off
    run = runner({("gcloud", "billing", "projects", "describe", PROJECT, "--format=json"): (0, json.dumps({"billingAccountName": "billingAccounts/01E865-CB9CA4-66E862", "billingEnabled": False}))})
    by = {c.name: c for c in gcloud_checks(run, ENV, adc(tmp_path))[0]}
    assert by["billing"].detail == "not enabled (the project names billing account 01E865-CB9CA4-66E862)"
    assert by["billing"].fix.startswith("check that billing account 01E865-CB9CA4-66E862 is open, then gcloud billing projects link pv-test --billing-account=01E865-CB9CA4-66E862")


def test_an_unset_project_suggests_gclouds_current_project(tmp_path):
    by = {c.name: c for c in gcloud_checks(runner(), {}, adc(tmp_path))[0]}
    assert by["project"].fix.startswith(f"add PV_GCP_PROJECT={PROJECT} to .secrets/prod.env (gcloud's current project;")
    unset = runner({("gcloud", "config", "get-value", "project"): (0, "\n")})
    assert {c.name: c for c in gcloud_checks(unset, {}, adc(tmp_path))[0]}["project"].fix.startswith("add PV_GCP_PROJECT=<PROJECT_ID>")


def test_no_project_skips_bigquery(tmp_path):
    checks = run_checks(runner(), {}, FakeProbes(), adc(tmp_path))
    names = {c.name: c for c in checks}
    assert names["project"].status == "missing" and names["BigQuery checks"].status == "missing"


def test_bigquery_lines():
    expected = {"peoplevault_core.dim_employee": 1200, "peoplevault_marts.team_roster": 1199}
    sas = [f"peoplevault-er-reader@{PROJECT}.iam.gserviceaccount.com"]
    checks = bigquery_checks(FakeProbes(fail_sa={"peoplevault-er-reader"}, problems=["peoplevault_core.dim_employee: row access policy rap_full missing"],
                                        leftover=True, counts={"peoplevault_core.dim_employee": 1200, "peoplevault_marts.team_roster": 0}), PROJECT, expected, sas)
    assert [c.status for c in checks] == ["ok", "ok"] + ["missing"] * 4
    assert checks[1].name == "dataset access"
    assert checks[3].fix.startswith("uv run --project pipelines pv load --target prod")
    assert checks[4].fix.endswith("--cleanup") and checks[4].detail == "peoplevault_authz_probe still holds 3 probe view(s)"
    assert "zero rows in: peoplevault_marts.team_roster" in checks[5].detail
    after_deletions = bigquery_checks(FakeProbes(counts={"peoplevault_core.dim_employee": 1190, "peoplevault_marts.team_roster": 1199}), PROJECT, expected, sas)
    assert after_deletions[-1].status == "warn"
    loaded_twice = bigquery_checks(FakeProbes(counts={"peoplevault_core.dim_employee": 1200, "peoplevault_marts.team_roster": 1260}), PROJECT, expected, sas)
    assert loaded_twice[-1].status == "missing" and "above the seed counts" in loaded_twice[-1].detail


def test_catalog_check():
    assert catalog_check(FakeProbes(), ENV).status == "ok"
    assert catalog_check(FakeProbes(ns_error=True), ENV).status == "missing"
    c = catalog_check(FakeProbes(), {"PV_GCP_PROJECT": PROJECT})
    assert c.status == "missing" and "PV_R2_CATALOG_TOKEN" in c.detail



class NoDataChecks(FakeProbes):
    """Fails the test through the line list if any data check runs."""

    def impersonate(self, sa):
        raise AssertionError("no data check may run before setup is done")

    def controls(self):
        raise AssertionError("no data check may run before setup is done")

    def probe_dataset_leftovers(self):
        raise AssertionError("no data check may run before setup is done")


class Unreadable(NoDataChecks):
    def setup_steps(self):
        raise PermissionError("403 SERVICE_DISABLED")


def test_data_checks_wait_for_the_setup_steps():
    expected = {"peoplevault_core.dim_employee": 1200}
    for probes, first in [(Unreadable(), "setup state"), (NoDataChecks(steps=["enable apis: iam.googleapis.com"]), "service accounts, IAM, datasets, taxonomy, tags, data policies")]:
        checks = [c for c in bigquery_checks(probes, PROJECT, expected, []) if c.name != "dataset access"]
        assert [(c.name, c.status) for c in checks] == [(first, "missing"), ("BigQuery data checks", "missing")]
        assert checks[1].detail == "skipped until the setup steps above are done: impersonation, protected tables, probe dataset, data loaded"


def test_project_wide_dataset_access_is_its_own_line():
    steps = ["remove project-wide dataset access: peoplevault_core: READER specialGroup:projectReaders", "remove project-wide dataset access: peoplevault_raw: OWNER specialGroup:projectOwners"]
    checks = bigquery_checks(NoDataChecks(steps=steps), PROJECT, {"peoplevault_core.dim_employee": 1200}, [])
    line = next(c for c in checks if c.name == "dataset access")
    assert line.status == "missing" and line.detail.endswith("on: peoplevault_core, peoplevault_raw") and line.fix == "npm run setup:prod"
