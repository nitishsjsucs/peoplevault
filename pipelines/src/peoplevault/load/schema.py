"""Column definitions of the tables the loaders own (pv_raw and pv_restricted), for both dialects.

Types are logical: string, date, timestamp, float, int, bool. The loader adds the keys it computes
(employee_key, manager_key or reviewer_key, subject_ref), the retention basis `export_date` and `_loaded_at`.
"""

from __future__ import annotations

RAW_TABLES: dict[str, list[tuple[str, str]]] = {
    "pv_raw.hris_employees": [
        ("employee_id", "string"), ("full_name", "string"), ("work_email", "string"), ("personal_email", "string"),
        ("phone", "string"), ("birth_date", "date"), ("gender", "string"), ("ethnicity", "string"), ("hire_date", "date"),
        ("termination_date", "date"), ("employment_status", "string"), ("job_title", "string"), ("job_level", "string"),
        ("org_unit", "string"), ("location", "string"), ("manager_employee_id", "string"), ("is_restricted", "bool"),
        ("export_date", "date"), ("employee_key", "string"), ("manager_key", "string"), ("subject_ref", "string"),
        ("_loaded_at", "timestamp"),
    ],
    "pv_raw.payroll_compensation": [
        ("employee_id", "string"), ("pay_period_end", "date"), ("base_salary", "float"), ("bonus_target_pct", "float"),
        ("currency", "string"), ("employee_key", "string"), ("subject_ref", "string"), ("export_date", "date"),
        ("_loaded_at", "timestamp"),
    ],
    "pv_raw.leave_requests": [
        ("leave_id", "string"), ("employee_id", "string"), ("start_date", "date"), ("end_date", "date"), ("leave_type", "string"),
        ("leave_category", "string"), ("leave_reason", "string"), ("accommodation_note", "string"), ("status", "string"),
        ("employee_key", "string"), ("subject_ref", "string"), ("export_date", "date"), ("_loaded_at", "timestamp"),
    ],
    "pv_raw.performance_reviews": [
        ("review_id", "string"), ("employee_id", "string"), ("cycle", "string"), ("rating", "int"), ("review_text", "string"),
        ("reviewer_employee_id", "string"), ("employee_key", "string"), ("reviewer_key", "string"), ("subject_ref", "string"),
        ("export_date", "date"), ("_loaded_at", "timestamp"),
    ],
}

RESTRICTED_TABLES: dict[str, list[tuple[str, str]]] = {
    "pv_restricted.identity_xref": [
        ("employee_id", "string"), ("employee_key", "string"), ("employee_ref", "string"), ("analytics_id", "string"),
        ("subject_ref", "string"),
    ],
    "pv_restricted.suppression": [("subject_ref", "string"), ("request_id", "string"), ("created_at", "timestamp")],
}

# Source export fields per family (SPEC.md section 9.1); anything else in an export is quarantined.
EXPORT_FIELDS: dict[str, tuple[str, ...]] = {
    "hris": tuple(c for c, _ in RAW_TABLES["pv_raw.hris_employees"] if c not in ("employee_key", "manager_key", "subject_ref", "_loaded_at")),
    "payroll": ("employee_id", "pay_period_end", "base_salary", "bonus_target_pct", "currency"),
    "leave": ("leave_id", "employee_id", "start_date", "end_date", "leave_type", "leave_category", "leave_reason", "accommodation_note", "status"),
    "performance": ("review_id", "employee_id", "cycle", "rating", "review_text", "reviewer_employee_id"),
}
FAMILY_TABLE = {
    "hris": "pv_raw.hris_employees",
    "payroll": "pv_raw.payroll_compensation",
    "leave": "pv_raw.leave_requests",
    "performance": "pv_raw.performance_reviews",
}

DUCK_TYPES = {"string": "VARCHAR", "date": "DATE", "timestamp": "TIMESTAMP", "float": "DOUBLE", "int": "INTEGER", "bool": "BOOLEAN"}
BQ_TYPES = {"string": "STRING", "date": "DATE", "timestamp": "TIMESTAMP", "float": "FLOAT64", "int": "INT64", "bool": "BOOL"}


def duckdb_ddl(table: str, cols: list[tuple[str, str]]) -> str:
    return f"create table if not exists {table} (" + ", ".join(f"{c} {DUCK_TYPES[t]}" for c, t in cols) + ")"


def all_tables() -> dict[str, list[tuple[str, str]]]:
    return {**RAW_TABLES, **RESTRICTED_TABLES}


def create_all_duckdb(conn) -> None:
    for schema in sorted({t.split(".")[0] for t in all_tables()}):
        conn.execute(f"create schema if not exists {schema}")
    for table, cols in all_tables().items():
        conn.execute(duckdb_ddl(table, cols))
