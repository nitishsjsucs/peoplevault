"""`pv doctor gcp`: every line has a status and every non-ok line names its fix; nothing secret is echoed."""

import json

from peoplevault.setup.doctor_gcp import bigquery_checks, catalog_check, gcloud_checks, run_checks, to_json

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
        ("gcloud", "services", "list", "--enabled", "--project", PROJECT, "--format=json"): (0, json.dumps([{"config": {"name": a}} for a in [
            "bigquery.googleapis.com", "datacatalog.googleapis.com", "bigquerydatapolicy.googleapis.com", "iamcredentials.googleapis.com", "iam.googleapis.com"]])),
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

    def probe_dataset_exists(self):
        return self.leftover

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
    assert by["APIs"].status == "missing" and by["APIs"].fix.startswith("gcloud services enable ")
    for c in checks:
        assert c.status == "ok" or c.fix


def test_no_project_skips_bigquery(tmp_path):
    checks = run_checks(runner(), {}, FakeProbes(), adc(tmp_path))
    names = {c.name: c for c in checks}
    assert names["project"].status == "missing" and names["BigQuery checks"].status == "missing"


def test_bigquery_lines():
    expected = {"pv_core.dim_employee": 1200, "pv_marts.team_roster": 1199}
    sas = [f"pv-er-reader@{PROJECT}.iam.gserviceaccount.com"]
    checks = bigquery_checks(FakeProbes(steps=["create dataset: pv-test.pv_raw (US)"], fail_sa={"pv-er-reader"}, problems=["pv_core.dim_employee: row access policy rap_full missing"],
                                        leftover=True, counts={"pv_core.dim_employee": 1200, "pv_marts.team_roster": 0}), PROJECT, expected, sas)
    assert [c.status for c in checks] == ["missing"] * 5
    assert checks[2].fix.startswith("uv run --project pipelines pv load --target prod")
    assert checks[3].fix.endswith("--cleanup")
    assert "zero rows in: pv_marts.team_roster" in checks[4].detail
    after_deletions = bigquery_checks(FakeProbes(counts={"pv_core.dim_employee": 1190, "pv_marts.team_roster": 1199}), PROJECT, expected, sas)
    assert after_deletions[-1].status == "warn"


def test_catalog_check():
    assert catalog_check(FakeProbes(), ENV).status == "ok"
    assert catalog_check(FakeProbes(ns_error=True), ENV).status == "missing"
    c = catalog_check(FakeProbes(), {"PV_GCP_PROJECT": PROJECT})
    assert c.status == "missing" and "PV_R2_CATALOG_TOKEN" in c.detail
