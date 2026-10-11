{#- Ephemeral: inlined into the purpose views as a CTE, so it stores no rows. Current record plus the latest
    compensation, review and leave per employee. -#}
{{ config(materialized='ephemeral') }}
with comp as (
  select employee_key, base_salary, bonus_target_pct, currency, salary_band,
         row_number() over (partition by employee_key order by pay_period_end desc) as rn
  from {{ ref('fct_compensation') }}
),
perf as (
  select employee_key, rating, review_text, cycle, rating_band,
         row_number() over (partition by employee_key order by cycle desc, review_id desc) as rn
  from {{ ref('fct_performance') }}
),
lv as (
  select employee_key, leave_type, leave_category, leave_reason, accommodation_note,
         row_number() over (partition by employee_key order by start_date desc, leave_id desc) as rn
  from {{ ref('fct_leave') }}
)
select
  e.employee_key, e.employee_ref, e.analytics_id, e.subject_ref, e.full_name, e.work_email, e.personal_email, e.phone,
  e.birth_date, e.gender, e.ethnicity, e.hire_date, e.termination_date, e.employment_status, e.job_title, e.job_level,
  e.org_unit, e.location, e.manager_key, e.is_restricted, e.age_band, e.hire_year, e.tenure_years,
  c.base_salary, c.bonus_target_pct, c.currency, c.salary_band,
  p.rating, p.review_text, p.cycle, p.rating_band,
  l.leave_type, l.leave_category, l.leave_reason, l.accommodation_note
from {{ ref('dim_employee') }} e
left join comp c on c.employee_key = e.employee_key and c.rn = 1
left join perf p on p.employee_key = e.employee_key and p.rn = 1
left join lv l on l.employee_key = e.employee_key and l.rn = 1
