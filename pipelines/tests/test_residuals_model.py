from datetime import UTC, datetime

from peoplevault.residuals.model import MODELED_LABEL, d1_time_travel_end, fail_safe_end, time_travel_end


def test_modeled_windows():
    t = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
    assert time_travel_end(t) == datetime(2026, 10, 12, 12, 0, tzinfo=UTC)  # 48 h
    assert fail_safe_end(t) == datetime(2026, 10, 19, 12, 0, tzinfo=UTC)  # + 7 days
    assert d1_time_travel_end(t) == datetime(2026, 11, 9, 12, 0, tzinfo=UTC)  # 30 days
    assert "modeled" in MODELED_LABEL


def test_executor_labels_bigquery_windows_as_modeled_locally():
    from peoplevault.executor.handlers import _modeled_bq

    tt, fs = _modeled_bq("pv_core.dim_employee", "wh.core", datetime(2026, 10, 10, tzinfo=UTC))
    assert (tt["kind"], tt["state"], tt["evidence"]) == ("bq_time_travel", "modeled", "modeled")
    assert (fs["kind"], fs["state"], fs["evidence"]) == ("bq_fail_safe", "modeled", "modeled")
    assert tt["expected_clear_at"].startswith("2026-10-12") and fs["expected_clear_at"].startswith("2026-10-19")
