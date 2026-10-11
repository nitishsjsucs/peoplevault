"""Lands source export objects in pv_raw (SPEC.md sections 8.2, 9.3).

- Unknown columns fail closed: the object is quarantined (a report with column names only, never values) and not
  loaded.
- The loader computes the keys dbt cannot (HMAC needs the master key): employee_key, manager_key or reviewer_key,
  subject_ref, plus the retention basis `export_date` and `_loaded_at`.
- Suppressed subjects' rows are skipped and references to them become REDACTED.
- Idempotent per object: rows with the object's export_date are replaced.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import pyarrow as pa

from peoplevault import config
from peoplevault.load.schema import EXPORT_FIELDS, FAMILY_TABLE, RAW_TABLES
from peoplevault.pseudo import Pseudonymizer
from peoplevault.sources.local_files import SourceObject

REDACTED = "REDACTED"
REFERENCE = {"hris": ("manager_employee_id", "manager_key"), "performance": ("reviewer_employee_id", "reviewer_key")}
ARROW = {"string": pa.string(), "date": pa.date32(), "timestamp": pa.timestamp("us"), "float": pa.float64(), "int": pa.int64(), "bool": pa.bool_()}


class QuarantineError(ValueError):
    pass


@dataclass
class LoadReport:
    objects_loaded: int = 0
    rows_loaded: dict[str, int] = field(default_factory=dict)
    rows_suppressed: int = 0
    references_redacted: int = 0
    quarantined: list[str] = field(default_factory=list)


def parse_rows(obj: SourceObject) -> list[dict]:
    if obj.key.endswith(".csv"):
        rows = list(csv.DictReader(io.StringIO(obj.body)))
        header = rows[0].keys() if rows else csv.reader(io.StringIO(obj.body)).__next__()
        _check_columns(obj, list(header))
        return rows
    rows = [json.loads(line) for line in obj.body.splitlines() if line.strip()]
    for r in rows:
        _check_columns(obj, list(r))
    return rows


def _check_columns(obj: SourceObject, cols: list[str]) -> None:
    allowed = set(EXPORT_FIELDS[obj.family])
    unknown = sorted(set(cols) - allowed)
    missing = sorted(allowed - set(cols))
    if unknown or missing:
        raise QuarantineError(json.dumps({"key": obj.key, "unknown_columns": unknown, "missing_columns": missing}))


def write_quarantine(report: str) -> Path:
    data = json.loads(report)
    target = config.DATA_DIR / "quarantine" / (data["key"].replace("/", "__") + ".json")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, indent=2) + "\n")
    return target


def transform(obj: SourceObject, rows: list[dict], ps: Pseudonymizer, suppressed: set[str], loaded_at: datetime, report: LoadReport) -> pa.Table:
    table = FAMILY_TABLE[obj.family]
    cols = RAW_TABLES[table]
    out: dict[str, list] = {c: [] for c, _ in cols}
    ref_cols = REFERENCE.get(obj.family)
    for r in rows:
        e_id = r["employee_id"]
        sref = ps.pseudonym("subject_ref", e_id)
        if sref in suppressed:
            report.rows_suppressed += 1
            continue
        rec = dict(r)
        rec["employee_key"] = ps.pseudonym("warehouse_key", e_id)
        rec["subject_ref"] = sref
        rec["export_date"] = obj.basis_date
        rec["_loaded_at"] = loaded_at
        if ref_cols:
            id_col, key_col = ref_cols
            ref = rec.get(id_col)
            if ref and ref != REDACTED and ps.pseudonym("subject_ref", ref) in suppressed:
                rec[id_col] = REDACTED
                report.references_redacted += 1
            ref = rec.get(id_col)
            rec[key_col] = None if not ref else (REDACTED if ref == REDACTED else ps.pseudonym("warehouse_key", ref))
        for c, t in cols:
            v = rec.get(c)
            if v == "" and t != "string":
                v = None
            if v is not None:
                if t == "date" and isinstance(v, str):
                    v = datetime.strptime(v, "%Y-%m-%d").date()
                elif t == "float":
                    v = float(v)
                elif t == "int":
                    v = int(v)
                elif t == "bool" and isinstance(v, str):
                    v = v.lower() == "true"
            out[c].append(v)
    return pa.table({c: pa.array(out[c], type=ARROW[t]) for c, t in cols})


def load_objects(conn, objects, ps: Pseudonymizer, suppressed: set[str]) -> LoadReport:
    report = LoadReport()
    loaded_at = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    for obj in objects:
        try:
            rows = parse_rows(obj)
        except QuarantineError as q:
            write_quarantine(str(q))
            report.quarantined.append(obj.key)
            continue
        arrow = transform(obj, rows, ps, suppressed, loaded_at, report)
        table = FAMILY_TABLE[obj.family]
        conn.execute("begin transaction")
        conn.execute(f"delete from {table} where export_date = cast($d as date)", {"d": obj.basis_date})
        conn.register("pv_incoming", arrow)
        conn.execute(f"insert into {table} select * from pv_incoming")
        conn.unregister("pv_incoming")
        conn.execute("commit")
        report.objects_loaded += 1
        report.rows_loaded[table] = report.rows_loaded.get(table, 0) + arrow.num_rows
    return report
