"""Merge-only protected tables (ADR 0006, SPEC.md section 9.3)."""

import pytest

from peoplevault.dbtrun import DbtRefused, build_args
from peoplevault.policy import protected
from peoplevault.policy.model import TAGGED_CLASSES, policy

PROTECTED_DATASETS = {"peoplevault_core", "peoplevault_snapshots", "peoplevault_marts"}


def _models(manifest):
    return {n["name"]: n for n in manifest["nodes"].values() if n["resource_type"] in ("model", "snapshot")}


def _has_tagged_column(node, column_class):
    return any(column_class.get(c) in TAGGED_CLASSES for c in node["columns"])


def _has_row_access_hook(node):
    return any("pv_row_access_policies" in h["sql"] for h in node["config"].get("post-hook", []))


def test_protected_models_are_merge_only(bigquery_manifest):
    classes = policy().column_class
    checked = []
    for name, node in _models(bigquery_manifest).items():
        cfg = node["config"]
        if cfg["materialized"] == "view" or cfg["materialized"] == "ephemeral":
            continue  # views store no rows; column-level access control applies to the tables they read
        if not (_has_tagged_column(node, classes) or _has_row_access_hook(node)):
            continue
        if node["resource_type"] == "snapshot":
            checked.append(name)
            continue
        assert cfg["materialized"] == "incremental", name
        assert cfg["incremental_strategy"] == "merge", name
        assert cfg["full_refresh"] is False, name
        assert cfg["on_schema_change"] == "ignore", name
        assert cfg["unique_key"], name
        checked.append(name)
    assert sorted(checked) == sorted(protected.PROTECTED_MODELS)


def test_only_table_in_a_protected_dataset_is_the_untagged_aggregate(bigquery_manifest):
    classes = policy().column_class
    tables = [n for n in _models(bigquery_manifest).values() if n["config"]["materialized"] == "table" and n["schema"] in PROTECTED_DATASETS]
    assert [n["name"] for n in tables] == ["headcount_monthly"]
    node = tables[0]
    assert not _has_tagged_column(node, classes) and not _has_row_access_hook(node)


def test_every_protected_model_has_row_access_policies(bigquery_manifest):
    models = _models(bigquery_manifest)
    for name in protected.PROTECTED_MODELS:
        assert _has_row_access_hook(models[name]), name


def test_full_refresh_refused_on_bigquery():
    with pytest.raises(DbtRefused):
        build_args(["build", "--target", "bigquery", "--full-refresh"], policy_tags={"x": "y"})


def test_protected_columns_match_baseline_plus_migrations(empty_warehouse):
    expected = protected.expected_columns()
    for table in protected.PROTECTED_MODELS.values():
        assert empty_warehouse[table] == expected[table], f"{table}: columns changed without a migration in infra/bigquery/migrations/"


def test_migration_parser(tmp_path, monkeypatch):
    monkeypatch.setattr(protected, "MIGRATIONS_DIR", tmp_path)
    (tmp_path / "0001_add.sql").write_text("ALTER TABLE `p.peoplevault_core.dim_employee` ADD COLUMN IF NOT EXISTS shoe_size INT64;\n")
    assert protected.migration_columns() == {"peoplevault_core.dim_employee": ["shoe_size"]}
    assert protected.expected_columns()["peoplevault_core.dim_employee"][-1] == "shoe_size"
