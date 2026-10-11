"""The P1 executor.yml job: configuration from repository secrets, the pv-executor key guard, public-log hygiene and
the actions key that goes straight from the IAM API into a GitHub secret (SPEC.md section 20)."""

from __future__ import annotations

import io
import json
import sys
import threading
from types import SimpleNamespace

import pytest

from peoplevault import config
from peoplevault.dbtrun import DbtRefused, build_args, failed_nodes
from peoplevault.logging_redact import install_public_excepthook
from peoplevault.setup import github

TAGS = {"compensation": "projects/p/locations/us/taxonomies/1/policyTags/2"}


def test_policy_tags_from_the_repository_secret(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "SECRETS_DIR", tmp_path)
    assert config.prod_resources() == {}
    monkeypatch.setenv("PV_POLICY_TAGS_JSON", json.dumps(TAGS))
    assert config.prod_resources()["policy_tags"] == TAGS
    (tmp_path / "prod-resources.json").write_text(json.dumps({"kv_id": "k", "policy_tags": {"compensation": "old"}}))
    assert config.prod_resources() == {"kv_id": "k", "policy_tags": TAGS}


@pytest.mark.parametrize("raw", ["[]", "{}", '{"compensation": ""}', '{"compensation": 3}'])
def test_malformed_policy_tags_secret_is_refused(monkeypatch, tmp_path, raw):
    monkeypatch.setattr(config, "SECRETS_DIR", tmp_path)
    monkeypatch.setenv("PV_POLICY_TAGS_JSON", raw)
    with pytest.raises(RuntimeError, match="PV_POLICY_TAGS_JSON"):
        config.prod_resources()


def test_dbt_target_defaults_to_impersonation(monkeypatch):
    monkeypatch.delenv("PV_DBT_TARGET", raising=False)
    assert config.prod_dbt_target("p") == "bigquery"
    monkeypatch.setenv("PV_DBT_TARGET", "local")
    with pytest.raises(RuntimeError, match="PV_DBT_TARGET"):
        config.prod_dbt_target("p")


def test_actions_target_runs_only_with_the_executor_key(monkeypatch, tmp_path):
    monkeypatch.setenv("PV_DBT_TARGET", "bigquery_actions")
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    with pytest.raises(RuntimeError, match="GOOGLE_APPLICATION_CREDENTIALS"):
        config.prod_dbt_target("p")
    key = tmp_path / "gcp.json"
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(key))
    key.write_text("not json")
    with pytest.raises(RuntimeError, match="not a service account key"):
        config.prod_dbt_target("p")
    key.write_text(json.dumps({"type": "service_account", "client_email": "pv-gateway@p.iam.gserviceaccount.com"}))
    with pytest.raises(RuntimeError, match="not pv-executor"):
        config.prod_dbt_target("p")
    key.write_text(json.dumps({"type": "service_account", "client_email": "pv-executor@p.iam.gserviceaccount.com"}))
    assert config.prod_dbt_target("p") == "bigquery_actions"


def test_public_logs_silence_dbt_console_output():
    assert build_args(["build", "--target", "local"], log_level="none")[:2] == ["--log-level", "none"]
    args = build_args(["build", "--target", "bigquery_actions"], policy_tags=TAGS, log_level="none")
    assert args[:2] == ["--log-level", "none"] and json.loads(args[args.index("--vars") + 1]) == {"pv_policy_tags": TAGS}
    with pytest.raises(DbtRefused):
        build_args(["build"], log_level="debug")
    with pytest.raises(DbtRefused, match="log-level"):
        build_args(["build", "--log-level", "debug"])


def test_failed_nodes_name_models_never_messages():
    result = SimpleNamespace(results=[
        SimpleNamespace(status="success", node=SimpleNamespace(unique_id="model.pv.dim_employee")),
        SimpleNamespace(status="error", node=SimpleNamespace(unique_id="model.pv.team_roster"), message="value E00042 bad"),
        SimpleNamespace(status="fail", node=SimpleNamespace(unique_id="test.pv.no_suppressed_subjects")),
    ])
    assert failed_nodes(result) == ["model.pv.team_roster", "test.pv.no_suppressed_subjects"]
    assert failed_nodes(None) == []


def test_public_excepthook_prints_type_and_redacted_message_only():
    saved = (sys.excepthook, threading.excepthook)
    out = io.StringIO()
    try:
        install_public_excepthook(out)
        try:
            raise ValueError("row for E00042 (ian.chen@peoplevault.test) failed")
        except ValueError as e:
            sys.excepthook(type(e), e, e.__traceback__)
        text = out.getvalue()
        assert text == "error: ValueError: row for [redacted] ([redacted]) failed\n"
        assert "Traceback" not in text
    finally:
        sys.excepthook, threading.excepthook = saved


class FakeIam:
    def __init__(self):
        self.created: list[str] = []
        self.deleted: list[tuple[str, str]] = []

    def create_sa_key(self, sa):
        key_id = f"key{len(self.created) + 1}"
        self.created.append(sa)
        return json.dumps({"type": "service_account", "client_email": sa, "private_key_id": key_id, "private_key": "-----PRIVATE-----"})

    def delete_sa_key(self, sa, key_id):
        self.deleted.append((sa, key_id))


class FakeGh:
    def __init__(self, secrets=(), fail_set=False):
        self.secrets = set(secrets)
        self.fail_set = fail_set
        self.calls: list[tuple[list[str], str | None]] = []

    def __call__(self, args, stdin):
        self.calls.append((args, stdin))
        if args[:2] == ["secret", "list"]:
            return github.GhResult(0, json.dumps([{"name": n} for n in sorted(self.secrets)]))
        if args[:2] == ["secret", "set"]:
            if self.fail_set:
                return github.GhResult(1, "")
            self.secrets.add(args[2])
            return github.GhResult(0, "")
        return github.GhResult(1, "")


def test_actions_key_goes_from_iam_to_the_secret_on_stdin():
    iam, gh = FakeIam(), FakeGh()
    out = github.ensure_actions_key(iam, gh, "owner/peoplevault", "p")
    assert out == {"action": "created", "key_id": "key1"}
    assert iam.created == ["pv-executor@p.iam.gserviceaccount.com"]
    args, stdin = gh.calls[-1]
    assert args == ["secret", "set", "PV_GCP_EXECUTOR_KEY", "--app", "actions", "--repo", "owner/peoplevault"]
    assert json.loads(stdin)["private_key_id"] == "key1"
    assert all("PRIVATE" not in " ".join(a) for a, _ in gh.calls)


def test_existing_secret_is_left_alone_and_rotation_deletes_the_previous_key():
    iam, gh = FakeIam(), FakeGh(secrets={"PV_GCP_EXECUTOR_KEY"})
    assert github.ensure_actions_key(iam, gh, "owner/peoplevault", "p") == {"action": "exists"}
    assert iam.created == []
    out = github.ensure_actions_key(iam, gh, "owner/peoplevault", "p", rotate=True, recorded_key_id="old1")
    assert out == {"action": "rotated", "key_id": "key1"}
    assert iam.deleted == [("pv-executor@p.iam.gserviceaccount.com", "old1")]


def test_a_key_that_could_not_be_uploaded_is_deleted():
    iam, gh = FakeIam(), FakeGh(fail_set=True)
    with pytest.raises(RuntimeError, match="gh secret set"):
        github.ensure_actions_key(iam, gh, "owner/peoplevault", "p")
    assert iam.deleted == [("pv-executor@p.iam.gserviceaccount.com", "key1")]


def test_repo_must_be_owner_slash_name():
    with pytest.raises(ValueError):
        github.ensure_actions_key(FakeIam(), FakeGh(), "peoplevault; rm -rf /", "p")
