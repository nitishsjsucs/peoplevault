"""The independent scanners find copies outside the registry: unregistered tables, a new schema, ad hoc Iceberg
tables and orphan files; boundary-aware matching never flags another employee's values."""

import duckdb
import pyarrow as pa
from executor_helpers import subject_payload
from synth_helpers import population

from peoplevault.executor.handlers import Subject
from peoplevault.lake.catalog import open_catalog
from peoplevault.verify.lake_scan import scan_lake_current, scan_lake_residuals
from peoplevault.verify.warehouse_scan import scan_warehouse
from peoplevault.warehouse.duck import DuckWarehouse


def _subject():
    pop = population()
    e_id = next(e for e in pop.ids()[100:] if pop.employees[e].termination_date is None)
    return e_id, Subject.from_payload({"subject": subject_payload(e_id)})


def test_finds_copies_in_unregistered_tables_and_a_new_schema(small_load):
    e_id, s = _subject()
    conn = duckdb.connect(str(small_load["duckdb"]))
    conn.execute("create table pv_core.tmp_backup_1 as select * from pv_core.dim_employee where employee_key = ?", [s.warehouse_key])
    conn.execute("create schema if not exists scratch")
    conn.execute("create table scratch.notes (body varchar)")
    conn.execute("insert into scratch.notes values (?)", [f"follow up with {s.work_email}."])
    conn.execute("insert into scratch.notes values ('brian.chen@peoplevault.test and Brian Chen')")
    conn.close()
    wh = DuckWarehouse.open(small_load["duckdb"])
    findings = scan_warehouse(wh, s.tokens())
    locs = {f.location: f.asset_id for f in findings}
    assert locs["pv_core.tmp_backup_1"] is None
    assert locs["scratch.notes"] is None
    assert locs["pv_core.dim_employee"] == "wh.core"
    assert locs["pv_raw.hris_employees"] == "wh.raw"


def test_finds_ad_hoc_iceberg_tables_and_orphan_files(small_load):
    _e, s = _subject()
    cat = open_catalog("local", root=small_load["lake"])
    cat.create_namespace("scratch")
    t = cat.create_table("scratch.adhoc", schema=pa.schema([("note", pa.string())]))
    t.append(pa.table({"note": [f"analytics {s.analytics_id} done"]}))
    found = {f.location: f.asset_id for f in scan_lake_current(cat, s.tokens())}
    assert found["scratch.adhoc"] is None
    assert found["hr_history.employee_monthly"] == "hist.lake.employee_monthly"
    # an orphaned data file (no retained snapshot references it) still holding the subject
    t.delete(delete_filter="note IS NOT NULL")
    t.maintenance.expire_snapshots().older_than(__import__("datetime").datetime.now(__import__("datetime").UTC)).commit()
    res = scan_lake_residuals(cat, s.tokens(), local_files=True)
    assert res["scratch.adhoc"].orphan_files_with_tokens
