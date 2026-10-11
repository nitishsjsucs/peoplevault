{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key=['employee_key', 'pay_period_end'],
    on_schema_change='ignore',
    full_refresh=false,
    post_hook=["{{ pv_row_access_policies() }}"]
) }}
select
  p.employee_key,
  p.subject_ref,
  p.pay_period_end,
  p.base_salary,
  p.bonus_target_pct,
  p.currency,
  case
    when p.base_salary < 80000 then 'under_80k'
    when p.base_salary < 120000 then '80k_120k'
    when p.base_salary < 160000 then '120k_160k'
    when p.base_salary < 200000 then '160k_200k'
    else '200k_plus'
  end as salary_band,
  d.is_restricted
from {{ ref('stg_payroll_compensation') }} p
join {{ ref('dim_employee') }} d on d.employee_key = p.employee_key
