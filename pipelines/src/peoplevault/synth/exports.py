"""Source export objects (SPEC.md section 9.1): 13 HRIS weekly, 12 payroll, 12 leave, 4 performance."""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from datetime import date, timedelta

from peoplevault.synth import counts as C
from peoplevault.synth.population import Population, rand_date, rng

HRIS_FIELDS = (
    "employee_id", "full_name", "work_email", "personal_email", "phone", "birth_date", "gender", "ethnicity", "hire_date",
    "termination_date", "employment_status", "job_title", "job_level", "org_unit", "location", "manager_employee_id",
    "is_restricted", "export_date",
)
PAYROLL_FIELDS = ("employee_id", "pay_period_end", "base_salary", "bonus_target_pct", "currency")
LEAVE_FIELDS = ("leave_id", "employee_id", "start_date", "end_date", "leave_type", "leave_category", "leave_reason", "accommodation_note", "status")
PERFORMANCE_FIELDS = ("review_id", "employee_id", "cycle", "rating", "review_text", "reviewer_employee_id")

LEAVE_TYPES = (
    ("medical", "statutory", "Recovery after a scheduled procedure"),
    ("medical", "statutory", "Treatment for a short-term illness"),
    ("parental", "statutory", "Care for a newborn child"),
    ("family_care", "statutory", "Care for an ill family member"),
    ("bereavement", "discretionary", "Bereavement leave"),
    ("personal", "discretionary", "Personal matters"),
    ("accommodation", "statutory", "Workplace accommodation review"),
)
ACCOMMODATION_NOTES = ("", "", "", "Ergonomic equipment requested", "Reduced schedule for two weeks", "Remote work during recovery")
LEAVE_STATUSES = (("approved", 80), ("pending", 12), ("denied", 8))
RATING_WEIGHTS = (5, 15, 45, 25, 10)
RATING_TEXT = {
    1: "Did not meet expectations this cycle; a development plan is in place.",
    2: "Partially met expectations; progress on core deliverables was uneven.",
    3: "Met expectations with steady delivery across the cycle.",
    4: "Exceeded expectations on key projects and supported team goals.",
    5: "Outstanding impact this cycle with consistently excellent delivery.",
}
REVIEW_FOLLOWUPS = (
    "Communication was clear and timely.",
    "Planning and prioritization improved.",
    "Quality of work was consistent.",
    "Collaboration across teams was strong.",
)


@dataclass(frozen=True)
class ExportObject:
    key: str  # R2 key in pv-source-exports
    family: str  # hris | payroll | leave | performance
    basis_date: date  # retention basis (object date, period end, month end, cycle end)
    rows: tuple[dict, ...]
    fmt: str  # jsonl | csv

    def body(self) -> str:
        if self.fmt == "csv":
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=PAYROLL_FIELDS, lineterminator="\n")
            w.writeheader()
            for row in self.rows:
                w.writerow(row)
            return buf.getvalue()
        return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self.rows)


def month_end(ym: str) -> date:
    y, m = int(ym[:4]), int(ym[5:7])
    nxt = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return nxt - timedelta(days=1)


def cycle_bounds(cycle: str) -> tuple[date, date]:
    y, half = int(cycle[:4]), cycle[4:]
    return (date(y, 1, 1), date(y, 6, 30)) if half == "H1" else (date(y, 7, 1), date(y, 12, 31))


def salary_at(pop: Population, employee_id: str, on: date) -> int:
    e = pop.employees[employee_id]
    promo = pop.promotion_date(employee_id)
    if promo is not None and promo <= on:
        return int(round(e.base_salary * 1.08 / 500.0) * 500)
    return e.base_salary


def hris_objects(pop: Population) -> list[ExportObject]:
    out = []
    for idx, d in enumerate(C.HRIS_WEEKLY_DATES):
        rows = []
        for e_id in pop.ids():
            s = pop.state(e_id, idx)
            rows.append({
                "employee_id": s.employee_id, "full_name": s.full_name, "work_email": s.work_email,
                "personal_email": s.personal_email, "phone": s.phone, "birth_date": s.birth_date.isoformat(),
                "gender": s.gender, "ethnicity": s.ethnicity, "hire_date": s.hire_date.isoformat(),
                "termination_date": s.termination_date.isoformat() if s.termination_date else None,
                "employment_status": "active" if s.termination_date is None else "terminated",
                "job_title": s.job_title, "job_level": s.job_level, "org_unit": s.org_unit, "location": s.location,
                "manager_employee_id": s.manager_id, "is_restricted": s.is_restricted, "export_date": d.isoformat(),
            })
        out.append(ExportObject(f"exports/hris/employees/dt={d.isoformat()}/employees.jsonl", "hris", d, tuple(rows), "jsonl"))
    return out


def payroll_objects(pop: Population) -> list[ExportObject]:
    out = []
    for period in C.PAYROLL_PERIODS:
        end = month_end(period)
        rows = []
        for e_id in pop.ids():
            e = pop.employees[e_id]
            if e.active_on(end):
                rows.append({
                    "employee_id": e_id, "pay_period_end": end.isoformat(), "base_salary": salary_at(pop, e_id, end),
                    "bonus_target_pct": e.bonus_target_pct, "currency": "USD",
                })
        out.append(ExportObject(f"exports/payroll/compensation/period={period}/compensation.csv", "payroll", end, tuple(rows), "csv"))
    return out


def leave_objects(pop: Population) -> list[ExportObject]:
    r = rng("leave")
    out = []
    seq = 0
    for month in C.LEAVE_MONTHS:
        start, end = date(int(month[:4]), int(month[5:7]), 1), month_end(month)
        eligible = [e_id for e_id in pop.ids() if pop.employees[e_id].employed_during(start, end) and pop.employees[e_id].hire_date <= start]
        chosen = sorted(r.sample(eligible, r.randint(35, 60)))
        rows = []
        for e_id in chosen:
            seq += 1
            ltype, category, reason = r.choice(LEAVE_TYPES)
            s = rand_date(r, start, end)
            rows.append({
                "leave_id": f"LV-{seq:06d}", "employee_id": e_id, "start_date": s.isoformat(),
                "end_date": (s + timedelta(days=r.randint(1, 30))).isoformat(), "leave_type": ltype,
                "leave_category": category, "leave_reason": reason, "accommodation_note": r.choice(ACCOMMODATION_NOTES),
                "status": r.choices([x for x, _ in LEAVE_STATUSES], weights=[w for _, w in LEAVE_STATUSES])[0],
            })
        out.append(ExportObject(f"exports/leave/requests/month={month}/requests.jsonl", "leave", end, tuple(rows), "jsonl"))
    return out


def performance_objects(pop: Population) -> list[ExportObject]:
    r = rng("performance")
    out = []
    seq = 0
    for cycle in C.PERFORMANCE_CYCLES:
        _start, end = cycle_bounds(cycle)
        rows = []
        for e_id in pop.ids():
            e = pop.employees[e_id]
            if e.role == "ceo" or not e.active_on(end) or e.hire_date > end - timedelta(days=90):
                continue
            seq += 1
            rating = r.choices([1, 2, 3, 4, 5], weights=RATING_WEIGHTS)[0]
            # cycles end before the weekly exports start, so the reviewer is the manager before any change
            rows.append({
                "review_id": f"RV-{seq:06d}", "employee_id": e_id, "cycle": cycle, "rating": rating,
                "review_text": f"{RATING_TEXT[rating]} {r.choice(REVIEW_FOLLOWUPS)}", "reviewer_employee_id": e.manager_id,
            })
        out.append(ExportObject(f"exports/performance/reviews/cycle={cycle}/reviews.jsonl", "performance", end, tuple(rows), "jsonl"))
    return out


def all_exports(pop: Population) -> list[ExportObject]:
    objs = hris_objects(pop) + payroll_objects(pop) + leave_objects(pop) + performance_objects(pop)
    assert len(objs) == C.EXPORT_OBJECTS
    return objs


SUBJECT_COLUMN = "employee_id"
REFERENCE_COLUMNS = {"hris": ("manager_employee_id",), "payroll": (), "leave": (), "performance": ("reviewer_employee_id",)}
