# Protected table migrations

Protected BigQuery tables (policy-tagged columns or row access policies) are created once and afterwards changed only by `MERGE` and DML (ADR 0006). With `on_schema_change: ignore`, adding a column to a protected dbt model changes nothing in an existing table, so every column change needs an explicit, idempotent migration here, for example `0001_dim_employee_add_x.sql`:

```sql
ALTER TABLE `<project>.pv_core.dim_employee` ADD COLUMN IF NOT EXISTS x STRING;
```

`test_dbt_materializations.py` fails when a protected model's columns differ from `../protected_schemas.json` plus the columns added by these files. After the `ALTER TABLE`, the next `pv dbt build --target bigquery` applies the column's policy tag through `persist_docs`.
