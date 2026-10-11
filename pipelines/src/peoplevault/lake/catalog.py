"""Iceberg catalogs. Local: pyiceberg SqlCatalog (SQLite) with a file warehouse, a stand-in that is never described
as Basin Catalog. Production: Basin Catalog (formerly R2 Data Catalog) through the Iceberg REST protocol."""

from __future__ import annotations

from typing import Literal

from pyiceberg.catalog import Catalog
from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import Schema
from pyiceberg.transforms import IdentityTransform
from pyiceberg.types import BooleanType, DateType, DoubleType, IntegerType, NestedField, StringType

from peoplevault import config

EMPLOYEE_MONTHLY = "hr_history.employee_monthly"

EMPLOYEE_MONTHLY_SCHEMA = Schema(
    NestedField(1, "month", DateType(), required=False),
    NestedField(2, "snapshot_year", IntegerType(), required=False),
    NestedField(3, "employee_key", StringType(), required=False),
    NestedField(4, "analytics_id", StringType(), required=False),
    NestedField(5, "org_unit", StringType(), required=False),
    NestedField(6, "job_level", StringType(), required=False),
    NestedField(7, "job_title", StringType(), required=False),
    NestedField(8, "manager_key", StringType(), required=False),
    NestedField(9, "employment_status", StringType(), required=False),
    NestedField(10, "base_salary", DoubleType(), required=False),
    NestedField(11, "is_restricted", BooleanType(), required=False),
)
EMPLOYEE_MONTHLY_SPEC = PartitionSpec(PartitionField(source_id=2, field_id=1000, transform=IdentityTransform(), name="snapshot_year"))


def open_catalog(target: Literal["local", "prod"], *, root=None) -> Catalog:
    if target == "local":
        lake = root or config.LAKE_DIR
        (lake / "warehouse").mkdir(parents=True, exist_ok=True)
        return SqlCatalog("local", uri=f"sqlite:///{lake / 'catalog.db'}", warehouse=f"file://{lake / 'warehouse'}")
    env = config.prod_env()
    missing = [k for k in ("PV_CATALOG_URI", "PV_CATALOG_WAREHOUSE", "PV_R2_CATALOG_TOKEN") if not env.get(k)]
    if missing:
        raise RuntimeError("Basin Catalog settings missing from .secrets/prod.env: " + ", ".join(missing))
    return RestCatalog("basin", uri=env["PV_CATALOG_URI"], warehouse=env["PV_CATALOG_WAREHOUSE"], token=env["PV_R2_CATALOG_TOKEN"])
