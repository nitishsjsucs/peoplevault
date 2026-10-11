"""Policy tags only on table-like models, exactly matching the column classes (SPEC.md section 9.3)."""

from peoplevault.policy.model import TAGGED_CLASSES, policy

PLACEHOLDER = "projects/ci/locations/us/taxonomies/0/policyTags/{}"


def _nodes(manifest):
    return [n for n in manifest["nodes"].values() if n["resource_type"] in ("model", "snapshot")]


def test_every_tagged_column_of_every_table_like_model_declares_exactly_its_tag(bigquery_manifest, empty_warehouse):
    classes = policy().column_class
    for node in _nodes(bigquery_manifest):
        mat = node["config"]["materialized"]
        if mat not in ("table", "incremental", "snapshot"):
            continue
        actual = empty_warehouse[f"{node['schema']}.{node['alias']}"]
        for col in actual:
            assert col in classes, f"{node['name']}.{col} is not classified in policy.yaml"
            cls = classes[col]
            documented = node["columns"].get(col)
            if cls in TAGGED_CLASSES:
                assert documented is not None, f"{node['name']}.{col} ({cls}) must be documented with its policy tag"
                assert documented["policy_tags"] == [PLACEHOLDER.format(cls)], f"{node['name']}.{col}"
            elif documented is not None:
                assert not documented.get("policy_tags"), f"{node['name']}.{col} is not tagged-class but declares a tag"


def test_no_view_declares_policy_tags(bigquery_manifest):
    for node in _nodes(bigquery_manifest):
        if node["config"]["materialized"] == "view":
            for col, info in node["columns"].items():
                assert not info.get("policy_tags"), f"view {node['name']}.{col} declares policy_tags"


def test_view_folders_do_not_persist_column_docs(bigquery_manifest):
    for node in _nodes(bigquery_manifest):
        if node["config"]["materialized"] == "view":
            assert node["config"]["persist_docs"].get("columns") is False, node["name"]


def test_every_column_of_every_model_is_classified(empty_warehouse):
    classes = policy().column_class
    for table, cols in empty_warehouse.items():
        if table.startswith("peoplevault_raw.stg_"):
            continue
        for col in cols:
            assert col in classes, f"{table}.{col} is not classified in policy.yaml"
