"""One boundary rule for every retention period (SPEC.md section 8.7).

cutoff = as_of - period; an item is past retention if and only if its basis date is on or before the cutoff.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta


def minus_days(as_of: date, days: int) -> date:
    return as_of - timedelta(days=days)


def minus_months(as_of: date, months: int) -> date:
    y, m = divmod(as_of.year * 12 + (as_of.month - 1) - months, 12)
    m += 1
    return date(y, m, min(as_of.day, calendar.monthrange(y, m)[1]))


def minus_years(as_of: date, years: int) -> date:
    return minus_months(as_of, 12 * years)


def is_past(basis: date, cutoff: date) -> bool:
    return basis <= cutoff


def cutoff_for(as_of: date, *, days: int | None = None, months: int | None = None, years: int | None = None) -> date:
    if days is not None:
        return minus_days(as_of, days)
    if months is not None:
        return minus_months(as_of, months)
    if years is not None:
        return minus_years(as_of, years)
    raise ValueError("one of days, months or years is required")
