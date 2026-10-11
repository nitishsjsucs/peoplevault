{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key='review_id',
    on_schema_change='ignore',
    full_refresh=false,
    post_hook=["{{ pv_row_access_policies() }}"]
) }}
select
  r.review_id,
  r.employee_key,
  r.subject_ref,
  r.cycle,
  r.rating,
  r.review_text,
  r.reviewer_key,
  case when r.rating <= 2 then 'low' when r.rating = 3 then 'mid' else 'high' end as rating_band,
  d.is_restricted
from {{ ref('stg_performance_reviews') }} r
join {{ ref('dim_employee') }} d on d.employee_key = r.employee_key
