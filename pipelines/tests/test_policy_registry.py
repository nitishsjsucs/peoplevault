from collections import Counter

from peoplevault.policy.model import CATEGORIES, policy

EXPECTED = {
    "src.r2.exports": "source_exports",
    "wh.raw": "warehouse_tables",
    "wh.core": "warehouse_tables",
    "hist.dbt.dim_employee_history": "historical_snapshots",
    "hist.lake.employee_monthly": "historical_snapshots",
    "id.d1.identity_records": "identity_mappings",
    "id.wh.identity_xref": "identity_mappings",
    "drv.marts.attrition_features": "derived_datasets",
    "drv.marts.team_roster": "derived_datasets",
    "drv.marts.headcount_monthly": "derived_datasets",
    "drv.r2.analytics_extracts": "derived_datasets",
    "cache.kv.profile_cards": "application_caches",
    "cache.kv.team_rosters": "application_caches",
}


def test_six_categories_13_assets():
    assets = policy().assets
    assert len(assets) == 13
    assert {a.id: a.category for a in assets} == EXPECTED
    assert set(Counter(a.category for a in assets)) == set(CATEGORIES)
    assert len(CATEGORIES) == 6


def test_each_category_non_empty():
    counts = Counter(a.category for a in policy().assets)
    for cat in CATEGORIES:
        assert counts[cat] >= 1


def test_every_asset_has_erase_verify_and_retention_metadata():
    for a in policy().assets:
        assert a.erase
        assert a.parts
        # verification: a probe exists for the store (worker: r2/kv/d1, python: warehouse/iceberg)
        assert (a.executor == "worker") == (a.store in {"r2", "kv", "d1"})
        assert a.store in {"r2", "kv", "d1", "warehouse", "iceberg"}
        if a.row_level:
            assert a.subject_column is not None or a.store == "kv"


def test_headcount_is_the_only_aggregate():
    non_row = [a.id for a in policy().assets if not a.row_level]
    assert non_row == ["drv.marts.headcount_monthly"]
    assert next(a for a in policy().assets if a.id == non_row[0]).erase == "dbt_rebuild"


def test_retention_rules_from_section_8_7():
    by_id = {a.id: a for a in policy().assets}
    exports = {p.name: p.retention for p in by_id["src.r2.exports"].parts}
    assert exports["hris"].days == 56 and exports["payroll"].days == 300
    assert exports["leave"].days == 365 and exports["performance"].days == 540
    assert by_id["hist.lake.employee_monthly"].parts[0].retention.months == 84
    assert by_id["drv.r2.analytics_extracts"].parts[0].retention.days == 90
    assert policy().retention.terminated_subject_years == 3
    assert policy().retention.kv_ttl_seconds == 3600
