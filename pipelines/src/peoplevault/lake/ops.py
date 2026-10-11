"""Iceberg erasure and (local only) expiry. Used by the executor, never by the verifiers (ADR 0003).

erase_subjects: one transaction per batch: copy-on-write delete of the subjects' rows, then a filtered overwrite of
rows whose reference column names a subject (set to REDACTED), never touching rows of protected (held) subjects.
expire_and_purge: pyiceberg expire_snapshots with timezone-aware cutoffs, then an explicit purge of data files no
retained snapshot references (pyiceberg leaves them behind). Refused for the production catalog (ADR 0004).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import pyarrow as pa
import pyarrow.compute as pc
from pyiceberg.catalog import Catalog
from pyiceberg.expressions import And, In, Not

REDACTED = "REDACTED"


class ProductionExpiryRefused(RuntimeError):
    pass


@dataclass
class LakeCommit:
    table: str
    first_snapshot_id: int | None
    last_snapshot_id: int | None
    committed_at_ms: int
    rows_deleted: int
    refs_scrubbed: int
    files_with_subjects: list[str] = field(default_factory=list)


def data_files(tbl, snapshot_id: int | None = None) -> set[str]:
    snap = tbl.snapshot_by_id(snapshot_id) if snapshot_id else tbl.current_snapshot()
    if snap is None:
        return set()
    return {task.file.file_path for task in tbl.scan(snapshot_id=snap.snapshot_id).plan_files()}


def files_containing(tbl, column: str, values: set[str]) -> list[str]:
    out = []
    for task in tbl.scan().plan_files():
        path = task.file.file_path
        t = pa.parquet.read_table(_local(path), columns=[column]) if _is_local(path) else None
        if t is not None and pc.any(pc.is_in(t[column], value_set=pa.array(sorted(values)))).as_py():
            out.append(path)
    return sorted(out)


def _is_local(path: str) -> bool:
    return path.startswith("file://") or path.startswith("/")


def _local(path: str) -> str:
    return urlparse(path).path if path.startswith("file://") else path


def erase_subjects(cat: Catalog, table: str, keys: list[str], scrub_column: str | None, protected_keys: set[str] | None = None) -> LakeCommit:
    import pyarrow.parquet  # noqa: F401  (registers pa.parquet)

    tbl = cat.load_table(table)
    protected = set(protected_keys or set())
    targets = sorted(set(keys) - protected)
    before = tbl.current_snapshot()
    first_id = before.snapshot_id if before else None
    current = tbl.scan().to_arrow()
    rows_deleted = int(pc.sum(pc.is_in(current["employee_key"], value_set=pa.array(targets))).as_py() or 0) if targets else 0
    to_scrub = None
    refs = 0
    if scrub_column and targets:
        mask = pc.and_(pc.is_in(current[scrub_column], value_set=pa.array(targets)), pc.invert(pc.is_in(current["employee_key"], value_set=pa.array(sorted(protected | set(targets)) or [""]))))
        to_scrub = current.filter(mask)
        refs = to_scrub.num_rows
    files = sorted(set(files_containing(tbl, "employee_key", set(targets))) | (set(files_containing(tbl, scrub_column, set(targets))) if scrub_column and targets else set())) if targets else []
    if rows_deleted == 0 and refs == 0:
        return LakeCommit(table, first_id, first_id, int(datetime.now(UTC).timestamp() * 1000), 0, 0, [])
    with tbl.transaction() as tx:
        if rows_deleted:
            tx.delete(delete_filter=In("employee_key", targets))
        if refs and to_scrub is not None:
            scrubbed = to_scrub.set_column(to_scrub.schema.get_field_index(scrub_column), scrub_column, pa.array([REDACTED] * to_scrub.num_rows, pa.string()))
            keys_to_rewrite = sorted(set(to_scrub["employee_key"].to_pylist()))
            tx.overwrite(scrubbed, overwrite_filter=And(In("employee_key", keys_to_rewrite), Not(In("employee_key", sorted(protected) or ["__none__"]))))
    tbl = cat.load_table(table)
    after = tbl.current_snapshot()
    return LakeCommit(table, first_id, after.snapshot_id if after else None, after.timestamp_ms if after else 0, rows_deleted, refs, files)


@dataclass
class ExpiryResult:
    table: str
    snapshots_before: int
    snapshots_after: int
    orphan_files_removed: int


def expire_and_purge(cat: Catalog, table: str, older_than: datetime, *, target: str) -> ExpiryResult:
    if target != "local":
        raise ProductionExpiryRefused("client-side snapshot expiry is refused for the Basin Catalog (ADR 0004); managed expiration cleans it")
    if older_than.tzinfo is None:
        raise ValueError("older_than must be timezone-aware (a naive datetime is read as UTC)")
    tbl = cat.load_table(table)
    before = len(tbl.snapshots())
    current = tbl.current_snapshot()
    if current is not None:
        expire = tbl.maintenance.expire_snapshots().older_than(older_than)
        expire.commit()
    tbl = cat.load_table(table)
    referenced: set[str] = set()
    for snap in tbl.snapshots():
        referenced |= data_files(tbl, snap.snapshot_id)
    removed = 0
    data_dir = Path(_local(tbl.location())) / "data"
    if data_dir.exists():
        for f in data_dir.rglob("*.parquet"):
            uri = f"file://{f}"
            if uri not in referenced and str(f) not in referenced:
                f.unlink()
                removed += 1
    return ExpiryResult(table, before, len(tbl.snapshots()), removed)
