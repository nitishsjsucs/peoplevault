{#- Pseudonymous monthly features per analytics_id (protected: carries gender and row access policies). -#}
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['analytics_id', 'month'],
    on_schema_change='ignore',
    full_refresh=false,
    post_hook=["{{ pv_row_access_policies() }}"]
) }}
with latest_rating as (
  select employee_key, rating_band,
         row_number() over (partition by employee_key order by cycle desc, review_id desc) as rn
  from {{ ref('fct_performance') }}
)
select
  d.analytics_id,
  cast({{ dbt.date_trunc('month', 'c.pay_period_end') }} as date) as month,
  d.org_unit,
  d.job_level,
  c.salary_band,
  r.rating_band,
  cast(extract(year from c.pay_period_end) - extract(year from d.hire_date) as {{ dbt.type_int() }}) as tenure_years,
  d.age_band,
  d.gender,
  coalesce(d.termination_date is not null
           and d.termination_date >= cast({{ dbt.date_trunc('month', 'c.pay_period_end') }} as date)
           and d.termination_date <= c.pay_period_end, false) as terminated_in_month,
  d.is_restricted,
  d.subject_ref
from {{ ref('fct_compensation') }} c
join {{ ref('dim_employee') }} d on d.employee_key = c.employee_key
left join latest_rating r on r.employee_key = c.employee_key and r.rn = 1
