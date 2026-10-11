"""Monthly HR history (2019-01 to 2026-09) that the loader writes to Iceberg `hr_history.employee_monthly`.

Rows carry raw employee ids here; the loader pseudonymizes them (`employee_key`, `analytics_id`, `manager_key`)
and appends one year per commit (8 appends). Months before the weekly exports use each employee's state before
the exports; July to September 2026 use the state of the last weekly export in that month.
"""

from __future__ import annotations

from datetime import date

from peoplevault.synth import counts as C
from peoplevault.synth.exports import month_end, salary_at
from peoplevault.synth.population import Population


def lake_months() -> list[date]:
    out = []
    y, m = C.LAKE_FIRST_MONTH.year, C.LAKE_FIRST_MONTH.month
    for _ in range(C.LAKE_MONTHS):
        out.append(date(y, m, 1))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    assert out[-1] == date(2026, 9, 1)
    return out


def _export_index_for(month: date) -> int:
    end = month_end(month.strftime("%Y-%m"))
    idx = -1
    for i, d in enumerate(C.HRIS_WEEKLY_DATES):
        if d <= end:
            idx = i
    return idx


def monthly_rows(pop: Population) -> dict[int, list[dict]]:
    """year -> rows, ordered by month then employee id."""
    by_year: dict[int, list[dict]] = {}
    for month in lake_months():
        end = month_end(month.strftime("%Y-%m"))
        idx = _export_index_for(month)
        for e_id in pop.ids():
            e = pop.employees[e_id]
            if not e.employed_during(month, end):
                continue
            s = pop.state(e_id, idx) if idx >= 0 else e
            status = "terminated" if (e.termination_date is not None and e.termination_date <= end) else "active"
            by_year.setdefault(month.year, []).append({
                "month": month.isoformat(), "snapshot_year": month.year, "employee_id": e_id, "org_unit": s.org_unit,
                "job_level": s.job_level, "job_title": s.job_title, "manager_employee_id": s.manager_id,
                "employment_status": status, "base_salary": float(salary_at(pop, e_id, end)), "is_restricted": s.is_restricted,
            })
    assert len(by_year) == C.LAKE_APPENDS
    return by_year
