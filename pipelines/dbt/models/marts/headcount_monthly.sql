{#- The only rebuilt table in a protected dataset: aggregate rows only, no tagged column, no row access policy.
    Restricted population excluded at build; cells under 5 suppressed (k-anonymity test). Erasure recomputes it. -#}
{{ config(materialized='table') }}
select
  cast(date_trunc('month', c.pay_period_end) as date) as month,
  d.org_unit,
  d.job_level,
  count(*) as headcount
from {{ ref('fct_compensation') }} c
join {{ ref('dim_employee') }} d on d.employee_key = c.employee_key
where not d.is_restricted
group by 1, 2, 3
having count(*) >= 5
