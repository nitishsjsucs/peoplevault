"""score() is shared by the local and production eval profiles; a tiny hand-made run checks its arithmetic: coverage
over applicable pairs, oracle agreement, fault detection at the planted location, holds and a run without retention."""

import time

from peoplevault.evals.deletion import RunData, score
from peoplevault.evals.faults import Planted
from peoplevault.evals.oracle import OracleFindings, SubjectTokens


def tok(e: str, n: str) -> SubjectTokens:
    pad = n * 26
    return SubjectTokens(e, f"a.{n}@peoplevault.test", f"Ann {n.upper()}x", f"er_{pad}", f"wk_{pad}", f"an_{pad}", f"sr_{pad}")


def subject(e: str) -> dict:
    return {"employee_id": e, "export_rows": {"exports/hris/employees/dt=2026-09-28/employees.jsonl": 1}, "export_refs": {}, "hold_matter": None, "lake_rows": 0,
            "lake_ref_rows": 0, "lake_rows_after_retention_cutoff": 0, "lake_ref_rows_after_retention_cutoff": 0, "manager_id": None, "is_restricted": False,
            "status": "active", "role": "staff"}


def test_score_counts_pairs_faults_and_agreement_without_retention():
    tokens = {"E1": tok("E1", "b"), "E2": tok("E2", "c")}
    found = OracleFindings()
    found.add("E2", "kv", f"tmp:{tokens['E2'].employee_ref}", None)
    row = {"category": "source_exports", "action_status": "erased", "verify_matches": 0}
    d = RunData(
        profile="prod", run_header={"command": "x"}, t_start=time.time(), truth={"E1": subject("E1"), "E2": subject("E2")},
        cohorts={"R": [], "D": ["E1"], "H": [], "F": [{"subject": "E2", "store": "kv", "scenario": "kv.tmp_employee_ref"}]}, tokens=tokens,
        expected={"retention_expected": {"expired_export_keys": [], "minimized_export_keys": []}}, warmup=[], principal_of={},
        planted=[Planted("E2", "kv", "kv.tmp_employee_ref", "tmp:[redacted]")], submitted={"r1": "E1", "r2": "E2"},
        requests=[{"id": "r1", "kind": "dsr", "subject_ref": tokens["E1"].subject_ref, "status": "completed_with_residuals", "created_at": "2026-10-10T00:00:00Z", "completed_at": "2026-10-10T00:00:10Z"},
                  {"id": "r2", "kind": "dsr", "subject_ref": tokens["E2"].subject_ref, "status": "failed", "created_at": "2026-10-10T00:00:00Z", "completed_at": "2026-10-10T00:00:20Z"}],
        results=[{**row, "request_id": "r1", "asset_id": "src.r2.exports", "applicability": "present", "verify_status": "clean"},
                 {**row, "request_id": "r2", "asset_id": "unregistered:kv:tmp:[redacted]", "applicability": "unregistered", "verify_status": "residue"}],
        residual_rows=[{"request_id": "r1", "kind": "kv_propagation", "state": "cleared", "evidence": "modeled"}], found=found, retention_run=None,
        report_before={}, report={}, audit_ok={"ok": True, "length": 3}, warmup_counts={}, expire_out="", check_out="",
    )
    r = score(d)
    assert r["coverage"]["applicable_pairs"] == 1 and r["coverage"]["value"] == 1.0
    assert r["coverage"]["by_category"]["application_caches"]["display"] == "n/a"
    assert r["oracle"]["false_clean"] == 0 and r["oracle"]["agreement"] == 1.0
    assert r["faults"]["detected"] == 1 and r["faults"]["by_store"] == {"kv": {"detected": 1, "scenarios": 1}}
    assert r["retention"] == {"run": False}
    assert r["applicability_agreement"] == {"value": 1.0, "pairs": 1, "agree": 1, "disagreements": []}
    assert r["timing_ms"]["workflow_p50"] == 15000.0
    assert r["gate"]["checks"]["every_category_applicable"] is False and r["gate"]["passed"] is False


def _run(cohorts, truth, tokens, found, requests, planted=()):
    return RunData(
        profile="prod", run_header={"command": "x"}, t_start=time.time(), truth=truth, cohorts=cohorts, tokens=tokens,
        expected={"retention_expected": {"expired_export_keys": [], "minimized_export_keys": []}}, warmup=[], principal_of={},
        planted=list(planted), submitted={r["id"]: e for r, e in requests}, requests=[r for r, _ in requests], results=[], residual_rows=[], found=found,
        retention_run=None, report_before={}, report={}, audit_ok={"ok": True, "length": 3}, warmup_counts={}, expire_out="", check_out="",
    )


def _request(rid, t, status):
    return {"id": rid, "kind": "dsr", "subject_ref": t.subject_ref, "status": status, "created_at": "2026-10-10T00:00:00Z", "completed_at": None}


def test_a_bypassed_legal_hold_fails_the_gate():
    """H1's request stays held and its data is intact; H2's request ran and erased its data. Both the held request
    count and the intact count drop by one, so comparing them with each other alone would pass."""
    tokens = {"H1": tok("H1", "d"), "H2": tok("H2", "e")}
    truth = {e: {**subject(e), "hold_matter": "matter-1"} for e in tokens}
    found = OracleFindings()
    for store in ("r2", "warehouse", "d1"):
        found.add("H1", store, f"{store}:somewhere", "x")
    r = score(_run({"R": [], "R_held": [], "D": [], "H": ["H1", "H2"], "F": []}, truth, tokens, found,
                   [(_request("q1", tokens["H1"], "held"), "H1"), (_request("q2", tokens["H2"], "completed_with_residuals"), "H2")]))
    assert r["holds"] == {"held_requests": 1, "held_subjects": 2, "held_data_intact": 1, "expected_held_subjects": 2}
    assert r["coverage"]["applicable_pairs"] == 0  # the bypassed request is never scored as coverage
    assert r["gate"]["checks"]["holds_respected"] is False and r["gate"]["checks"]["held_data_intact"] is False
    assert r["gate"]["passed"] is False


def test_planned_faults_that_were_not_planted_fail_the_gate():
    tokens = {"E2": tok("E2", "c")}
    r = score(_run({"R": [], "R_held": [], "D": [], "H": [], "F": [{"subject": "E2", "store": "kv", "scenario": "kv.tmp_employee_ref"}]},
                   {"E2": subject("E2")}, tokens, OracleFindings(), [(_request("r2", tokens["E2"], "completed_with_residuals"), "E2")]))
    assert (r["faults"]["planned"], r["faults"]["scenarios"], r["faults"]["detected"]) == (1, 0, 0)
    assert r["gate"]["checks"]["all_faults_detected"] is False


def test_audit_chain_verification_follows_windows():
    """The eval verifies the chain window by window (50 events per request on Workers Free, SPEC.md 30.3.2 as amended)."""
    from peoplevault.evals.deletion import verify_audit_chain

    class Resp:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            return None

        def json(self):
            return self.body

    class Client:
        def __init__(self, total, break_anchor_at=None):
            self.total, self.break_anchor_at, self.paths = total, break_anchor_at, []

        def request(self, principal, method, path, body=None):
            self.paths.append(path)
            after = int(path.split("after_seq=")[1].split("&")[0])
            limit = int(path.split("limit=")[1])
            rows = list(range(after + 1, min(self.total, after + limit) + 1))
            anchor = f"h{after}" if after != self.break_anchor_at else "forged"
            return Resp({"ok": True, "anchorHash": anchor, "from": rows[0] if rows else None, "checked": len(rows), "lastHash": f"h{rows[-1]}" if rows else anchor,
                         "nextAfterSeq": rows[-1] if rows else after, "complete": after + limit >= self.total})

    c = Client(120)
    assert verify_audit_chain(c) == {"ok": True, "length": 120, "windows": 3, "window": 50}
    assert c.paths == ["/api/v1/privacy/audit/verify?after_seq=0&limit=50", "/api/v1/privacy/audit/verify?after_seq=50&limit=50", "/api/v1/privacy/audit/verify?after_seq=100&limit=50"]
    broken = verify_audit_chain(Client(250, break_anchor_at=100))
    assert broken["ok"] is False and broken["brokenAtSeq"] == 101
