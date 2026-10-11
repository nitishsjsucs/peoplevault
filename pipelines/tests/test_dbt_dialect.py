"""dbt models compile to both DuckDB and BigQuery, so dialect-specific functions go through dbt's cross-database
macros. DuckDB accepts `date_trunc('month', d)` but BigQuery's order is DATE_TRUNC(d, MONTH), and `dbt parse`
never validates SQL, so a bare call would pass every local check and fail `dbt build --target bigquery`."""

import re
from pathlib import Path

DBT = Path(__file__).resolve().parents[1] / "dbt"
BARE_DATE_TRUNC = re.compile(r"(?<![.\w])date_trunc\s*\(", re.I)


def _sql_files():
    return sorted(p for d in ("models", "macros", "snapshots") for p in (DBT / d).rglob("*.sql"))


def test_no_bare_date_trunc_in_models_macros_or_snapshots():
    offenders = [f"{p.relative_to(DBT)}:{i}" for p in _sql_files() for i, line in enumerate(p.read_text().splitlines(), 1) if BARE_DATE_TRUNC.search(line)]
    assert offenders == [], "use {{ dbt.date_trunc('<part>', '<expr>') }}"


def test_the_pattern_catches_the_duckdb_order_and_allows_the_macro():
    assert BARE_DATE_TRUNC.search("cast(date_trunc('month', c.pay_period_end) as date)")
    assert not BARE_DATE_TRUNC.search("cast({{ dbt.date_trunc('month', 'c.pay_period_end') }} as date)")
