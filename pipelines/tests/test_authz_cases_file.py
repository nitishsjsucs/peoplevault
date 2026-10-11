"""The authorization case catalog: exactly 100 cases, category and layer totals, resolvable principals and subjects."""

import json
from collections import Counter

import yaml

from peoplevault import config

CASES = yaml.safe_load((config.POLICY_DIR / "cases" / "authz_cases.yaml").read_text())
WORLD = yaml.safe_load((config.FIXTURES_DIR / "world.yaml").read_text())
SUBJECTS = json.loads((config.FIXTURES_DIR / "authz_subjects.json").read_text())["principals"]


def test_exactly_100_cases_with_category_totals():
    assert len(CASES) == 100
    assert len({c["id"] for c in CASES}) == 100
    assert Counter(c["category"] for c in CASES) == {"A": 12, "B": 15, "C": 30, "D": 16, "E": 8, "F": 13, "G": 6}


def test_layer_totals():
    assert sum("pdp" in c["layers"] for c in CASES) == 100
    wh = [c for c in CASES if "warehouse" in c["layers"]]
    assert len(wh) == 48
    assert Counter(c["category"] for c in wh) == {"C": 30, "D": 15, "E": 3}


def test_c_covers_every_purpose_class_cell_once():
    cells = [(c["purpose"], next(iter(c["expect"]["class_visibility"]))) for c in CASES if c["category"] == "C"]
    assert len(cells) == len(set(cells)) == 30


def test_principals_and_subject_selectors_resolve():
    principals = {p["id"] for p in WORLD["principals"]}
    for c in CASES:
        assert c["principal"] in principals, c["id"]
        s = c.get("subject")
        if s:
            entries = SUBJECTS[s["principal"]][s["selector"]]
            assert len(entries) > s["index"], c["id"]
        for sel in c["expect"].get("lookup_finds", []):
            assert SUBJECTS["*"][sel], c["id"]
