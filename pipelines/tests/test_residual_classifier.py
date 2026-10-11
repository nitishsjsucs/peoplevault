"""Only the documented out-of-window time travel error clears a BigQuery residual; anything else is error."""

import json
from pathlib import Path

from peoplevault.residuals.bq import classify_time_travel_error, time_travel_count_sql

ERRORS = json.loads((Path(__file__).parent / "fixtures" / "bigquery" / "time_travel_errors.json").read_text())


def test_out_of_window_is_cleared():
    assert classify_time_travel_error(ERRORS["out_of_window"]).state == "cleared"


def test_success_is_pending():
    assert classify_time_travel_error(None).state == "pending"


def test_access_denied_and_others_are_errors_never_cleared():
    for key in ("access_denied", "not_found", "invalid_other"):
        c = classify_time_travel_error(ERRORS[key])
        assert c.state == "error", key


def test_probe_sql_is_token_free():
    sql = time_travel_count_sql("pv-test.pv_core.dim_employee", 1_791_000_000_000)
    assert sql == "SELECT COUNT(*) AS n FROM `pv-test.pv_core.dim_employee` FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS(1790999999000)"
