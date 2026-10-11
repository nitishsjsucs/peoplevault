"""Named-query resolution for the shim (SPEC.md sections 12.2 and 15.7).

Only query ids from the compiled policy run, with typed, bound parameters, and a purpose may only read its own
peoplevault_purpose_<purpose> schema: the DuckDB emulation of BigQuery dataset IAM (one dataViewer grant per purpose SA).
"""

from __future__ import annotations

import json
import re
from datetime import date
from functools import lru_cache

from peoplevault import config


class ShimError(ValueError):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


@lru_cache(maxsize=1)
def compiled() -> dict:
    return json.loads((config.POLICY_DIR / "compiled" / "policy.json").read_text())


_SCHEMA_REF = re.compile(r"\b(pv_[a-z_]+)\.")


def resolve(purpose: str, query_id: str, params: dict) -> tuple[str, dict]:
    pol = compiled()
    if purpose not in pol["purposes"]:
        raise ShimError(404, "unknown_purpose")
    q = pol["queries"].get(query_id)
    if q is None:
        raise ShimError(404, "unknown_query")
    if q["purpose"] != purpose:
        raise ShimError(403, "purpose_dataset_denied")
    sql = q["sql"]["duckdb"]
    allowed = pol["purposes"][purpose]["dataset"]
    for schema in _SCHEMA_REF.findall(sql):
        if schema != allowed:
            raise ShimError(403, "purpose_dataset_denied")
    bound: dict[str, object] = {}
    expected = q["params"]
    if set(params) != set(expected):
        raise ShimError(400, "bad_params")
    for name, typ in expected.items():
        v = params[name]
        if typ == "string" and isinstance(v, str):
            bound[name] = v
        elif typ == "string_array" and isinstance(v, list) and all(isinstance(x, str) for x in v):
            bound[name] = v
        elif typ == "date" and isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            bound[name] = date.fromisoformat(v)
        elif typ == "int" and isinstance(v, int) and not isinstance(v, bool) and 0 < v <= 1000:
            bound[name] = v
        else:
            raise ShimError(400, "bad_params")
    return sql, bound


def jsonable(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        out.append({k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in r.items()})
    return out


def run_named(wh, purpose: str, query_id: str, params: dict) -> list[dict]:
    """The shim query function: also used by the warehouse-layer authorization cases."""
    sql, bound = resolve(purpose, query_id, params)
    return jsonable(wh.query(sql, bound))
