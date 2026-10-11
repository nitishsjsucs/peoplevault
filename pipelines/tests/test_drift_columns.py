"""The 120 labeled columns of the schema-drift eval (SPEC.md section 16.3): exact counts per class, deterministic,
valid for the classify route, and half of each class behind opaque names."""

import re
from collections import Counter

from peoplevault.drift.columns import CLASSES, SENSITIVE, columns

COLUMN_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_ .-]{0,63}$")  # DriftClassifyBody in src/shared/api-schemas.ts


def test_120_columns_84_sensitive():
    cols = columns()
    assert len(cols) == 120
    assert sum(c.sensitive for c in cols) == 84
    assert Counter(c.label for c in cols) == {
        "direct_identifier": 20, "date_of_birth": 8, "compensation": 14, "performance": 14, "health_leave": 14, "protected_attribute": 14,
        "job": 16, "coarsened": 10, "pseudonym": 10,
    }
    assert set(CLASSES) == {c.label for c in cols} and set(SENSITIVE) <= set(CLASSES)


def test_deterministic_and_unique():
    assert columns() == columns()
    assert columns(1) != columns()
    cols = columns()
    assert len({c.id for c in cols}) == 120 and len({c.name for c in cols}) == 120


def test_every_column_is_a_valid_route_body():
    for c in columns():
        assert COLUMN_NAME.match(c.name), c.name
        assert len(c.samples) == 5 and all(0 < len(s) <= 200 for s in c.samples), c


def test_opaque_names_in_every_class():
    for label in CLASSES:
        group = [c for c in columns() if c.label == label]
        opaque = [c for c in group if c.opaque]
        assert 0.25 <= len(opaque) / len(group) <= 0.6, label
