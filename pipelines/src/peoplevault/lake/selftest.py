"""`pv lake init --target prod` self-test (SPEC.md section 28): append, delete, overwrite and drop on a scratch table,
so pyiceberg commits against the Basin Catalog REST endpoint are proven before any real data is loaded."""

from __future__ import annotations

import pyarrow as pa
from pyiceberg.expressions import EqualTo

TABLE = "hr_history.pv_selftest"


def run_selftest(cat) -> dict:
    ns = TABLE.split(".")[0]
    if (ns,) not in cat.list_namespaces():
        cat.create_namespace(ns)
    if cat.table_exists(TABLE):
        cat.drop_table(TABLE)
    data = pa.table({"k": pa.array(["a", "b", "c"]), "v": pa.array(["1", "2", "3"])})
    t = cat.create_table(TABLE, schema=data.schema)
    t.append(data)
    t.delete(delete_filter=EqualTo("k", "b"))
    t.overwrite(pa.table({"k": pa.array(["c"]), "v": pa.array(["REDACTED"])}), overwrite_filter=EqualTo("k", "c"))
    rows = sorted((r["k"], r["v"]) for r in cat.load_table(TABLE).scan().to_arrow().to_pylist())
    cat.drop_table(TABLE)
    ok = rows == [("a", "1"), ("c", "REDACTED")]
    if not ok:
        raise RuntimeError("Iceberg self-test failed: append, delete or overwrite did not produce the expected rows")
    return {"selftest": "ok", "rows": rows}
