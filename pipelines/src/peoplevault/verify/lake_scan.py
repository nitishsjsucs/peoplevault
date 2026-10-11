"""Independent Iceberg scanner (SPEC.md section 14.3): the current snapshot of every table in every namespace, every
string column; and residuals: every retained snapshot, and locally every Parquet file under a table location that no
retained snapshot references. Imports nothing from executor, load or lake.ops (ADR 0003)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import pyarrow as pa
import pyarrow.parquet as pq

from peoplevault.policy.model import policy
from peoplevault.verify.tokens import EXACT_COLUMNS, pattern_for
from peoplevault.verify.warehouse_scan import Finding, redact


def table_asset(table: str) -> str | None:
    for a in policy().assets:
        if a.store == "iceberg" and any(p.name == table for p in a.parts):
            return a.id
    return None


def _all_tables(cat) -> list[str]:
    out = []
    for ns in cat.list_namespaces():
        for ident in cat.list_tables(ns):
            out.append(".".join(ident))
    return sorted(out)


def count_in_arrow(t: pa.Table, tokens: dict[str, str]) -> int:
    """Rows of `t` matching any token: exact equality on identifier columns, boundary-aware regex elsewhere
    (vectorized prefilter with a substring search, regex only on candidate values)."""
    import pyarrow.compute as pc

    if t.num_rows == 0 or not tokens:
        return 0
    patterns = {tok: re.compile(pattern_for(kind, tok)) for tok, kind in tokens.items()}
    hit = pa.array([False] * t.num_rows)
    for name in t.column_names:
        typ = t.schema.field(name).type
        if not (pa.types.is_string(typ) or pa.types.is_large_string(typ)):
            continue
        col = t[name].combine_chunks()
        if name in EXACT_COLUMNS:
            hit = pc.or_(hit, pc.fill_null(pc.is_in(col, value_set=pa.array(sorted(tokens))), False))
            continue
        for tok, pat in patterns.items():
            cand = pc.fill_null(pc.match_substring(col, tok), False)
            if not pc.any(cand).as_py():
                continue
            values = col.to_pylist()
            flags = [bool(c) and v is not None and pat.search(v) is not None for c, v in zip(cand.to_pylist(), values, strict=True)]
            hit = pc.or_(hit, pa.array(flags))
    return int(pc.sum(pc.cast(hit, pa.int64())).as_py() or 0)


def scan_lake_current(cat, tokens: dict[str, str]) -> list[Finding]:
    findings = []
    for name in _all_tables(cat):
        tbl = cat.load_table(name)
        if tbl.current_snapshot() is None:
            continue
        n = count_in_arrow(tbl.scan().to_arrow(), tokens)
        if n:
            findings.append(Finding("iceberg", redact(name, tokens), table_asset(name), n))
    return findings


@dataclass
class LakeResidual:
    table: str
    snapshots_with_tokens: list[int] = field(default_factory=list)
    orphan_files_with_tokens: list[str] = field(default_factory=list)


def _local(path: str) -> Path:
    return Path(urlparse(path).path if path.startswith("file://") else path)


def scan_lake_residuals(cat, tokens: dict[str, str], local_files: bool) -> dict[str, LakeResidual]:
    out: dict[str, LakeResidual] = {}
    for name in _all_tables(cat):
        tbl = cat.load_table(name)
        res = LakeResidual(name)
        current = tbl.current_snapshot()
        referenced: set[str] = set()
        for snap in tbl.snapshots():
            files = {t.file.file_path for t in tbl.scan(snapshot_id=snap.snapshot_id).plan_files()}
            referenced |= files
            if current is not None and snap.snapshot_id == current.snapshot_id:
                continue
            if count_in_arrow(tbl.scan(snapshot_id=snap.snapshot_id).to_arrow(), tokens):
                res.snapshots_with_tokens.append(snap.snapshot_id)
        if local_files:
            data_dir = _local(tbl.location()) / "data"
            if data_dir.exists():
                for f in sorted(data_dir.rglob("*.parquet")):
                    if f"file://{f}" in referenced or str(f) in referenced:
                        continue
                    if count_in_arrow(pq.read_table(f), tokens):
                        res.orphan_files_with_tokens.append(str(f.relative_to(data_dir)))
        if res.snapshots_with_tokens or res.orphan_files_with_tokens:
            out[name] = res
    return out
