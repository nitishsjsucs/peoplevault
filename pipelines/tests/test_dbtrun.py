import json

import pytest

from peoplevault.dbtrun import DbtRefused, build_args

TAGS = {"compensation": "projects/p/locations/us/taxonomies/1/policyTags/2"}


def test_local_build_gets_warn_log_level_and_dirs():
    args = build_args(["build", "--target", "local"])
    assert args[:2] == ["--log-level", "warn"]
    assert "--project-dir" in args and "--profiles-dir" in args


@pytest.mark.parametrize("flag", ["--full-refresh", "-f"])
def test_full_refresh_refused_on_bigquery(flag):
    with pytest.raises(DbtRefused, match="merge-only"):
        build_args(["build", "--target", "bigquery", flag], policy_tags=TAGS)


def test_full_refresh_allowed_locally():
    assert "--full-refresh" in build_args(["build", "--target", "local", "--full-refresh"])


def test_bigquery_gets_policy_tag_vars():
    args = build_args(["build", "--target", "bigquery"], policy_tags=TAGS)
    i = args.index("--vars")
    assert json.loads(args[i + 1]) == {"pv_policy_tags": TAGS}


def test_bigquery_without_tags_refused():
    with pytest.raises(DbtRefused, match="policy tag"):
        build_args(["run", "--target", "bigquery"])


def test_store_failures_refused():
    with pytest.raises(DbtRefused):
        build_args(["test", "--store-failures"])
