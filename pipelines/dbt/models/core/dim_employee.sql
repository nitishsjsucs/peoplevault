{#- Current identified records keyed by employee_key (protected: merge-only, ADR 0006). Coarsened columns are
    materialized here with their own class, because BigQuery masking applies through views: a view computing
    age_band from a masked birth_date would see the masked value. -#}
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key='employee_key',
    on_schema_change='ignore',
    full_refresh=false,
    post_hook=["{{ pv_row_access_policies() }}"]
) }}
{%- set as_of = "cast('" ~ var('pv_as_of', '2026-09-30') ~ "' as date)" -%}
{%- set age = "(extract(year from " ~ as_of ~ ") - extract(year from birth_date))" -%}
select
  employee_key,
  employee_ref,
  analytics_id,
  subject_ref,
  full_name,
  work_email,
  personal_email,
  phone,
  birth_date,
  gender,
  ethnicity,
  hire_date,
  termination_date,
  employment_status,
  job_title,
  job_level,
  org_unit,
  location,
  manager_key,
  is_restricted,
  case
    when {{ age }} < 25 then 'under_25'
    when {{ age }} < 35 then '25_34'
    when {{ age }} < 45 then '35_44'
    when {{ age }} < 55 then '45_54'
    else '55_plus'
  end as age_band,
  cast(extract(year from hire_date) as {{ dbt.type_int() }}) as hire_year,
  cast(extract(year from coalesce(termination_date, {{ as_of }})) - extract(year from hire_date) as {{ dbt.type_int() }}) as tenure_years
from {{ ref('stg_hris_employees') }}
