"""Independent warehouse scanner (SPEC.md section 14.3): every BASE TABLE in every dataset or schema the executor can
list, every string column. Exact equality on known identifier columns, boundary-aware RE2 regex elsewhere
(DuckDB regexp_matches, BigQuery REGEXP_CONTAINS). Imports nothing from executor, load or lake.ops (ADR 0003).
"""

from __future__ import annotations

from dataclasses import dataclass

from peoplevault.policy.model import policy
from peoplevault.verify.tokens import EXACT_COLUMNS, pattern_for

INTERNAL_SCHEMAS = {"information_schema", "pg_catalog"}


@dataclass(frozen=True)
class Finding:
    store: str
    location: str
    asset_id: str | None
    matches: int


def table_asset(table: str) -> str | None:
    for a in policy().assets:
        if a.store == "warehouse" and any(p.name == table for p in a.parts):
            return a.id
    return None


def redact(location: str, tokens: dict[str, str]) -> str:
    for token in tokens:
        location = location.replace(token, "[redacted]")
    return location


def _conditions(wh, cols: list[str], tokens: dict[str, str]) -> tuple[str, dict]:
    parts, params = [], {}
    i = 0
    for col in cols:
        q = f'"{col}"' if wh.dialect == "duckdb" else f"`{col}`"
        for token, kind in tokens.items():
            i += 1
            name = f"p{i}"
            if col in EXACT_COLUMNS:
                parts.append(f"{q} = ${name}" if wh.dialect == "duckdb" else f"{q} = @{name}")
                params[name] = token
            else:
                parts.append(f"regexp_matches({q}, ${name})" if wh.dialect == "duckdb" else f"REGEXP_CONTAINS({q}, @{name})")
                params[name] = pattern_for(kind, token)
    return " or ".join(parts), params


def scan_warehouse(wh, tokens: dict[str, str], *, exclude_tables: set[str] | None = None, datasets: list[str] | None = None) -> list[Finding]:
    """tokens: {token value: token kind}. Returns findings with token-free locations."""
    exclude = exclude_tables or set()
    ds = [d for d in (datasets or wh.list_datasets()) if d not in INTERNAL_SCHEMAS]
    findings = []
    for t in wh.list_base_tables(ds):
        if t.fqn in exclude:
            continue
        cols = wh.string_columns(t)
        if not cols:
            continue
        cond, params = _conditions(wh, cols, tokens)
        rel = f'"{t.dataset}"."{t.table}"' if wh.dialect == "duckdb" else f"`{t.dataset}.{t.table}`"
        n = wh.query(f"select count(*) as n from {rel} where {cond}", params)[0]["n"]
        if n:
            findings.append(Finding("warehouse", redact(t.fqn, tokens), table_asset(t.fqn), int(n)))
    return findings
