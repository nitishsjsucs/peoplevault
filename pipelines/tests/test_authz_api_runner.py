"""`pv authz api` (P1 `npm run authz:prod`): the ground truth it derives from the generator matches what the warehouse's
purpose views serve, selectors mean what the fixture world means, and a case is skipped (with its reason) only when the
environment cannot run it. The live run against the local stack is `test_authz_api_local_stack` (marker e2e)."""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import duckdb
import pytest

from peoplevault import config
from peoplevault.authz import api_runner as ar
from peoplevault.authz.cases import load_cases
from peoplevault.pseudo import TEST_MASTER_KEY


@pytest.fixture(scope="module")
def pop(full_load):
    return ar.Population.load(full_load["gen"], TEST_MASTER_KEY)


def test_truth_values_match_the_purpose_views(full_load, pop):
    conn = duckdb.connect(str(full_load["duckdb"]))
    try:
        er = {r[0]: r[1:] for r in conn.execute("select employee_ref, full_name, work_email, base_salary, rating, birth_date from pv_purpose_employee_relations.employees").fetchall()}
        wa = {r[0]: r[1:] for r in conn.execute("select analytics_id, gender, birth_date from pv_purpose_workforce_analytics.employees").fetchall()}
    finally:
        conn.close()
    by_ref = {p.refs["employee_ref"]: p for p in pop.people.values()}
    by_an = {p.refs["analytics_id"]: p for p in pop.people.values()}
    assert len(er) > 1000 and len(wa) > 900
    for ref, (name, email, salary, rating, birth) in er.items():
        t = by_ref[ref].entry()["truth"]
        assert (name, email, salary, rating) == (t["full_name"], t["work_email"], t["base_salary"], t["rating"])
        assert str(birth) == f"{t['birth_date'][:4]}-01-01"
    for an, (gender, birth) in wa.items():
        t = by_an[an].entry()["truth"]
        assert gender == t["gender"] and str(birth) == f"{t['birth_date'][:4]}-01-01"


def test_selectors_mean_what_the_fixture_world_means(pop):
    res = ar.Resolver(pop, ar.LiveState({}))
    mgr = pop.principals["mgr-001"]["employee_id"]
    for p in res.scope("mgr-001", "direct_report", pick=False):
        assert p.manager_id == mgr and p.status == "active" and not p.is_restricted and not p.held
    for p in res.scope("mgr-001", "restricted_direct_report", pick=False):
        assert p.manager_id == mgr and p.is_restricted
    units = set(pop.principals["hrbp-01"]["org_units"])
    assert all(p.org_unit in units and not p.is_restricted for p in res.scope("hrbp-01", "in_unit", pick=False))
    assert all(p.org_unit not in units for p in res.scope("hrbp-01", "outside_unit", pick=False))
    assert all(p.status == "terminated" for p in res.scope("*", "terminated", pick=False))
    assert [p.employee_id for p in res.scope("mgr-001", "self", pick=True)] == [mgr]
    with pytest.raises(ar.Skip):
        res.scope("mgr-777", "direct_report", pick=True)


def test_picks_avoid_cohorts_retention_and_requested_subjects(pop):
    first = ar.Resolver(pop, ar.LiveState({})).scope("*", "active", pick=True)
    assert first and not ({p.employee_id for p in first} & pop.cohort_ids)
    assert all(not p.termination_date or p.termination_date > pop.retention_cutoff for p in ar.Resolver(pop, ar.LiveState({})).scope("*", "terminated", pick=True))
    taken = first[0]
    live = ar.LiveState({taken.refs["subject_ref"]: {"completed"}})
    res = ar.Resolver(pop, live)
    assert taken not in res.scope("*", "active", pick=True)
    assert taken not in res.scope("*", "active", pick=False)  # suppressed: the API no longer lists it
    assert res.deleted_in_scope("analyst-01", "workforce_analytics") == ([taken] if not taken.is_restricted else [])


class FakeResponse:
    def __init__(self, status: int, body: dict | None = None):
        self.status_code, self._body = status, body or {}

    def json(self):
        return self._body


def fake_env(responder) -> ar.Env:
    cc, pr = ar.compiled_policy()
    return ar.Env(lambda who, method, path, body, omit: responder(who, method, path, body, omit), lambda key: "", set(ar.TOKEN_PRINCIPALS), "executor", cc, pr)


def test_skips_name_their_reason_and_failures_are_counted(pop):
    cases = load_cases()

    def responder(who, method, path, body, omit):
        if path.startswith("/api/v1/privacy/audit"):
            return FakeResponse(200, {"events": [], "cursor": None})
        if path.endswith("/purposes/team_management/employees") and who == "hrbp-01":
            return FakeResponse(200, {"rows": []})  # a leak: B01 expects 403
        return FakeResponse(403, {"code": "purpose_not_permitted"})

    runner = ar.Runner(fake_env(responder), ar.Resolver(pop, ar.LiveState({})), allow_writes=False)
    out = runner.run_all(cases)
    reasons = {x["id"]: x["reason"] for x in out["skipped"]}
    assert reasons["A02"].startswith("forged") and reasons["A12"].startswith("forged")
    assert "mgr-003 has no token" in reasons["D05"] and "mgr-009 has no token" in reasons["G03"]
    assert {"F01", "F05", "F09"} <= set(reasons) and "--allow-writes" in reasons["F01"]
    assert "F02" not in reasons and "G01" not in reasons  # denied writes and the CSRF case write nothing, so they run
    failed = {x["id"]: x["reason"] for x in out["failed"]}
    assert failed["B01"] == "status 200, expected 403"
    assert "B02" in out["passed"]
    summary = ar.summarize(cases, out, {"command": "x", "date": "2026-10-10", "git_sha": "s", "git_dirty": False, "environment": "e"}, target="local", allow_writes=False)
    api = summary["layers"]["api"]
    assert api["runnable"] + api["skipped"] == 100 and api["passed"] + api["failed"] == api["runnable"]
    assert sum(summary["skip_reasons"].values()) == api["skipped"]


def test_executor_claim_case_leases_at_most_one_retention_task_briefly(pop):
    seen = []

    def responder(who, method, path, body, omit):
        seen.append((who, path, body))
        return FakeResponse(200, {"tasks": []})

    runner = ar.Runner(fake_env(responder), ar.Resolver(pop, ar.LiveState({})), allow_writes=False)
    a11 = next(c for c in load_cases() if c.id == "A11")
    runner.run_case(a11.raw)
    assert seen == [("executor", "/api/v1/executor/tasks/claim", {"phases": ["retention"], "max": 1, "lease_seconds": 30})]


def test_write_bodies_pass_the_api_schemas(pop):
    import re

    runner = ar.Runner(fake_env(lambda *a: FakeResponse(200)), ar.Resolver(pop, ar.LiveState({})), allow_writes=True)
    subject = ar.Resolver(pop, ar.LiveState({})).scope("*", "active", pick=True)[4]
    _, _, hold = runner.build({"action": "place_legal_hold", "purpose": "legal_hold_management"}, subject)
    assert re.fullmatch(r"[A-Z]{2}-\d{4}-\d{3}", hold["matter_id"])  # src/shared/api-schemas.ts LegalHoldBody
    assert re.fullmatch(r"er_[a-z2-7]{26}", hold["employee_ref"]) and 3 <= len(hold["reason"]) <= 200
    _, _, dsr = runner.build({"action": "create_deletion_request", "purpose": "privacy_compliance"}, subject)
    assert set(dsr) == {"employee_ref", "reason"}


@pytest.mark.e2e
def test_authz_api_local_stack():
    """Against the seeded local stack (npm run seed:local): every runnable case passes."""
    res = subprocess.run(["uv", "run", "--project", "pipelines", "pv", "authz", "api", "--target", "local", "--start", "--allow-writes"],
                         cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    assert res.returncode == 0, res.stdout[-2000:] + res.stderr[-2000:]
    assert "runnable cases passed" in res.stdout


def test_result_shape_is_readme_ready(pop):
    out = {"passed": ["B02"], "failed": [], "skipped": [{"id": "A02", "reason": "r"}]}
    cases = [c for c in load_cases() if c.id in {"B02", "A02"}]
    s = ar.summarize(cases, out, {"command": "npm run authz:prod", "date": "2026-10-10", "git_sha": "s", "git_dirty": False, "environment": "production"}, target="prod", allow_writes=True)
    assert s["kind"] == "authz" and s["layers"]["api"] == {**s["layers"]["api"], "runnable": 1, "passed": 1, "skipped": 1, "target": "prod", "allow_writes": True}
    assert json.loads(json.dumps(s)) == s
    assert SimpleNamespace(**s["by_category"]["A"]).skipped == 1
