import json
import re

from synth_helpers import generate_into

from peoplevault import config

GOLDEN = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())


def test_generated_counts_equal_golden(tmp_path):
    assert generate_into(tmp_path) == GOLDEN


def test_seed_sql_counts(tmp_path):
    generate_into(tmp_path)
    sql = (tmp_path / "seed.sql").read_text()
    assert len(re.findall(r"^INSERT INTO principals ", sql, re.M)) == GOLDEN["d1"]["principals"] == 133
    assert len(re.findall(r"^INSERT INTO identity_map ", sql, re.M)) == GOLDEN["d1"]["identity_map"] == 1200
    assert len(re.findall(r"^INSERT INTO legal_holds ", sql, re.M)) == GOLDEN["d1"]["legal_holds"] == 6


def test_export_files_match_golden_rows(tmp_path):
    generate_into(tmp_path)
    for family, info in GOLDEN["export_rows"].items():
        for key, n in info["objects"].items():
            lines = (tmp_path / key).read_text().splitlines()
            assert len(lines) - (1 if family == "payroll" else 0) == n, key


def test_kv_warmup(tmp_path):
    generate_into(tmp_path)
    warm = json.loads((tmp_path / "truth" / "kv_warmup.json").read_text())
    assert len(warm) == 420
    kinds = {}
    for w in warm:
        kinds[(w["purpose"], w["kind"])] = kinds.get((w["purpose"], w["kind"]), 0) + 1
    assert kinds == {("employee_relations", "profile"): 120, ("team_management", "profile"): 120, ("workforce_analytics", "profile"): 60, ("team_management", "team"): 120}
    assert len({(w["purpose"], w["kind"], w["ref"]) for w in warm}) == 420
