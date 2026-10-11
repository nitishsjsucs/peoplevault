{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key='leave_id',
    on_schema_change='ignore',
    full_refresh=false,
    post_hook=["{{ pv_row_access_policies() }}"]
) }}
select
  l.leave_id,
  l.employee_key,
  l.subject_ref,
  l.start_date,
  l.end_date,
  l.leave_type,
  l.leave_category,
  l.leave_reason,
  l.accommodation_note,
  l.status,
  d.is_restricted
from {{ ref('stg_leave_requests') }} l
join {{ ref('dim_employee') }} d on d.employee_key = l.employee_key
