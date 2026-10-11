select
  l.leave_id,
  l.employee_key,
  l.subject_ref,
  cast(l.start_date as date) as start_date,
  cast(l.end_date as date) as end_date,
  l.leave_type,
  l.leave_category,
  l.leave_reason,
  l.accommodation_note,
  l.status
from {{ source('pv_raw', 'leave_requests') }} l
where l.subject_ref not in (select subject_ref from {{ source('pv_restricted', 'suppression') }})
