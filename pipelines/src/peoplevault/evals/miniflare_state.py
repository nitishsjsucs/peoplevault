"""Reads R2 objects straight from Miniflare's local state, so the oracle depends neither on the product's key-listing
route nor on `wrangler r2 object get` (which cannot show custom metadata). Layout pinned to wrangler 4.149.0:

    .wrangler/state/v3/r2/miniflare-R2BucketObject/<hash>.sqlite   table _mf_objects(key, blob_id, ..., custom_metadata)
    .wrangler/state/v3/r2/<bucket>/blobs/<blob_id>                  object bodies

Fails loudly when the layout differs or when no object is found at all.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from peoplevault import config


class StateLayoutError(RuntimeError):
    pass


@dataclass(frozen=True)
class R2StateObject:
    bucket: str
    key: str
    body: bytes
    custom_metadata: dict


def r2_root(state_dir: Path | None = None) -> Path:
    return (state_dir or (config.REPO_ROOT / ".wrangler" / "state" / "v3")) / "r2"


def read_r2_objects(state_dir: Path | None = None, *, require_objects: bool = True) -> list[R2StateObject]:
    root = r2_root(state_dir)
    db_dir = root / "miniflare-R2BucketObject"
    if not db_dir.is_dir():
        raise StateLayoutError(f"Miniflare R2 layout not found under {root} (expected miniflare-R2BucketObject/)")
    buckets = [d for d in sorted(root.iterdir()) if d.is_dir() and d.name != "miniflare-R2BucketObject"]
    blob_dirs = {b.name: b / "blobs" for b in buckets}
    out: list[R2StateObject] = []
    for db in sorted(db_dir.glob("*.sqlite")):
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            tables = {r[0] for r in conn.execute("select name from sqlite_master where type = 'table'")}
            if "_mf_objects" not in tables:
                continue
            cols = {r[1] for r in conn.execute("pragma table_info(_mf_objects)")}
            if not {"key", "blob_id", "custom_metadata"} <= cols:
                raise StateLayoutError(f"unexpected _mf_objects columns in {db.name}: {sorted(cols)}")
            rows = conn.execute("select key, blob_id, custom_metadata from _mf_objects").fetchall()
        finally:
            conn.close()
        for key, blob_id, meta in rows:
            bucket = next((name for name, d in blob_dirs.items() if (d / blob_id).exists()), None)
            if bucket is None:
                raise StateLayoutError("an R2 object's blob was not found in any bucket blobs directory")
            out.append(R2StateObject(bucket, key, (blob_dirs[bucket] / blob_id).read_bytes(), json.loads(meta or "{}")))
    if require_objects and not out:
        raise StateLayoutError("no R2 objects found in Miniflare state; refusing to report anything as clean")
    return sorted(out, key=lambda o: (o.bucket, o.key))
