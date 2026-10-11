"""Iceberg residuals: retained snapshots and orphan files still hold an erased subject until local expiry and the
orphan purge; the token-free residual check clears them; production expiry is refused (ADR 0004)."""

import json
from datetime import UTC, datetime

import pytest
from executor_helpers import task
from synth_helpers import population

from peoplevault.executor.handlers import ExecContext, handle_erase_batch
from peoplevault.lake.catalog import EMPLOYEE_MONTHLY, open_catalog
from peoplevault.lake.ops import ProductionExpiryRefused, expire_and_purge
from peoplevault.residuals.check import check_lake_residual
from peoplevault.verify.lake_scan import scan_lake_residuals
from peoplevault.warehouse.duck import DuckWarehouse


def test_snapshots_and_orphans_hold_the_subject_until_expiry(small_load):
    pop = population()
    e_id = next(e for e in pop.ids()[50:] if pop.employees[e].termination_date is None and not pop.employees[e].is_manager)
    cat = open_catalog("local", root=small_load["lake"])
    ctx = ExecContext(wh=DuckWarehouse.open(small_load["duckdb"]), catalog=cat, target="local", dbt=lambda args: True)
    t = task(e_id)
    ok, result = handle_erase_batch([t], ctx)[t.id]
    assert ok
    snaps = next(r for r in result["residuals"] if r["kind"] == "iceberg_snapshots")
    orphans = next(r for r in result["residuals"] if r["kind"] == "iceberg_orphan_files")
    assert snaps["state"] == "pending" and snaps["retained_snapshots"] > 0
    assert orphans["state"] == "pending" and orphans["data_files"]
    from executor_helpers import subject_payload

    from peoplevault.executor.handlers import Subject

    tokens = Subject.from_payload({"subject": subject_payload(e_id)}).tokens()
    before = scan_lake_residuals(cat, tokens, local_files=True)
    assert before[EMPLOYEE_MONTHLY].snapshots_with_tokens
    rows = [{"id": f"r-{k}", "kind": r["kind"], "evidence": r["evidence"], "detail_json": json.dumps({"table": r["table"], "deleted_at": r["deleted_at"], "data_files": r.get("data_files", [])})} for k, r in enumerate([snaps, orphans])]
    assert [check_lake_residual(cat, r) for r in rows] == [None, None]  # still pending
    res = expire_and_purge(cat, EMPLOYEE_MONTHLY, datetime.now(UTC), target="local")
    assert res.snapshots_after == 1 and res.orphan_files_removed > 0
    assert scan_lake_residuals(cat, tokens, local_files=True) == {}
    cleared = [check_lake_residual(cat, r) for r in rows]
    assert [c["state"] for c in cleared] == ["cleared", "cleared"]


def test_production_expiry_refused(tmp_path):
    cat = open_catalog("local", root=tmp_path)
    with pytest.raises(ProductionExpiryRefused):
        expire_and_purge(cat, EMPLOYEE_MONTHLY, datetime.now(UTC), target="prod")


def test_naive_datetime_refused(tmp_path):
    with pytest.raises(ValueError, match="timezone-aware"):
        expire_and_purge(open_catalog("local", root=tmp_path), EMPLOYEE_MONTHLY, datetime.now(), target="local")
