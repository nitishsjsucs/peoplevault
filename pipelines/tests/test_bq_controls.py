"""bq_controls.verify() against recorded tables.get and rowAccessPolicies.list responses: a missing tag or policy fails."""

import copy
import json
from pathlib import Path

from peoplevault.policy.model import TAGGED_CLASSES
from peoplevault.setup.bq_controls import verify

FIX = Path(__file__).parent / "fixtures" / "bigquery"
TABLE = json.loads((FIX / "tables_get_dim_employee.json").read_text())["body"]
RAP = json.loads((FIX / "row_access_policies_list.json").read_text())["body"]
TAGS = {c: f"projects/pv-test/locations/us/taxonomies/1/policyTags/{c}" for c in TAGGED_CLASSES}


def _verify(table=TABLE, rap=RAP):
    return verify(lambda name: table, lambda name: rap, TAGS)


def test_intact_controls_pass():
    assert _verify() == []


def test_missing_tag_fails():
    t = copy.deepcopy(TABLE)
    next(f for f in t["schema"]["fields"] if f["name"] == "gender").pop("policyTags")
    problems = _verify(table=t)
    assert any("gender: policy tag missing" in p for p in problems)


def test_wrong_tag_and_untagged_column_with_tag_fail():
    t = copy.deepcopy(TABLE)
    next(f for f in t["schema"]["fields"] if f["name"] == "full_name")["policyTags"] = {"names": [TAGS["compensation"]]}
    next(f for f in t["schema"]["fields"] if f["name"] == "org_unit")["policyTags"] = {"names": [TAGS["compensation"]]}
    problems = _verify(table=t)
    assert any("full_name: policy tag wrong" in p for p in problems)
    assert any("org_unit: unexpected policy tag" in p for p in problems)


def test_missing_row_access_policy_fails():
    rap = {"rowAccessPolicies": RAP["rowAccessPolicies"][:1]}
    assert any("rap_non_restricted missing" in p for p in _verify(rap=rap))


def test_api_errors_fail_closed():
    def boom(name):
        raise RuntimeError("accessDenied")

    problems = verify(boom, boom, TAGS)
    assert problems and all("failed" in p for p in problems)
