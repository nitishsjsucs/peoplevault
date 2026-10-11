"""DuckDB implementation of the Warehouse protocol (local stand-in for BigQuery; never described as BigQuery)."""

from __future__ import annotations

import re
import threading
from pathlib import Path

import duckdb

from peoplevault import config
from peoplevault.warehouse.base import TableRef

_PARAM = re.compile(r"@(\w+)")


def connect(path: Path | None = None, *, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    p = path or config.DUCKDB_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(p), read_only=read_only)


class DuckWarehouse:
    """Owns one DuckDB connection. Queries take $name or @name parameters; @name is rewritten to $name."""

    dialect = "duckdb"

    def __init__(self, conn: duckdb.DuckDBPyConnection):
        self.conn = conn
        self.lock = threading.RLock()

    @classmethod
    def open(cls, path: Path | None = None, *, read_only: bool = False) -> DuckWarehouse:
        return cls(connect(path, read_only=read_only))

    def _sql(self, sql: str) -> str:
        return _PARAM.sub(r"$\1", sql)

    def query(self, sql: str, params: dict[str, object] | None = None) -> list[dict]:
        with self.lock:
            cur = self.conn.cursor()
            try:
                cur.execute(self._sql(sql), params or {})
                cols = [d[0] for d in cur.description] if cur.description else []
                return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
            finally:
                cur.close()

    def execute_script(self, statements: list[tuple[str, dict]]) -> list[int]:
        """All statements in one transaction; returns the affected row count of each statement."""
        counts: list[int] = []
        with self.lock:
            cur = self.conn.cursor()
            try:
                cur.execute("begin transaction")
                for sql, params in statements:
                    cur.execute(self._sql(sql), params or {})
                    row = cur.fetchone() if cur.description else None
                    counts.append(int(row[0]) if row and isinstance(row[0], int) else 0)
                cur.execute("commit")
            except Exception:
                cur.execute("rollback")
                raise
            finally:
                cur.close()
        return counts

    def list_datasets(self) -> list[str]:
        rows = self.query("select schema_name from information_schema.schemata where catalog_name = current_database() order by 1")
        return [r["schema_name"] for r in rows if r["schema_name"] not in ("information_schema", "pg_catalog")]

    def list_base_tables(self, datasets: list[str]) -> list[TableRef]:
        if not datasets:
            return []
        rows = self.query(
            "select table_schema, table_name from information_schema.tables "
            "where table_type = 'BASE TABLE' and table_catalog = current_database() and list_contains($ds, table_schema) "
            "order by 1, 2",
            {"ds": datasets},
        )
        return [TableRef(r["table_schema"], r["table_name"]) for r in rows]

    def string_columns(self, table: TableRef) -> list[str]:
        rows = self.query(
            "select column_name from information_schema.columns where table_schema = $s and table_name = $t "
            "and data_type = 'VARCHAR' order by ordinal_position",
            {"s": table.dataset, "t": table.table},
        )
        return [r["column_name"] for r in rows]

    def time_travel_hours(self, dataset: str) -> int | None:
        return None

    def close(self) -> None:
        self.conn.close()
