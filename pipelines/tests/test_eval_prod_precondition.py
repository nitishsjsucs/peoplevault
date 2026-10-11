"""The production eval's start conditions (SPEC.md sections 19.1 and 30.3.4): no DSR yet, no request for its cohort
subjects, and room for its 12 requests in today's admission cap; the canary must complete before the rest run."""

import re

from peoplevault.evals.prod import canary_ok, precondition_problem

REFS = ["sr_" + "a" * 26, "sr_" + "b" * 26]


def fake_query(dsrs=0, cohort_hits=0, admitted=0):
    seen = []

    def query(sql):
        seen.append(sql)
        if "kind = 'dsr'" in sql:
            return [{"n": dsrs}]
        if "subject_ref IN" in sql:
            assert re.search(r"IN \('sr_a{26}', 'sr_b{26}'\)", sql)
            return [{"n": cohort_hits}]
        if "admitted_at >=" in sql:
            assert "'2026-10-11T00:00:00.000Z'" in sql
            return [{"n": admitted}]
        raise AssertionError(sql)

    return query, seen


def test_retention_requests_of_other_subjects_do_not_block():
    q, seen = fake_query()
    assert precondition_problem(q, REFS, 12, 16, "2026-10-11") is None
    assert len(seen) == 3


def test_any_dsr_blocks():
    q, _ = fake_query(dsrs=1)
    assert "before any data subject request" in precondition_problem(q, REFS, 12, 16, "2026-10-11")


def test_a_request_for_a_cohort_subject_blocks():
    q, _ = fake_query(cohort_hits=1)
    assert "cohort" in precondition_problem(q, REFS, 12, 16, "2026-10-11")


def test_the_requests_must_fit_today_s_admission_cap():
    q, _ = fake_query(admitted=5)
    assert "only 11 of today's 16" in precondition_problem(q, REFS, 12, 16, "2026-10-11")
    q, _ = fake_query(admitted=4)
    assert precondition_problem(q, REFS, 12, 16, "2026-10-11") is None
    q, _ = fake_query(admitted=500)
    assert precondition_problem(q, REFS, 12, None, "2026-10-11") is None


def test_malformed_subject_refs_never_reach_sql():
    q, seen = fake_query()
    assert precondition_problem(q, ["sr_x'); DROP TABLE x; --"], 12, None, "2026-10-11") is None
    assert not any("DROP" in s for s in seen)


def test_canary_must_complete():
    assert canary_ok("completed") and canary_ok("completed_with_residuals")
    assert not canary_ok("failed") and not canary_ok("held") and not canary_ok("running")
