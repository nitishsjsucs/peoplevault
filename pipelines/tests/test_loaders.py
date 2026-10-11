import json

import duckdb

from peoplevault import config
from peoplevault.dbtrun import run as dbt
from peoplevault.load import raw
from peoplevault.load.schema import create_all_duckdb
from peoplevault.pseudo import TEST_MASTER_KEY, Pseudonymizer
from peoplevault.sources.local_files import SourceObject

PS = Pseudonymizer(TEST_MASTER_KEY)


def _hris_object(rows, extra=None):
    out = []
    for r in rows:
        r = dict(r)
        if extra:
            r.update(extra)
        out.append(json.dumps(r))
    return SourceObject("exports/hris/employees/dt=2026-10-05/employees.jsonl", "hris", "2026-10-05", "\n".join(out) + "\n")


def _base_row(e_id, manager=None):
    return {
        "employee_id": e_id, "full_name": "Ada Abbott", "work_email": "ada.abbott@peoplevault.test", "personal_email": "x@example.test",
        "phone": "+1-555-0100", "birth_date": "1990-01-02", "gender": "female", "ethnicity": "group_a", "hire_date": "2020-01-01",
        "termination_date": None, "employment_status": "active", "job_title": "Software Engineer", "job_level": "IC2",
        "org_unit": "ENG-PRODUCT", "location": "Austin", "manager_employee_id": manager, "is_restricted": False, "export_date": "2026-10-05",
    }


def test_unknown_export_column_is_quarantined(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    conn = duckdb.connect(str(tmp_path / "w.duckdb"))
    create_all_duckdb(conn)
    obj = _hris_object([_base_row("E00042")], extra={"badge_photo": "secret-value"})
    report = raw.load_objects(conn, [obj], PS, set())
    assert report.quarantined == [obj.key] and report.objects_loaded == 0
    assert conn.execute("select count(*) from peoplevault_raw.hris_employees").fetchone()[0] == 0
    q = json.loads(next((tmp_path / "quarantine").glob("*.json")).read_text())
    assert q["unknown_columns"] == ["badge_photo"]
    assert "secret-value" not in json.dumps(q) and "E00042" not in json.dumps(q)


def test_missing_export_column_is_quarantined(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    conn = duckdb.connect(str(tmp_path / "w.duckdb"))
    create_all_duckdb(conn)
    row = _base_row("E00042")
    del row["phone"]
    report = raw.load_objects(conn, [_hris_object([row])], PS, set())
    assert report.objects_loaded == 0 and len(report.quarantined) == 1


def test_suppressed_rows_skipped_and_references_redacted(tmp_path):
    conn = duckdb.connect(str(tmp_path / "w.duckdb"))
    create_all_duckdb(conn)
    sup = {PS.pseudonym("subject_ref", "E00007")}
    obj = _hris_object([_base_row("E00007"), _base_row("E00008", manager="E00007"), _base_row("E00009", manager="E00008")])
    report = raw.load_objects(conn, [obj], PS, sup)
    assert report.rows_suppressed == 1 and report.references_redacted == 1
    rows = conn.execute("select employee_id, manager_employee_id, manager_key from peoplevault_raw.hris_employees order by 1").fetchall()
    assert rows == [("E00008", "REDACTED", "REDACTED"), ("E00009", "E00008", PS.pseudonym("warehouse_key", "E00008"))]
    # idempotent per object: loading the same object again replaces its rows
    raw.load_objects(conn, [obj], PS, sup)
    assert conn.execute("select count(*) from peoplevault_raw.hris_employees").fetchone()[0] == 2


def test_generic_test_flags_a_suppressed_subject_left_behind(small_load):
    """no_suppressed_subjects fails when a suppressed subject's rows survive in a protected model."""
    conn = duckdb.connect(str(small_load["duckdb"]))
    sref = conn.execute("select subject_ref from peoplevault_marts.attrition_features limit 1").fetchone()[0]
    conn.execute("insert into peoplevault_restricted.suppression values ($s, 'req-x', now())", {"s": sref})
    conn.close()
    assert not dbt(["test", "--target", "local", "--select", "attrition_features"]).success


def test_suppression_prevents_resurrection_after_reload(small_load):
    """Erase a subject by DML, add it to the suppression list, reload the raw exports and rebuild: it stays gone."""
    conn = duckdb.connect(str(small_load["duckdb"]))
    subject = conn.execute("select employee_key, subject_ref from peoplevault_core.dim_employee where manager_key is not null order by employee_key limit 1").fetchone()
    key, sref = subject
    for table, col in [("peoplevault_raw.hris_employees", "employee_key"), ("peoplevault_raw.payroll_compensation", "employee_key"), ("peoplevault_raw.leave_requests", "employee_key"),
                       ("peoplevault_raw.performance_reviews", "employee_key"), ("peoplevault_core.dim_employee", "employee_key"), ("peoplevault_core.fct_compensation", "employee_key"),
                       ("peoplevault_core.fct_leave", "employee_key"), ("peoplevault_core.fct_performance", "employee_key"), ("peoplevault_marts.team_roster", "employee_key"),
                       ("peoplevault_snapshots.dim_employee_history", "employee_key")]:
        conn.execute(f"delete from {table} where {col} = $k", {"k": key})
    conn.execute("delete from peoplevault_marts.attrition_features where subject_ref = $s", {"s": sref})
    conn.execute("insert into peoplevault_restricted.suppression values ($s, 'req-1', now())", {"s": sref})
    # a reload of the same exports with the suppression list applied
    from conftest import SMALL_KEYS

    from peoplevault.sources.local_files import iter_objects

    objs = [o for o in iter_objects(small_load["gen"]) if o.key in SMALL_KEYS]
    raw.load_objects(conn, objs, PS, {sref})
    conn.close()
    res = dbt(["build", "--target", "local"])
    assert res.success
    conn = duckdb.connect(str(small_load["duckdb"]))
    for table in ("peoplevault_core.dim_employee", "peoplevault_core.fct_compensation", "peoplevault_marts.team_roster", "peoplevault_marts.attrition_features"):
        assert conn.execute(f"select count(*) from {table} where subject_ref = $s", {"s": sref}).fetchone()[0] == 0, table
    assert conn.execute("select count(*) from peoplevault_raw.hris_employees where employee_key = $k", {"k": key}).fetchone()[0] == 0
