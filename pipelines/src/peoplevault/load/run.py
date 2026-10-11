"""`pv load --target local`: raw tables, identity xref, snapshot replay, dbt build, Iceberg (SPEC.md section 6.7 step 5)."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from peoplevault import config
from peoplevault.dbtrun import run as dbt
from peoplevault.lake.catalog import open_catalog
from peoplevault.load import identity, lake, raw, snapshots, suppression
from peoplevault.load.schema import create_all_duckdb
from peoplevault.pseudo import Pseudonymizer
from peoplevault.sources import local_files, wrangler_r2
from peoplevault.warehouse.duck import connect


def load_local(
    *,
    from_r2: bool = False,
    suppressed: set[str] | None = None,
    master_key: bytes | None = None,
    duckdb_path: Path | None = None,
    lake_root: Path | None = None,
    generated: Path | None = None,
    only_keys: set[str] | None = None,
    lake_years: set[int] | None = None,
) -> dict:
    import os

    key = master_key if master_key is not None else config.local_settings().master_key
    ps = Pseudonymizer(key)
    path = duckdb_path or config.DUCKDB_PATH
    os.environ["PV_DUCKDB_PATH"] = str(path)
    conn = connect(path)
    try:
        create_all_duckdb(conn)
        sup = suppression.from_d1_local() if suppressed is None else set(suppressed)
        synced = suppression.sync_duckdb(conn, sup)
        if from_r2:
            objects = list(wrangler_r2.iter_objects(remote=False))
        else:
            objects = list(local_files.iter_objects(generated))
        if only_keys is not None:
            objects = [o for o in objects if o.key in only_keys]
        hris_ids = sorted({line.split('"employee_id": "', 1)[1][:6] for o in objects if o.family == "hris" for line in o.body.splitlines() if line})
        xref = identity.upsert_xref(conn, hris_ids, ps, sup)
        report = raw.load_objects(conn, objects, ps, sup)
        hris_dates = [o.basis_date for o in objects if o.family == "hris"]
        through = snapshots.replayed_through_duckdb(conn)
        conn.execute("checkpoint")
        replays = snapshots.replay(hris_dates, replayed_through=through)
        build = dbt(["build", "--target", "local"])
        if not build.success:
            raise RuntimeError(f"dbt build failed ({build.exception})")
        cat = open_catalog("local", root=lake_root)
        hist = (generated / "history" / "employee_monthly") if generated else None
        lake_report = lake.load_employee_monthly(cat, ps, sup, hist, lake_years)
    finally:
        conn.close()
    return {"suppression_synced": synced, "identity_xref": xref, "raw": asdict(report), "snapshot_replays": len(replays), "lake": lake_report}
