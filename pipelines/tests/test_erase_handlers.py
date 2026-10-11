"""Warehouse erase, reference scrubbing, the aggregate rebuild and Iceberg erase through the executor handlers."""

import duckdb
from executor_helpers import PS, assert_identifier_free, task
from synth_helpers import population

from peoplevault.dbtrun import run as dbt_run
from peoplevault.executor.handlers import ExecContext, handle_erase_batch, handle_identity_batch
from peoplevault.lake.catalog import EMPLOYEE_MONTHLY, open_catalog
from peoplevault.warehouse.duck import DuckWarehouse

PROTECTED = ["pv_raw.hris_employees", "pv_raw.payroll_compensation", "pv_raw.leave_requests", "pv_raw.performance_reviews", "pv_core.dim_employee",
             "pv_core.fct_compensation", "pv_core.fct_leave", "pv_core.fct_performance", "pv_snapshots.dim_employee_history", "pv_marts.team_roster"]


def _ctx(world):
    wh = DuckWarehouse.open(world["duckdb"])
    calls = []

    def dbt(args):
        calls.append(args)
        return dbt_run([*args, "--target", "local"]).success

    return ExecContext(wh=wh, catalog=open_catalog("local", root=world["lake"]), target="local", dbt=dbt), calls


def _pick(pop):
    """A line manager with active reports (none held) and one of those reports."""
    held = set(pop.held_subjects())
    for _unit, managers in sorted(pop.line_managers.items()):
        for m in managers:
            reports = [e for e in pop.ids() if pop.final(e).manager_id == m and pop.employees[e].termination_date is None]
            if reports and not any(r in held for r in reports) and m not in held:
                return m, reports
    raise AssertionError("no manager found")


def test_erase_batch_removes_rows_scrubs_references_rebuilds_and_erases_the_lake(small_load):
    pop = population()
    manager, reports = _pick(pop)
    ctx, dbt_calls = _ctx(small_load)
    tasks = [task(manager), task(reports[0])]
    results = handle_erase_batch(tasks, ctx)
    assert dbt_calls == [["build", "--select", "headcount_monthly"]]  # one aggregate rebuild per batch
    for t in tasks:
        ok, result = results[t.id]
        assert ok
        assert_identifier_free(result)
        by_id = {a["asset_id"]: a for a in result["assets"]}
        assert set(by_id) == {"wh.raw", "wh.core", "hist.dbt.dim_employee_history", "hist.lake.employee_monthly", "id.wh.identity_xref",
                              "drv.marts.attrition_features", "drv.marts.team_roster", "drv.marts.headcount_monthly"}
        for a in result["assets"]:
            assert a["verify_status"] in ("clean", "not_applicable"), (a["asset_id"], a["verify_status"])
        assert by_id["drv.marts.headcount_monthly"]["action_status"] == "recomputed"
        assert by_id["wh.raw"]["rows_erased"] > 0 and by_id["hist.lake.employee_monthly"]["rows_erased"] > 0
        kinds = {r["kind"] for r in result["residuals"]}
        assert {"iceberg_snapshots", "iceberg_orphan_files", "bq_time_travel", "bq_fail_safe"} <= kinds
        assert next(r for r in result["residuals"] if r["kind"] == "iceberg_snapshots")["state"] == "pending"
    mgr_result = results[tasks[0].id][1]
    assert next(a for a in mgr_result["assets"] if a["asset_id"] == "wh.raw")["references_scrubbed"] > 0
    conn = duckdb.connect(str(small_load["duckdb"]))
    wk = PS.pseudonym("warehouse_key", manager)
    for table in PROTECTED:
        key_col = "employee_id" if table.startswith("pv_raw") else "employee_key"
        val = manager if key_col == "employee_id" else wk
        assert conn.execute(f"select count(*) from {table} where {key_col} = ?", [val]).fetchone()[0] == 0, table
    assert conn.execute("select count(*) from pv_raw.hris_employees where manager_employee_id = ?", [manager]).fetchone()[0] == 0
    assert conn.execute("select count(*) from pv_raw.hris_employees where manager_employee_id = 'REDACTED'").fetchone()[0] > 0
    assert conn.execute("select count(*) from pv_core.dim_employee where manager_key = ?", [wk]).fetchone()[0] == 0
    sup = {r[0] for r in conn.execute("select subject_ref from pv_restricted.suppression").fetchall()}
    assert PS.pseudonym("subject_ref", manager) in sup
    lake = open_catalog("local", root=small_load["lake"]).load_table(EMPLOYEE_MONTHLY).scan().to_arrow()
    assert wk not in set(lake["employee_key"].to_pylist()) and wk not in set(lake["manager_key"].to_pylist())
    # identity phase removes the xref rows and verifies the whole warehouse again
    ok, idres = handle_identity_batch([task(manager, "identity")], ctx)[f"req-{manager}:identity"]
    assert ok and idres["assets"][0]["verify_status"] == "clean" and idres["assets"][0]["rows_erased"] == 1
    assert conn.execute("select count(*) from pv_restricted.identity_xref where employee_id = ?", [manager]).fetchone()[0] == 0


def test_hold_reference_conflict(small_load):
    """Scrubbing never modifies a held subject's rows; verification then finds the reference and reports residue."""
    pop = population()
    held = pop.held_subjects()
    held_active = next(h for h in held if pop.employees[h].termination_date is None)
    manager = pop.final(held_active).manager_id
    ctx, _ = _ctx(small_load)
    ok, result = handle_erase_batch([task(manager, held_refs=[PS.pseudonym("subject_ref", h) for h in held])], ctx)[f"req-{manager}:erase"]
    assert ok
    by_id = {a["asset_id"]: a for a in result["assets"]}
    assert by_id["wh.raw"]["verify_status"] == "residue"
    conn = duckdb.connect(str(small_load["duckdb"]))
    kept = conn.execute("select manager_employee_id from pv_raw.hris_employees where employee_id = ? limit 1", [held_active]).fetchone()
    assert kept == (manager,)


def test_retention_rows_skip_held_subjects(small_load):
    from executor_helpers import PS

    from peoplevault.executor.api import Task
    from peoplevault.executor.retention import handle_retention

    pop = population()
    held = pop.held_subjects()
    held_refs = [PS.pseudonym("subject_ref", h) for h in held]
    ctx, _ = _ctx(small_load)
    conn = duckdb.connect(str(small_load["duckdb"]))
    expected = conn.execute("select count(*) from pv_raw.hris_employees where export_date <= date '2026-09-21' and not list_contains(?, subject_ref)", [held_refs]).fetchone()[0]
    held_rows = conn.execute("select count(*) from pv_raw.hris_employees where export_date <= date '2026-09-21' and list_contains(?, subject_ref)", [held_refs]).fetchone()[0]
    conn.close()
    t = Task("run:rows", "retention", "executor_result_retention", "RETENTION", "run", None, "run",
             {"runId": "run", "asOf": "2026-09-30", "rawCutoffs": {"pv_raw.hris_employees": "2026-09-21"}, "lakeCutoff": "2025-06-30", "heldSubjectRefs": held_refs})
    ok, result = handle_retention(t, ctx)
    assert ok and result["counts"]["raw_rows_expired_hris_employees"] == expected > 0
    assert result["counts"]["lake_rows_expired_employee_monthly"] > 0
    conn = duckdb.connect(str(small_load["duckdb"]))
    assert conn.execute("select count(*) from pv_raw.hris_employees where export_date <= date '2026-09-21'").fetchone()[0] == held_rows
    lake = open_catalog("local", root=small_load["lake"]).load_table(EMPLOYEE_MONTHLY).scan().to_arrow()
    held_keys = {PS.pseudonym("warehouse_key", h) for h in held}
    rows = lake.to_pylist()
    assert all(r["employee_key"] in held_keys for r in rows if r["month"].isoformat() <= "2025-06-30")
    assert any(r["month"].isoformat() > "2025-06-30" for r in rows)
