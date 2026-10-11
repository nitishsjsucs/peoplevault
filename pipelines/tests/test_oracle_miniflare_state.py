"""The eval oracle reads R2 straight from Miniflare's state files (layout pinned to wrangler 4.149.0): an object written
with `wrangler r2 object put --local` and one with custom metadata are read back with body and metadata; an
unexpected layout or an empty state fails loudly."""

import ast
import json
import subprocess
from pathlib import Path

import pytest

from peoplevault import config
from peoplevault.evals.miniflare_state import StateLayoutError, read_r2_objects
from peoplevault.evals.oracle import TokenIndex, oracle_pseudonym, subject_tokens
from peoplevault.pseudo import TEST_MASTER_KEY, Pseudonymizer

WRANGLER = config.REPO_ROOT / "node_modules" / ".bin" / "wrangler"


@pytest.mark.timeout(300)
def test_reads_objects_written_by_wrangler_and_by_miniflare(tmp_path):
    persist = tmp_path / "state"
    body = tmp_path / "body.jsonl"
    body.write_text('{"employee_id": "E04242"}\n')
    res = subprocess.run([str(WRANGLER), "r2", "object", "put", "pv-source-exports/exports/test/one.jsonl", "--local", "--persist-to", str(persist), "--file", str(body)],
                         cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    assert res.returncode == 0, res.stderr[-300:]
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"r2": [{"bucket": "pv-derived", "key": "extracts/x.jsonl", "body": "{}\n", "customMetadata": {"owner": "er_" + "a" * 26}}]}))
    res = subprocess.run(["node", "scripts/eval-plant.ts", str(plan), str(persist / "v3")], cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    assert res.returncode == 0, res.stderr[-300:]
    objs = read_r2_objects(persist / "v3")
    by_key = {(o.bucket, o.key): o for o in objs}
    assert by_key[("pv-source-exports", "exports/test/one.jsonl")].body == body.read_bytes()
    assert by_key[("pv-derived", "extracts/x.jsonl")].custom_metadata == {"owner": "er_" + "a" * 26}


def test_layout_errors_fail_loudly(tmp_path):
    with pytest.raises(StateLayoutError):
        read_r2_objects(tmp_path)
    (tmp_path / "r2" / "miniflare-R2BucketObject").mkdir(parents=True)
    with pytest.raises(StateLayoutError, match="no R2 objects"):
        read_r2_objects(tmp_path)


def test_oracle_tokens_are_computed_independently_but_agree_with_the_product():
    ps = Pseudonymizer(TEST_MASTER_KEY)
    for e in ("E00001", "E00042", "E01200"):
        for kind in ("warehouse_key", "employee_ref", "analytics_id", "subject_ref"):
            assert oracle_pseudonym(TEST_MASTER_KEY, kind, e) == ps.pseudonym(kind, e)


def test_oracle_extraction_is_boundary_aware():
    t = subject_tokens(TEST_MASTER_KEY, {"employee_id": "E00042", "work_email": "ian.chen@peoplevault.test", "full_name": "Ian Chen"})
    idx = TokenIndex({"E00042": t})
    assert idx.subjects_in("brian.chen@peoplevault.test and Brian Chen and E000421") == set()
    assert idx.subjects_in("Senior Ian Chen,") == {"E00042"}
    assert idx.subjects_in(f"ref {t.employee_ref}.") == {"E00042"}
    assert idx.subjects_in("IAN.CHEN@PEOPLEVAULT.TEST") == set()  # out-of-design spelling


def test_oracle_shares_no_code_with_the_product_verifiers():
    for f in ("oracle.py", "miniflare_state.py"):
        tree = ast.parse((Path(__file__).parents[1] / "src" / "peoplevault" / "evals" / f).read_text())
        for node in ast.walk(tree):
            mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
            for m in mods:
                assert not m.startswith(("peoplevault.verify", "peoplevault.pseudo", "peoplevault.executor")), (f, m)
