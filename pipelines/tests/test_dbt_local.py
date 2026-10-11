"""dbt on the DuckDB stand-in: full build with the generic tests, golden counts, purpose views and macros."""

import json

import duckdb
import pyiceberg  # noqa: F401

from peoplevault import config
from peoplevault.dbtrun import run as dbt
from peoplevault.lake.catalog import EMPLOYEE_MONTHLY, open_catalog

GOLDEN = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())


def test_full_load_matches_golden_counts(full_load):
    conn = duckdb.connect(str(full_load["duckdb"]))
    for table, n in GOLDEN["warehouse"].items():
        assert conn.execute(f"select count(*) from {table}").fetchone()[0] == n, table
    assert full_load["result"]["raw"]["quarantined"] == []
    assert full_load["result"]["snapshot_replays"] == 13


def test_lake_matches_golden(full_load):
    tbl = open_catalog("local", root=full_load["lake"]).load_table(EMPLOYEE_MONTHLY)
    assert len(tbl.snapshots()) == GOLDEN["lake"]["employee_monthly"]["appends"] == 8
    assert tbl.scan().to_arrow().num_rows == GOLDEN["lake"]["employee_monthly"]["rows"]


def test_dbt_tests_pass_including_generic_tests(full_load):
    res = dbt(["test", "--target", "local"])
    assert res.success


def test_purpose_views_emulate_the_ceilings(full_load):
    conn = duckdb.connect(str(full_load["duckdb"]))
    tm = conn.execute("select count(*), count(base_salary), max(cast(is_restricted as int)) from peoplevault_purpose_team_management.employees "
                      "join peoplevault_core.dim_employee using (employee_ref)").fetchone()
    assert tm[0] > 0 and tm[1] == 0 and tm[2] == 0  # compensation nulled, restricted excluded
    er = conn.execute("select count(*) filter (where month(birth_date) <> 1 or day(birth_date) <> 1), count(leave_reason) "
                      "from peoplevault_purpose_employee_relations.employees").fetchone()
    assert er == (0, 0)  # birth date masked to January 1, health leave nulled
    wa_cols = [r[0] for r in conn.execute("describe peoplevault_purpose_workforce_analytics.employees").fetchall()]
    assert "full_name" not in wa_cols and "employee_ref" not in wa_cols and "gender" in wa_cols
    lookup = conn.execute("select count(*) from peoplevault_purpose_privacy_compliance.identity_lookup('a')").fetchone()[0]
    assert 0 < lookup <= 20


def test_second_build_after_dml_erase_does_not_bring_the_subject_back(small_load):
    conn = duckdb.connect(str(small_load["duckdb"]))
    key, sref = conn.execute("select employee_key, subject_ref from peoplevault_core.dim_employee order by employee_key limit 1").fetchone()
    for t in ("peoplevault_raw.hris_employees", "peoplevault_raw.payroll_compensation", "peoplevault_raw.leave_requests", "peoplevault_raw.performance_reviews",
              "peoplevault_core.dim_employee", "peoplevault_core.fct_compensation", "peoplevault_core.fct_leave", "peoplevault_core.fct_performance", "peoplevault_marts.team_roster",
              "peoplevault_snapshots.dim_employee_history"):
        conn.execute(f"delete from {t} where employee_key = $k", {"k": key})
    conn.execute("delete from peoplevault_marts.attrition_features where subject_ref = $s", {"s": sref})
    conn.close()
    assert dbt(["build", "--target", "local"]).success
    conn = duckdb.connect(str(small_load["duckdb"]))
    for t in ("peoplevault_core.dim_employee", "peoplevault_core.fct_compensation", "peoplevault_marts.team_roster", "peoplevault_marts.attrition_features", "peoplevault_snapshots.dim_employee_history"):
        assert conn.execute(f"select count(*) from {t} where subject_ref = $s", {"s": sref}).fetchone()[0] == 0, t


def test_a_second_load_does_not_replay_old_exports_into_the_history(small_load):
    """`pv load` is a normal recovery path (setup:prod re-runs seed:prod), so the snapshot replay must be idempotent:
    replaying an older export against the current rows would add backward-in-time SCD2 versions, and in production
    the merge-only snapshot could not be repaired."""
    from peoplevault.load.run import load_local
    from peoplevault.pseudo import TEST_MASTER_KEY

    q = "select count(*), max(n) from (select employee_key, count(*) as n from peoplevault_snapshots.dim_employee_history group by 1)"
    conn = duckdb.connect(str(small_load["duckdb"]))
    before = conn.execute(q).fetchone()
    before_total = conn.execute("select count(*) from peoplevault_snapshots.dim_employee_history").fetchone()[0]
    conn.close()
    from conftest import SMALL_KEYS

    again = load_local(suppressed=set(), master_key=TEST_MASTER_KEY, duckdb_path=small_load["duckdb"], lake_root=small_load["lake"],
                       generated=small_load["gen"], only_keys=SMALL_KEYS, lake_years={2025, 2026})
    conn = duckdb.connect(str(small_load["duckdb"]))
    before_rows, after_rows = before_total, conn.execute("select count(*) from peoplevault_snapshots.dim_employee_history").fetchone()[0]
    after = conn.execute(q).fetchone()
    assert (after_rows, after) == (before_rows, before)
    assert again["snapshot_replays"] == 0
