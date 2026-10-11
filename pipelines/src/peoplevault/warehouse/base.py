"""The Warehouse protocol used by the executor, the verifiers and the authz warehouse runner."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class TableRef:
    dataset: str
    table: str

    @property
    def fqn(self) -> str:
        return f"{self.dataset}.{self.table}"


class Warehouse(Protocol):
    dialect: Literal["duckdb", "bigquery"]

    def query(self, sql: str, params: dict[str, object] | None = None) -> list[dict]: ...

    def execute_script(self, statements: list[tuple[str, dict]]) -> list[int]: ...  # one transaction; affected rows

    def list_datasets(self) -> list[str]: ...

    def list_base_tables(self, datasets: list[str]) -> list[TableRef]: ...

    def string_columns(self, table: TableRef) -> list[str]: ...

    def time_travel_hours(self, dataset: str) -> int | None: ...  # None for duckdb
