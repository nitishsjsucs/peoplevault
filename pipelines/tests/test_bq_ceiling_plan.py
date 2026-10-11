"""The ceiling probe plan has exactly 37 probes: 18 denied cells, 4 masked cells, 5 restricted-population counts and
10 dataset IAM probes (SPEC.md section 15.8). The probes themselves run only against BigQuery (test_bigquery_live.py)."""

from collections import Counter

from peoplevault.authz.bq_ceiling import probes


def test_exactly_37_probes_by_kind():
    ps = probes("pv-test")
    assert len(ps) == 37
    assert Counter(p.kind for p in ps) == {"deny": 18, "mask": 4, "rows": 5, "iam": 10}
    rows = {p.purpose: p.expect for p in ps if p.kind == "rows"}
    assert rows == {"employee_relations": "positive", "team_management": "zero", "workforce_analytics": "zero", "privacy_compliance": "positive", "legal_hold_management": "positive"}
    assert all("pv_authz_probe" in p.sql for p in ps if p.kind != "iam")
