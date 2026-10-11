{#- One row per employee with a manager (protected: full_name is tagged; erased by DML, never rebuilt). -#}
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key='employee_key',
    on_schema_change='ignore',
    full_refresh=false,
    post_hook=["{{ pv_row_access_policies() }}"]
) }}
select
  employee_key,
  employee_ref,
  manager_key,
  full_name,
  job_title,
  org_unit,
  employment_status,
  is_restricted,
  subject_ref
from {{ ref('dim_employee') }}
where manager_key is not null
