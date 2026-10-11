"""Executor handlers (SPEC.md sections 8.5 and 14.2).

Erase batch: one warehouse transaction with every DML erase and reference scrub of wh.raw, wh.core, the snapshot,
attrition_features and team_roster (and the suppression append); then `dbt build --select headcount_monthly` (the only
rebuilt table); then one Iceberg transaction; then per-subject verification with the independent scanners; then
counts-only results. Reference scrubbing never modifies rows of held subjects (conservative, SPEC.md 8.8).
Identity batch: delete the subjects from peoplevault_restricted.identity_xref and verify the whole warehouse and lake again.
Results never carry identifiers: they hold asset ids, counts, enums, snapshot ids, timestamps and redacted locations.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from peoplevault.lake.catalog import EMPLOYEE_MONTHLY
from peoplevault.lake.ops import data_files, erase_subjects
from peoplevault.logging_redact import format_exception_redacted
from peoplevault.policy.model import policy
from peoplevault.verify.lake_scan import scan_lake_current
from peoplevault.verify.warehouse_scan import Finding, scan_warehouse

log = logging.getLogger("peoplevault.executor")
REDACTED = "REDACTED"
TIME_TRAVEL_HOURS = 48
FAIL_SAFE_DAYS = 7
XREF = "peoplevault_restricted.identity_xref"
ERASE_PHASE_EXCLUDE = {XREF}  # erased and verified in the identity phase


@dataclass
class Subject:
    employee_id: str
    work_email: str
    full_name: str
    employee_ref: str
    warehouse_key: str
    analytics_id: str
    subject_ref: str

    @classmethod
    def from_payload(cls, p: dict) -> Subject:
        s = p["subject"]
        return cls(s["employeeId"], s["workEmail"], s["fullName"], s["employeeRef"], s["warehouseKey"], s["analyticsId"], s["subjectRef"])

    def tokens(self) -> dict[str, str]:
        out = {
            self.employee_id: "employee_id", self.work_email: "work_email", self.employee_ref: "employee_ref",
            self.warehouse_key: "warehouse_key", self.analytics_id: "analytics_id",
        }
        if policy().verification.match_full_name:
            out[self.full_name] = "full_name"
        return out

    def value_for(self, column: str) -> str:
        if column in ("employee_id", "manager_employee_id", "reviewer_employee_id"):
            return self.employee_id
        if column == "analytics_id":
            return self.analytics_id
        return self.warehouse_key  # employee_key, manager_key, reviewer_key


@dataclass
class ExecContext:
    wh: object
    catalog: object
    target: str  # local | prod
    dbt: Callable[[list[str]], bool]
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    lake_tables: tuple[str, ...] = (EMPLOYEE_MONTHLY,)


@dataclass
class PartPlan:
    asset_id: str
    table: str
    subject_column: str
    reference_columns: list[str]


def warehouse_parts() -> list[PartPlan]:
    out = []
    for a in policy().assets:
        if a.store != "warehouse" or a.erase != "dml_delete" or a.id == "id.wh.identity_xref":
            continue
        for p in a.parts:
            out.append(PartPlan(a.id, p.name, a.subject_column or "employee_key", list(p.reference_columns)))
    return out


def _held(ctx: ExecContext, held_refs: list[str]) -> tuple[list[str], list[str]]:
    if not held_refs:
        return [], []
    rows = ctx.wh.query(f"select employee_id, employee_key from {XREF} where list_contains($r, subject_ref)" if ctx.wh.dialect == "duckdb" else f"select employee_id, employee_key from `{XREF}` where subject_ref in unnest(@r)", {"r": held_refs})
    return sorted(r["employee_id"] for r in rows), sorted(r["employee_key"] for r in rows)


def _not_protected(ctx: ExecContext, column: str) -> str:
    return f"not list_contains($held, {column})" if ctx.wh.dialect == "duckdb" else f"{column} not in unnest(@held)"


def _protected_values(part: PartPlan, held_ids: list[str], held_keys: list[str]) -> list[str]:
    if part.subject_column == "employee_id":
        return held_ids
    if part.subject_column == "analytics_id":
        return []
    return held_keys


def _rel(ctx: ExecContext, table: str) -> str:
    return table if ctx.wh.dialect == "duckdb" else f"`{table}`"


def plan_statements(ctx: ExecContext, s: Subject, request_id: str, held_ids: list[str], held_keys: list[str]) -> tuple[list[tuple[str, dict]], list[tuple[str, str, str]]]:
    """DML for one subject; the second list labels each statement (asset, table, kind) to attribute counts."""
    stmts: list[tuple[str, dict]] = []
    labels: list[tuple[str, str, str]] = []
    for part in warehouse_parts():
        rel = _rel(ctx, part.table)
        v = s.value_for(part.subject_column)
        stmts.append((f"delete from {rel} where {part.subject_column} = $v", {"v": v}))
        labels.append((part.asset_id, part.table, "rows"))
        prot = _protected_values(part, held_ids, held_keys)
        for col in part.reference_columns:
            stmts.append((
                f"update {rel} set {col} = '{REDACTED}' where {col} = $v and {_not_protected(ctx, part.subject_column)}",
                {"v": s.value_for(col), "held": prot or [""]},
            ))
            labels.append((part.asset_id, part.table, "refs"))
    sup = _rel(ctx, "peoplevault_restricted.suppression")
    stmts.append((
        f"insert into {sup} select $s, $r, current_timestamp where not exists (select 1 from {sup} where subject_ref = $s)",
        {"s": s.subject_ref, "r": request_id},
    ))
    labels.append(("suppression", "peoplevault_restricted.suppression", "append"))
    if ctx.wh.dialect == "bigquery":
        stmts = [(sql.replace("$", "@"), p) for sql, p in stmts]
    return stmts, labels


def _count_before(ctx: ExecContext, s: Subject, held_ids: list[str], held_keys: list[str]) -> dict[str, dict[str, dict[str, int]]]:
    out: dict[str, dict[str, dict[str, int]]] = {}
    for part in warehouse_parts():
        rel = _rel(ctx, part.table)
        n = ctx.wh.query(f"select count(*) as n from {rel} where {part.subject_column} = $v", {"v": s.value_for(part.subject_column)})[0]["n"]
        refs = 0
        prot = _protected_values(part, held_ids, held_keys)
        for col in part.reference_columns:
            refs += ctx.wh.query(f"select count(*) as n from {rel} where {col} = $v and {_not_protected(ctx, part.subject_column)}", {"v": s.value_for(col), "held": prot or [""]})[0]["n"]
        out.setdefault(part.asset_id, {})[part.table] = {"rows_before": int(n) + int(refs), "rows_erased": 0, "refs_scrubbed": 0}
    return out


def _asset_result(asset_id: str, parts: dict[str, dict[str, int]], findings: list[Finding], ok: bool = True) -> dict:
    before = sum(p["rows_before"] for p in parts.values())
    erased = sum(p["rows_erased"] for p in parts.values())
    refs = sum(p["refs_scrubbed"] for p in parts.values())
    mine = [f for f in findings if f.asset_id == asset_id]
    return {
        "asset_id": asset_id,
        "applicability": "present" if before > 0 else "not_present",
        "rows_before": before,
        "rows_erased": erased,
        "references_scrubbed": refs,
        "action_status": "erased" if ok else "failed",
        "verify_status": "residue" if mine else "clean",
        "verify_matches": sum(f.matches for f in mine),
        "parts": {t: {**p, "verify_matches": sum(f.matches for f in mine if f.location == t)} for t, p in parts.items()},
    }


def _modeled_bq(table: str, asset_id: str, deleted_at: datetime) -> list[dict]:
    tt_end = deleted_at + timedelta(hours=TIME_TRAVEL_HOURS)
    return [
        {"kind": "bq_time_travel", "asset_id": asset_id, "table": table, "state": "modeled", "evidence": "modeled",
         "deleted_at": deleted_at.isoformat(), "expected_clear_at": tt_end.isoformat()},
        {"kind": "bq_fail_safe", "asset_id": asset_id, "table": table, "state": "modeled", "evidence": "modeled",
         "deleted_at": deleted_at.isoformat(), "expected_clear_at": (tt_end + timedelta(days=FAIL_SAFE_DAYS)).isoformat()},
    ]


def _relative(path: str) -> str:
    marker = "/data/"
    return path.split(marker, 1)[1] if marker in path else path.rsplit("/", 1)[-1]


def handle_erase_batch(tasks: list, ctx: ExecContext) -> dict[str, tuple[bool, dict]]:
    """task id -> (ok, result). One warehouse transaction for the batch, one aggregate rebuild, one Iceberg commit."""
    subjects = {t.id: Subject.from_payload(t.payload) for t in tasks}
    held_refs = sorted({r for t in tasks for r in (t.payload.get("heldSubjectRefs") or [])})
    held_ids, held_keys = _held(ctx, held_refs)
    before = {tid: _count_before(ctx, s, held_ids, held_keys) for tid, s in subjects.items()}
    statements: list[tuple[str, dict]] = []
    labels: list[tuple[str, str, str, str]] = []
    for t in tasks:
        stmts, lbl = plan_statements(ctx, subjects[t.id], t.request_id or t.id, held_ids, held_keys)
        statements.extend(stmts)
        labels.extend((t.id, *x) for x in lbl)
    counts = ctx.wh.execute_script(statements)
    for (tid, asset_id, table, kind), n in zip(labels, counts, strict=True):
        if asset_id == "suppression":
            continue
        part = before[tid][asset_id][table]
        part["rows_erased" if kind == "rows" else "refs_scrubbed"] += int(n)
    deleted_at = ctx.now()
    rebuilt = ctx.dbt(["build", "--select", "headcount_monthly"])
    # Iceberg: one transaction for the batch
    keys = sorted(s.warehouse_key for s in subjects.values())
    lake_tbl = ctx.catalog.load_table(EMPLOYEE_MONTHLY)
    pre_snapshots = [(snap.snapshot_id, data_files(lake_tbl, snap.snapshot_id)) for snap in lake_tbl.snapshots()]
    commit = erase_subjects(ctx.catalog, EMPLOYEE_MONTHLY, keys, "manager_key", set(held_keys))

    results: dict[str, tuple[bool, dict]] = {}
    for tid, s in subjects.items():
        tokens = s.tokens()
        findings = scan_warehouse(ctx.wh, tokens, exclude_tables=ERASE_PHASE_EXCLUDE) + scan_lake_current(ctx.catalog, tokens)
        assets = [_asset_result(a, parts, findings) for a, parts in before[tid].items()]
        # lake asset: rows and references from the batch commit are attributed per subject by counting before/after
        lake_before = _lake_counts(pre_snapshots, lake_tbl, s)
        lake_mine = [f for f in findings if f.asset_id == "hist.lake.employee_monthly"]
        assets.append({
            "asset_id": "hist.lake.employee_monthly",
            "applicability": "present" if lake_before["rows"] + lake_before["refs"] > 0 else "not_present",
            "rows_before": lake_before["rows"] + lake_before["refs"],
            "rows_erased": lake_before["rows"],
            "references_scrubbed": lake_before["refs"],
            "action_status": "erased",
            "verify_status": "residue" if lake_mine else "clean",
            "verify_matches": sum(f.matches for f in lake_mine),
            "parts": {EMPLOYEE_MONTHLY: {"rows_before": lake_before["rows"] + lake_before["refs"], "rows_erased": lake_before["rows"], "refs_scrubbed": lake_before["refs"]}},
        })
        assets.append({
            "asset_id": "drv.marts.headcount_monthly", "applicability": "aggregate_recompute", "rows_before": 0, "rows_erased": 0,
            "references_scrubbed": 0, "action_status": "recomputed" if rebuilt else "failed", "verify_status": "not_applicable",
            "verify_matches": 0, "recomputed": bool(rebuilt),
        })
        xref_n = ctx.wh.query(f"select count(*) as n from {_rel(ctx, XREF)} where employee_id = $v", {"v": s.employee_id})[0]["n"]
        assets.append({"asset_id": "id.wh.identity_xref", "applicability": "present" if xref_n else "not_present", "rows_before": int(xref_n), "rows_erased": 0,
                       "references_scrubbed": 0, "action_status": "erased", "verify_status": "clean", "verify_matches": 0})
        residuals = lake_residuals(ctx, commit, pre_snapshots, lake_before, s, deleted_at)
        for a in assets:
            if a["asset_id"] in ("hist.lake.employee_monthly", "id.wh.identity_xref") or a["applicability"] == "not_present":
                continue
            for table in (a.get("parts") or {"peoplevault_marts.headcount_monthly": {}}):
                residuals.extend(bq_residuals(ctx, table, a["asset_id"], deleted_at, s))
        unregistered = [{"store": f.store, "location": f.location, "asset_id": None, "matches": f.matches} for f in findings if f.asset_id is None]
        registered = [{"store": f.store, "location": f.location, "asset_id": f.asset_id, "matches": f.matches} for f in findings if f.asset_id is not None]
        results[tid] = (bool(rebuilt), {"assets": assets, "findings": unregistered + registered, "residuals": residuals[:50], "counts": {"lake_rows_deleted_batch": commit.rows_deleted}})
    return results


def lake_residuals(ctx: ExecContext, commit, pre_snapshots, lake_before: dict, s: Subject, deleted_at: datetime) -> list[dict]:
    """Iceberg residuals. Local (SqlCatalog): observed retained snapshots and data files that held the subject. Production
    (Basin Catalog): retained snapshots observed; orphan files modeled, cleared by managed expiration (ADR 0004)."""
    if lake_before["rows"] + lake_before["refs"] == 0:
        return []
    snap_id = None if commit.last_snapshot_id is None else str(commit.last_snapshot_id)
    if ctx.target == "local":
        mine_files = [f for f in commit.files_with_subjects if _file_has_subject(f, s)]
        snaps_with = [sid for sid, files in pre_snapshots if files & set(mine_files)]
        return [
            {"kind": "iceberg_snapshots", "asset_id": "hist.lake.employee_monthly", "table": EMPLOYEE_MONTHLY, "state": "pending" if snaps_with else "cleared",
             "evidence": "observed", "deleted_at": deleted_at.isoformat(), "expected_clear_at": None, "snapshot_id": snap_id, "retained_snapshots": len(snaps_with)},
            {"kind": "iceberg_orphan_files", "asset_id": "hist.lake.employee_monthly", "table": EMPLOYEE_MONTHLY, "state": "pending" if mine_files else "cleared",
             "evidence": "observed", "deleted_at": deleted_at.isoformat(), "expected_clear_at": None, "snapshot_id": snap_id, "data_files": [_relative(f) for f in mine_files][:200]},
        ]
    clear = (deleted_at + timedelta(days=1)).isoformat()  # snapshot-expiration --older-than-days 1, plus an unknown maintenance interval
    return [
        {"kind": "iceberg_snapshots", "asset_id": "hist.lake.employee_monthly", "table": EMPLOYEE_MONTHLY, "state": "pending", "evidence": "observed",
         "deleted_at": deleted_at.isoformat(), "expected_clear_at": clear, "snapshot_id": snap_id, "retained_snapshots": len(pre_snapshots)},
        {"kind": "iceberg_orphan_files", "asset_id": "hist.lake.employee_monthly", "table": EMPLOYEE_MONTHLY, "state": "modeled", "evidence": "modeled",
         "deleted_at": deleted_at.isoformat(), "expected_clear_at": clear, "snapshot_id": snap_id},
    ]


def bq_residuals(ctx: ExecContext, table: str, asset_id: str, deleted_at: datetime, s: Subject) -> list[dict]:
    """Local: modeled from the BigQuery dataset setting (DuckDB has no time travel). Production: the time travel read
    right after the erase is observed (pending while the pre-deletion version is readable); fail-safe is modeled."""
    rows = _modeled_bq(table, asset_id, deleted_at)
    if ctx.wh.dialect != "bigquery":
        return rows
    from peoplevault.residuals.bq import time_travel_count_sql

    ms = int(deleted_at.timestamp() * 1000)
    try:
        n = int(ctx.wh.query(time_travel_count_sql(f"{ctx.wh.project}.{table}", ms))[0]["n"])
        rows[0].update({"state": "pending" if n else "cleared", "evidence": "observed", "rows_at_erase": n})
    except Exception:  # noqa: BLE001  (an unreadable history is an error, never cleared)
        rows[0].update({"state": "error", "evidence": "observed"})
    return rows


def _lake_counts(pre_snapshots, tbl, s: Subject) -> dict[str, int]:
    """Rows and references of the subject in the lake's state just before the batch commit (the last pre-commit snapshot)."""
    import pyarrow.compute as pc

    if not pre_snapshots:
        return {"rows": 0, "refs": 0}
    t = tbl.scan(snapshot_id=pre_snapshots[-1][0]).to_arrow()
    rows = int(pc.sum(pc.equal(t["employee_key"], s.warehouse_key)).as_py() or 0)
    refs = int(pc.sum(pc.equal(t["manager_key"], s.warehouse_key)).as_py() or 0)
    return {"rows": rows, "refs": refs}


def _file_has_subject(path: str, s: Subject) -> bool:
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    from peoplevault.lake.ops import _is_local, _local

    if not _is_local(path):
        return True
    t = pq.read_table(_local(path), columns=["employee_key", "manager_key"])
    return bool(pc.any(pc.or_(pc.fill_null(pc.equal(t["employee_key"], s.warehouse_key), False), pc.fill_null(pc.equal(t["manager_key"], s.warehouse_key), False))).as_py())


def handle_identity_batch(tasks: list, ctx: ExecContext) -> dict[str, tuple[bool, dict]]:
    subjects = {t.id: Subject.from_payload(t.payload) for t in tasks}
    rel = _rel(ctx, XREF)
    before = {tid: int(ctx.wh.query(f"select count(*) as n from {rel} where employee_id = $v", {"v": s.employee_id})[0]["n"]) for tid, s in subjects.items()}
    stmts = [(f"delete from {rel} where employee_id = $v", {"v": s.employee_id}) for s in subjects.values()]
    if ctx.wh.dialect == "bigquery":
        stmts = [(sql.replace("$", "@"), p) for sql, p in stmts]
    counts = ctx.wh.execute_script(stmts)
    deleted_at = ctx.now()
    results = {}
    for (tid, s), n in zip(subjects.items(), counts, strict=True):
        findings = scan_warehouse(ctx.wh, s.tokens()) + scan_lake_current(ctx.catalog, s.tokens())
        mine = [f for f in findings if f.asset_id == "id.wh.identity_xref"]
        asset = {
            "asset_id": "id.wh.identity_xref", "applicability": "present" if before[tid] else "not_present", "rows_before": before[tid],
            "rows_erased": int(n), "references_scrubbed": 0, "action_status": "erased", "verify_status": "residue" if mine else "clean",
            "verify_matches": sum(f.matches for f in mine),
        }
        unregistered = [{"store": f.store, "location": f.location, "asset_id": None, "matches": f.matches} for f in findings if f.asset_id is None]
        results[tid] = (True, {"assets": [asset], "findings": unregistered, "residuals": _modeled_bq(XREF, "id.wh.identity_xref", deleted_at) if before[tid] else [], "counts": {}})
    return results


def failure_result(exc: BaseException) -> dict:
    """Counts-only failure result (the error type only; messages could carry values)."""
    log.warning("executor batch failed: %s", format_exception_redacted(exc))
    return {"assets": [], "findings": [], "residuals": [], "counts": {}, "error": type(exc).__name__}


__all__ = ["ExecContext", "Subject", "failure_result", "handle_erase_batch", "handle_identity_batch"]
