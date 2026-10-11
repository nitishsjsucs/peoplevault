import json

from peoplevault import config

GOLDEN = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())


def test_eight_export_objects_past_retention():
    r = GOLDEN["retention_expected"]
    assert r["export_objects_expired"] == 8
    assert r["expired_export_keys"] == [
        "exports/hris/employees/dt=2026-07-06/employees.jsonl",
        "exports/hris/employees/dt=2026-07-13/employees.jsonl",
        "exports/hris/employees/dt=2026-07-20/employees.jsonl",
        "exports/hris/employees/dt=2026-07-27/employees.jsonl",
        "exports/hris/employees/dt=2026-08-03/employees.jsonl",
        "exports/payroll/compensation/period=2025-10/compensation.csv",
        "exports/payroll/compensation/period=2025-11/compensation.csv",
        "exports/performance/reviews/cycle=2024H2/reviews.jsonl",
    ]
    assert r["export_objects_deleted"] + r["export_objects_minimized_for_hold"] == 8


def test_extracts_and_subject_requests():
    full, ci = GOLDEN["retention_expected"], GOLDEN["retention_expected_ci"]
    assert full["extracts_expired"] == 3 == ci["extracts_expired"]
    assert (full["retention_requests"], full["retention_held"]) == (70, 2)
    assert (ci["retention_requests"], ci["retention_held"]) == (10, 2)


def test_lake_rows_expired_positive():
    assert GOLDEN["retention_expected"]["lake_rows_expired_employee_monthly"] > 0
