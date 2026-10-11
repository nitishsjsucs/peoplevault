{#- One HRIS export: the latest by default, or var('pv_snapshot_export_date') during the snapshot replay.
    Suppressed subjects never pass staging, so a reload cannot resurrect an erased subject. -#}
{%- set as_of = var('pv_snapshot_export_date', none) -%}
select
  h.employee_key,
  x.employee_ref,
  x.analytics_id,
  h.subject_ref,
  h.full_name,
  h.work_email,
  h.personal_email,
  h.phone,
  cast(h.birth_date as date) as birth_date,
  h.gender,
  h.ethnicity,
  cast(h.hire_date as date) as hire_date,
  cast(h.termination_date as date) as termination_date,
  h.employment_status,
  h.job_title,
  h.job_level,
  h.org_unit,
  h.location,
  h.manager_key,
  h.is_restricted,
  cast(h.export_date as date) as export_date
from {{ source('pv_raw', 'hris_employees') }} h
join {{ source('pv_restricted', 'identity_xref') }} x on x.employee_key = h.employee_key
where
  {% if as_of %}cast(h.export_date as date) = cast('{{ as_of }}' as date)
  {% else %}cast(h.export_date as date) = (select max(cast(export_date as date)) from {{ source('pv_raw', 'hris_employees') }})
  {% endif %}
  and h.subject_ref not in (select subject_ref from {{ source('pv_restricted', 'suppression') }})
