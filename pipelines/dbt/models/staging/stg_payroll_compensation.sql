select
  p.employee_key,
  p.subject_ref,
  cast(p.pay_period_end as date) as pay_period_end,
  cast(p.base_salary as {{ dbt.type_float() }}) as base_salary,
  cast(p.bonus_target_pct as {{ dbt.type_float() }}) as bonus_target_pct,
  p.currency
from {{ source('peoplevault_raw', 'payroll_compensation') }} p
where p.subject_ref not in (select subject_ref from {{ source('peoplevault_restricted', 'suppression') }})
