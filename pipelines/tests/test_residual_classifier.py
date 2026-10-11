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


def test_production_check_classifies_live_errors():
    from peoplevault.residuals.check_prod import check_bq_residual

    class Err(Exception):
        def __init__(self, err):
            super().__init__(err["message"])
            self.errors = [err]

    class Wh:
        project = "pv-test"

        def __init__(self, err):
            self.err = err

        def query(self, sql, params=None):
            if self.err:
                raise Err(self.err)
            return [{"n": 3}]

    r = {"id": "r1", "kind": "bq_time_travel", "evidence": "observed", "detail_json": json.dumps({"table": "pv_core.dim_employee", "deleted_at": "2026-10-10T00:00:00+00:00"})}
    assert check_bq_residual(Wh(None), r) is None  # still readable: pending
    assert check_bq_residual(Wh(ERRORS["out_of_window"]), r)["state"] == "cleared"
    assert check_bq_residual(Wh(ERRORS["access_denied"]), r)["state"] == "error"
