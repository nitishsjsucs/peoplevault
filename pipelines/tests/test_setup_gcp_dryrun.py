"""Golden `pv setup gcp --dry-run` plans: an empty project gets every create step in order, a complete project gets
none, and applying the plan to an empty project converges (a second plan is empty)."""

from pathlib import Path

from fake_gcp import FakeGcp

from peoplevault.setup.gcp import apply, plan

GOLDEN = Path(__file__).parent / "golden" / "setup_gcp_empty_project.txt"


def _lines(steps):
    return [s.line() for s in steps]


def test_empty_project_plan_matches_golden():
    got = _lines(plan(FakeGcp(), "pv-test", "owner@example.test", gateway_key_recorded=False).steps)
    assert got == GOLDEN.read_text().splitlines()
    text = "\n".join(got)
    assert "create custom role: projects/pv-test/roles/pvTimeTravelReader (bigquery.rowAccessPolicies.overrideTimeTravelRestrictions)" in text
    assert "roles/bigquery.metadataViewer -> serviceAccount:pv-executor@pv-test.iam.gserviceaccount.com" in text
    assert "pv-executor@pv-test.iam.gserviceaccount.com: roles/iam.serviceAccountTokenCreator -> user:owner@example.test" in text
    assert "ALTER SCHEMA pv_core SET OPTIONS (max_time_travel_hours = 48)" in text
    assert text.count("create data masking policy") == 3


def test_complete_project_plan_has_no_create_steps():
    assert plan(FakeGcp(complete=True), "pv-test", "owner@example.test", gateway_key_recorded=True).steps == []


def test_apply_converges_and_records_tag_names():
    fake = FakeGcp()
    res = apply(fake, "pv-test", "owner@example.test", gateway_key_recorded=False)
    assert set(res.resources["policy_tags"]) == {"direct_identifier", "date_of_birth", "compensation", "performance", "health_leave", "protected_attribute"}
    assert res.resources["gateway_key"]
    assert plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=True).steps == []
    assert fake.calls.count("key") == 1
