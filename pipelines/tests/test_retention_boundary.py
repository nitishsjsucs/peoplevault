from datetime import date, timedelta

import pytest
from synth_helpers import population

from peoplevault import retention_rules as rr

AS_OF = date(2026, 9, 30)


@pytest.mark.parametrize(
    ("period", "cutoff"),
    [({"days": 56}, date(2026, 8, 5)), ({"days": 300}, date(2025, 12, 4)), ({"days": 365}, date(2025, 9, 30)),
     ({"days": 540}, date(2025, 4, 8)), ({"days": 90}, date(2026, 7, 2)), ({"months": 84}, date(2019, 9, 30)), ({"years": 3}, date(2023, 9, 30))],
)
def test_cutoffs(period, cutoff):
    c = rr.cutoff_for(AS_OF, **period)
    assert c == cutoff
    assert rr.is_past(c, c)  # boundary day is past retention (inclusive)
    assert rr.is_past(c - timedelta(days=1), c)
    assert not rr.is_past(c + timedelta(days=1), c)


def test_month_arithmetic_clamps():
    assert rr.minus_months(date(2026, 3, 31), 1) == date(2026, 2, 28)
    assert rr.minus_years(date(2024, 2, 29), 1) == date(2023, 2, 28)


def test_no_termination_within_three_days_of_cutoff():
    cutoff = date(2023, 9, 30)
    for e in population().employees.values():
        if e.termination_date:
            assert abs((e.termination_date - cutoff).days) > 3
