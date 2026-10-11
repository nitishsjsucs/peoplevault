import json

from peoplevault import config
from peoplevault.policy.compile import COMPILED_JSON, check, compile_all


def test_compile_is_deterministic():
    assert compile_all() == compile_all()


def test_committed_files_match_policy():
    assert check() == []


def test_compiled_json_shape():
    compiled = json.loads(compile_all()[COMPILED_JSON])
    assert len(compiled["personas"]) == 4
    assert len(compiled["purposes"]) == 5
    assert len(compiled["assets"]) == 13
    assert len({a["category"] for a in compiled["assets"]}) == 6
    for purpose, p in compiled["purposes"].items():
        assert p["dataset"] == f"pv_purpose_{purpose}"
        assert p["bqIdentity"].startswith("pv-") and p["bqIdentity"].endswith("-reader")
    # each purpose is bound to its own BigQuery identity
    assert len({p["bqIdentity"] for p in compiled["purposes"].values()}) == 5


def test_no_compiled_query_returns_a_deny_column():
    compiled = json.loads(compile_all()[COMPILED_JSON])
    for q in compiled["queries"].values():
        for col in q["columns"]:
            assert col["visibility"] != "deny", (q["id"], col["name"])


def test_check_detects_drift(tmp_path):
    for rel, content in compile_all().items():
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    assert check(tmp_path) == []
    (tmp_path / COMPILED_JSON).write_text("{}\n")
    assert check(tmp_path) == [f"differs: {COMPILED_JSON}"]


def test_policy_hash_tracks_source():
    import hashlib

    compiled = json.loads((config.REPO_ROOT / COMPILED_JSON).read_text())
    assert compiled["policyHash"] == hashlib.sha256(config.POLICY_YAML.read_bytes()).hexdigest()
