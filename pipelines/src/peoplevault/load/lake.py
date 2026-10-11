"""Iceberg hr_history.employee_monthly: 93 months written as 8 appends, one per year (SPEC.md section 9.4)."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pyarrow as pa
from pyiceberg.catalog import Catalog
from pyiceberg.exceptions import NamespaceAlreadyExistsError, NoSuchTableError

from peoplevault import config
from peoplevault.lake.catalog import EMPLOYEE_MONTHLY, EMPLOYEE_MONTHLY_SCHEMA, EMPLOYEE_MONTHLY_SPEC
from peoplevault.pseudo import Pseudonymizer

REDACTED = "REDACTED"


def ensure_table(cat: Catalog):
    ns = EMPLOYEE_MONTHLY.split(".")[0]
    try:
        cat.create_namespace(ns)
    except NamespaceAlreadyExistsError:
        pass
    try:
        return cat.load_table(EMPLOYEE_MONTHLY)
    except NoSuchTableError:
        return cat.create_table(EMPLOYEE_MONTHLY, schema=EMPLOYEE_MONTHLY_SCHEMA, partition_spec=EMPLOYEE_MONTHLY_SPEC)


def year_rows(path: Path, ps: Pseudonymizer, suppressed: set[str]) -> pa.Table:
    cols: dict[str, list] = {f.name: [] for f in EMPLOYEE_MONTHLY_SCHEMA.fields}
    for line in path.read_text().splitlines():
        r = json.loads(line)
        if ps.pseudonym("subject_ref", r["employee_id"]) in suppressed:
            continue
        mgr = r["manager_employee_id"]
        mgr_key = None if not mgr else (REDACTED if ps.pseudonym("subject_ref", mgr) in suppressed else ps.pseudonym("warehouse_key", mgr))
        cols["month"].append(date.fromisoformat(r["month"]))
        cols["snapshot_year"].append(int(r["snapshot_year"]))
        cols["employee_key"].append(ps.pseudonym("warehouse_key", r["employee_id"]))
        cols["analytics_id"].append(ps.pseudonym("analytics_id", r["employee_id"]))
        cols["org_unit"].append(r["org_unit"])
        cols["job_level"].append(r["job_level"])
        cols["job_title"].append(r["job_title"])
        cols["manager_key"].append(mgr_key)
        cols["employment_status"].append(r["employment_status"])
        cols["base_salary"].append(float(r["base_salary"]))
        cols["is_restricted"].append(bool(r["is_restricted"]))
    return pa.table({
        "month": pa.array(cols["month"], pa.date32()), "snapshot_year": pa.array(cols["snapshot_year"], pa.int32()),
        "employee_key": pa.array(cols["employee_key"], pa.string()), "analytics_id": pa.array(cols["analytics_id"], pa.string()),
        "org_unit": pa.array(cols["org_unit"], pa.string()), "job_level": pa.array(cols["job_level"], pa.string()),
        "job_title": pa.array(cols["job_title"], pa.string()), "manager_key": pa.array(cols["manager_key"], pa.string()),
        "employment_status": pa.array(cols["employment_status"], pa.string()), "base_salary": pa.array(cols["base_salary"], pa.float64()),
        "is_restricted": pa.array(cols["is_restricted"], pa.bool_()),
    })


def load_employee_monthly(cat: Catalog, ps: Pseudonymizer, suppressed: set[str], history_dir: Path | None = None) -> dict:
    """Appends each year once. A table that already has snapshots is left unchanged (idempotent re-runs)."""
    tbl = ensure_table(cat)
    if tbl.current_snapshot() is not None:
        return {"appended_years": [], "skipped": "table already loaded", "snapshots": len(tbl.snapshots())}
    base = history_dir or (config.GENERATED_DIR / "history" / "employee_monthly")
    years = []
    rows = 0
    for f in sorted(base.glob("year=*.jsonl")):
        data = year_rows(f, ps, suppressed)
        tbl.append(data)
        years.append(int(f.stem.split("=")[1]))
        rows += data.num_rows
    tbl = cat.load_table(EMPLOYEE_MONTHLY)
    return {"appended_years": years, "rows": rows, "snapshots": len(tbl.snapshots())}
