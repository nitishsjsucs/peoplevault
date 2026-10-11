"""Golden `pv setup gcp --dry-run` plans: an empty project gets every create step in order, a complete project gets
none, and applying the plan to an empty project converges (a second plan is empty)."""

from pathlib import Path

from fake_gcp import FakeGcp

from peoplevault.setup.gcp import apply, plan

GOLDEN = Path(__file__).parent / "golden" / "setup_gcp_empty_project.txt"


def _lines(steps):
    return [s.line() for s in steps]


def test_empty_project_plan_matches_golden():
    got = _lines(plan(FakeGcp(), "pv-test", "owner@example.test", gateway_key_recorded=False).steps)
    assert got == GOLDEN.read_text().splitlines()
    text = "\n".join(got)
    assert "create custom role: projects/pv-test/roles/peoplevaultTimeTravelReader (bigquery.rowAccessPolicies.overrideTimeTravelRestrictions)" in text
    # shared project: the executor's only project-level role is jobUser; the catalog read is on the taxonomy resource
    assert "roles/bigquery.metadataViewer" not in text and "roles/bigquery.dataViewer" not in text
    assert "roles/bigquery.jobUser -> serviceAccount:peoplevault-executor@pv-test.iam.gserviceaccount.com" in text
    assert "grant taxonomy role: peoplevault: roles/datacatalog.viewer -> serviceAccount:peoplevault-executor@pv-test.iam.gserviceaccount.com" in text
    assert "create dataset: pv-test.peoplevault_authz_probe (US)" in text and "create dataset: pv-test.peoplevault_scratch (US)" in text
    assert "peoplevault-executor@pv-test.iam.gserviceaccount.com: roles/iam.serviceAccountTokenCreator -> user:owner@example.test" in text
    assert "ALTER SCHEMA peoplevault_core SET OPTIONS (max_time_travel_hours = 48)" in text
    assert text.count("create data masking policy") == 3


def test_complete_project_plan_has_no_create_steps():
    assert plan(FakeGcp(complete=True), "pv-test", "owner@example.test", gateway_key_recorded=True).steps == []


def test_apply_converges_and_records_tag_names():
    fake = FakeGcp()
    res = apply(fake, "pv-test", "owner@example.test", gateway_key_recorded=False)
    assert set(res.resources["policy_tags"]) == {"direct_identifier", "date_of_birth", "compensation", "performance", "health_leave", "protected_attribute"}
    assert res.resources["gateway_key"]
    assert plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=True).steps == []
    assert fake.calls.count("key") == 1


def test_the_executor_reads_the_taxonomy_through_a_resource_level_grant():
    fake = FakeGcp(complete=True)
    fake.taxb = set()
    lines = _lines(plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=True).steps)
    assert lines == ["grant taxonomy role: peoplevault: roles/datacatalog.viewer -> serviceAccount:peoplevault-executor@pv-test.iam.gserviceaccount.com"]


# The shared project on 2026-10-11 (read-only check): BigQuery and the data policy API on; IAM, IAM credentials, Cloud
# Resource Manager and Data Catalog off, and every read through them answered 403 SERVICE_DISABLED.
REAL_ON = {"bigquery.googleapis.com", "bigquerydatapolicy.googleapis.com"}


def test_plan_reads_nothing_through_a_disabled_api():
    fake = FakeGcp(strict=True, apis=REAL_ON)
    got = _lines(plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=False).steps)
    assert not [c for c in fake.calls if c.startswith("refused:")]
    assert got[0] == "enable apis: cloudresourcemanager.googleapis.com datacatalog.googleapis.com iam.googleapis.com iamcredentials.googleapis.com"
    # behind APIs that were never on nothing can exist, so every create step is planned, exactly as for an empty project
    assert got[1:] == GOLDEN.read_text().splitlines()[1:]


def test_apply_enables_the_apis_first_then_plans_again_from_real_reads():
    fake = FakeGcp(strict=True, apis=REAL_ON)
    res = apply(fake, "pv-test", "owner@example.test", gateway_key_recorded=False)
    assert fake.calls[0] == "enable_apis" and fake.calls.count("enable_apis") == 1
    assert not [c for c in fake.calls if c.startswith("refused:")]
    assert res.steps[0].action == "enable apis"
    assert plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=True).steps == []


def test_service_account_policies_are_not_read_before_the_accounts_exist():
    # every API on, no service account yet: reading a missing account's IAM policy would be a 404
    fake = FakeGcp(strict=True, apis=set(FakeGcp(complete=True).apis))
    lines = _lines(plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=False).steps)
    assert sum(1 for x in lines if x.startswith("add service account iam binding")) == 11
    apply(fake, "pv-test", "owner@example.test", gateway_key_recorded=False)
    assert plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=True).steps == []


DEFAULT_ACCESS = {("READER", "specialGroup:projectReaders"), ("WRITER", "specialGroup:projectWriters"), ("OWNER", "specialGroup:projectOwners")}


def test_project_wide_dataset_access_is_planned_for_removal_and_removed():
    """A dataset created with BigQuery's default access list is readable by every Viewer, Editor and Owner of the shared
    project (other repos' identities included): the plan removes those entries and nothing else."""
    fake = FakeGcp(complete=True)
    fake.ds["peoplevault_core"]["access"] |= DEFAULT_ACCESS
    fake.ds["peoplevault_marts"]["access"].add(("READER", "specialGroup:allAuthenticatedUsers"))
    lines = _lines(plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=True).steps)
    assert lines == [
        "remove project-wide dataset access: peoplevault_core: OWNER specialGroup:projectOwners, READER specialGroup:projectReaders, WRITER specialGroup:projectWriters",
        "remove project-wide dataset access: peoplevault_marts: READER specialGroup:allAuthenticatedUsers",
    ]
    apply(fake, "pv-test", "owner@example.test", gateway_key_recorded=True)
    assert plan(fake, "pv-test", "owner@example.test", gateway_key_recorded=True).steps == []
    assert ("OWNER", "serviceAccount:peoplevault-executor@pv-test.iam.gserviceaccount.com") in fake.ds["peoplevault_core"]["access"]


def test_new_datasets_get_an_explicit_access_list():
    fake = FakeGcp()
    apply(fake, "pv-test", "owner@example.test", gateway_key_recorded=False)
    for name, d in fake.ds.items():
        assert not [m for _r, m in d["access"] if m.startswith("specialGroup:")], name
        assert ("OWNER", "user:owner@example.test") in d["access"], name


def test_the_real_client_creates_datasets_with_explicit_access_and_reads_only_this_repos():
    from types import SimpleNamespace

    from peoplevault.setup.gcp_client import RealGcpClient

    created, fetched = [], []

    class Bq:
        def list_datasets(self):
            return [SimpleNamespace(dataset_id=n, reference=n) for n in ("otherrepo_core", "peoplevault_core")]

        def get_dataset(self, ref):
            fetched.append(ref)
            entries = [SimpleNamespace(role="READER", entity_type="specialGroup", entity_id="projectReaders"),
                       SimpleNamespace(role="OWNER", entity_type="userByEmail", entity_id="peoplevault-executor@p.iam.gserviceaccount.com")]
            return SimpleNamespace(dataset_id=ref, max_time_travel_hours=48, access_entries=entries)

        def create_dataset(self, d, exists_ok):
            created.append(d)

    client = RealGcpClient.__new__(RealGcpClient)
    client.project, client.bq = "p", Bq()
    assert client.datasets() == {"peoplevault_core": {"max_time_travel_hours": 48, "access": {("READER", "specialGroup:projectReaders"),
                                                                                               ("OWNER", "serviceAccount:peoplevault-executor@p.iam.gserviceaccount.com")}}}
    assert fetched == ["peoplevault_core"]  # another repo's dataset is never read
    client.create_dataset({"dataset": "peoplevault_raw", "location": "US", "access": [{"role": "OWNER", "member": "serviceAccount:peoplevault-executor@p.iam.gserviceaccount.com"}]}, "user:owner@example.test")
    (d,) = created
    assert [(e.role, e.entity_type, e.entity_id) for e in d.access_entries] == [("OWNER", "userByEmail", "owner@example.test"), ("OWNER", "userByEmail", "peoplevault-executor@p.iam.gserviceaccount.com")]
    assert d.to_api_repr()["access"]  # the request carries the list, so BigQuery adds no default entries
