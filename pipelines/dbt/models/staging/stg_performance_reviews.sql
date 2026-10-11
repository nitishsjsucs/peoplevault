select
  r.review_id,
  r.employee_key,
  r.subject_ref,
  r.cycle,
  cast(r.rating as {{ dbt.type_int() }}) as rating,
  r.review_text,
  r.reviewer_key
from {{ source('peoplevault_raw', 'performance_reviews') }} r
where r.subject_ref not in (select subject_ref from {{ source('peoplevault_restricted', 'suppression') }})
