"""Executor retention task (SPEC.md section 14.5 step 5): raw rows past retention (basis export_date, held subjects
skipped), lake rows past 84 months (held excluded), and locally the snapshot expiry and orphan purge. Counts only."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pyiceberg.expressions import And, In, LessThanOrEqual, Not

from peoplevault.executor.handlers import XREF, ExecContext, _rel
from peoplevault.lake.catalog import EMPLOYEE_MONTHLY
from peoplevault.lake.ops import expire_and_purge


def handle_retention(task, ctx: ExecContext) -> tuple[bool, dict]:
    p = task.payload or {}
    held_refs = list(p.get("heldSubjectRefs") or [])
    held_keys = [r["employee_key"] for r in ctx.wh.query(
        f"select employee_key from {_rel(ctx, XREF)} where list_contains($r, subject_ref)" if ctx.wh.dialect == "duckdb" else f"select employee_key from `{XREF}` where subject_ref in unnest(@r)",
        {"r": held_refs or [""]},
    )]
    stmts = []
    names = []
    for table, cutoff in sorted((p.get("rawCutoffs") or {}).items()):
        cond = "not list_contains($held, subject_ref)" if ctx.wh.dialect == "duckdb" else "subject_ref not in unnest(@held)"
        sql = f"delete from {_rel(ctx, table)} where export_date <= cast($cutoff as date) and {cond}"
        stmts.append((sql if ctx.wh.dialect == "duckdb" else sql.replace("$", "@"), {"cutoff": cutoff, "held": held_refs or [""]}))
        names.append(table.split(".", 1)[1])
    counts = ctx.wh.execute_script(stmts) if stmts else []
    out = {f"raw_rows_expired_{n}": int(c) for n, c in zip(names, counts, strict=True)}
    lake_cutoff = p.get("lakeCutoff")
    lake_rows = 0
    if lake_cutoff:
        tbl = ctx.catalog.load_table(EMPLOYEE_MONTHLY)
        cutoff_date = datetime.fromisoformat(lake_cutoff).date().isoformat()
        flt = LessThanOrEqual("month", cutoff_date)
        if held_keys:
            flt = And(flt, Not(In("employee_key", sorted(held_keys))))
        lake_rows = tbl.scan(row_filter=flt).to_arrow().num_rows
        if lake_rows:
            tbl.delete(delete_filter=flt)
    out["lake_rows_expired_employee_monthly"] = lake_rows
    if ctx.target == "local":
        res = expire_and_purge(ctx.catalog, EMPLOYEE_MONTHLY, datetime.now(UTC) - timedelta(seconds=0), target="local")
        out["lake_snapshots_expired"] = res.snapshots_before - res.snapshots_after
        out["lake_orphan_files_removed"] = res.orphan_files_removed
    return True, {"assets": [], "findings": [], "residuals": [], "counts": out}
