{#- Ephemeral input of the SCD2 snapshot: pseudonymous attributes only, so the history table holds no direct
    identifiers. Inlined into each `dbt snapshot` run, which is how var('pv_snapshot_export_date') replays the 13
    weekly exports one at a time. -#}
select employee_key, subject_ref, org_unit, job_level, job_title, manager_key, employment_status, is_restricted, location, export_date
from {{ ref('stg_hris_employees') }}
