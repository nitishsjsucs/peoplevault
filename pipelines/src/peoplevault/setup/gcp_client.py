"""Real Google Cloud client for `pv setup gcp` (user ADC with a quota project). Status: its reads ran read-only against
the shared project on 2026-10-11 (the doctor and the dry run); its writes are not yet executed. Its calls follow the
REST and client-library references cited in SPEC.md section 27."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Callable

IAM = "https://iam.googleapis.com/v1"
CRM = "https://cloudresourcemanager.googleapis.com/v1"
SU = "https://serviceusage.googleapis.com/v1"
# project IAM policies are read and written at version 3, so conditional bindings of the other repos sharing the
# project survive the read-modify-write (a version 1 read cannot be written back when the policy has conditions)
POLICY_VERSION = 3
DATASET_PREFIX = "peoplevault_"  # policy naming.prefix; tests/test_shared_project_names.py keeps them equal


def is_service_disabled(e: BaseException) -> bool:
    """Google's answer for a call through an API that is not enabled (or not yet propagated) on the project: 403 with
    reason SERVICE_DISABLED (REST) or "... has not been used in project ... or it is disabled" (gRPC clients)."""
    response = getattr(e, "response", None)
    text = f"{e} {getattr(response, 'text', '') or ''}"
    return "SERVICE_DISABLED" in text or "has not been used in project" in text


def wait_for(ready: Callable[[], bool], what: str, *, timeout_s: float = 300, interval_s: float = 10,
             sleep: Callable[[float], None] | None = None, clock: Callable[[], float] | None = None) -> None:
    """Polls `ready` until it returns True; TimeoutError after `timeout_s` (enabling an API takes up to a few minutes)."""
    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    deadline = clock() + timeout_s
    while not ready():
        if clock() >= deadline:
            raise TimeoutError(f"timed out waiting for {what}; run the setup again in a few minutes")
        sleep(interval_s)


def answers(read: Callable[[], object]) -> bool:
    """True when the read succeeds, False while its API still answers SERVICE_DISABLED; other errors propagate."""
    try:
        read()
        return True
    except Exception as e:  # noqa: BLE001
        if is_service_disabled(e):
            return False
        raise


class RealGcpClient:
    def __init__(self, project: str, location: str = "US"):
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
        from google.cloud import bigquery

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        self.project = project
        self.location = location
        self.http = AuthorizedSession(creds)
        self.bq = bigquery.Client(project=project, credentials=creds, location=location)
        self.creds = creds

    # ---- helpers ------------------------------------------------------------------------------------------------
    def _get(self, url: str, **params) -> dict:
        r = self.http.get(url, params=params or None)
        r.raise_for_status()
        return r.json()

    def _post(self, url: str, body: dict) -> dict:
        r = self.http.post(url, json=body)
        r.raise_for_status()
        return r.json() if r.content else {}

    # ---- APIs ---------------------------------------------------------------------------------------------------
    def enabled_apis(self) -> set[str]:
        out, token = set(), None
        while True:
            d = self._get(f"{SU}/projects/{self.project}/services", filter="state:ENABLED", pageSize=200, **({"pageToken": token} if token else {}))
            out |= {s["config"]["name"] for s in d.get("services", [])}
            token = d.get("nextPageToken")
            if not token:
                return out

    def enable_apis(self, apis: list[str]) -> None:
        """batchEnable, then wait for its operation and until each API with a read used by the plan answers."""
        op = self._post(f"{SU}/projects/{self.project}/services:batchEnable", {"serviceIds": apis})

        def op_done() -> bool:
            nonlocal op
            if not op.get("done") and op.get("name"):
                op = self._get(f"{SU}/{op['name']}")
            if op.get("error"):
                raise RuntimeError(f"enabling {', '.join(apis)} failed: {op['error'].get('message', 'unknown error')}")
            return bool(op.get("done")) or not op.get("name")

        wait_for(op_done, f"Service Usage to enable {', '.join(apis)}")
        probes = {"iam.googleapis.com": self.service_accounts, "cloudresourcemanager.googleapis.com": self.project_bindings,
                  "datacatalog.googleapis.com": lambda: self.taxonomy("peoplevault"), "bigquerydatapolicy.googleapis.com": self.data_policies}
        for api in apis:
            if api in probes:
                wait_for(lambda read=probes[api]: answers(read), f"{api} to answer after enabling")

    # ---- service accounts and roles -----------------------------------------------------------------------------
    def service_accounts(self) -> set[str]:
        d = self._get(f"{IAM}/projects/{self.project}/serviceAccounts", pageSize=100)
        return {a["email"].split("@")[0] for a in d.get("accounts", [])}

    def create_service_account(self, account_id: str, display_name: str) -> None:
        """Creates the account and waits until IAM returns it: IAM is eventually consistent, and the next steps put the
        new account into IAM policies."""
        self._post(f"{IAM}/projects/{self.project}/serviceAccounts", {"accountId": account_id, "serviceAccount": {"displayName": display_name}})
        email = f"{account_id}@{self.project}.iam.gserviceaccount.com"
        wait_for(lambda: self.http.get(f"{IAM}/projects/{self.project}/serviceAccounts/{email}").status_code == 200, f"{email} to be readable",
                 timeout_s=120, interval_s=5)

    def custom_roles(self) -> set[str]:
        d = self._get(f"{IAM}/projects/{self.project}/roles", pageSize=100)
        return {r["name"].rsplit("/", 1)[1] for r in d.get("roles", [])}

    def create_custom_role(self, role: dict) -> None:
        self._post(f"{IAM}/projects/{self.project}/roles", {"roleId": role["role_id"], "role": {"title": role["title"], "description": role["description"],
                                                                                                "includedPermissions": role["permissions"], "stage": role["stage"]}})

    def _project_policy(self) -> dict:
        return self._post(f"{CRM}/projects/{self.project}:getIamPolicy", {"options": {"requestedPolicyVersion": POLICY_VERSION}})

    def project_bindings(self) -> set[tuple[str, str]]:
        """Unconditional project bindings (this repo never adds a conditional one)."""
        policy = self._project_policy()
        return {(b["role"], m) for b in policy.get("bindings", []) if "condition" not in b for m in b.get("members", [])}

    def add_project_bindings(self, bindings: list[tuple[str, str]]) -> None:
        """Read-modify-write with the policy's etag (a concurrent change by another repo makes the write fail, not lose it)."""
        policy = self._project_policy()
        by_role = {b["role"]: b for b in policy.setdefault("bindings", []) if "condition" not in b}
        for role, member in bindings:
            b = by_role.setdefault(role, {"role": role, "members": []})
            if b not in policy["bindings"]:
                policy["bindings"].append(b)
            if member not in b["members"]:
                b["members"].append(member)
        policy["version"] = POLICY_VERSION
        self._post(f"{CRM}/projects/{self.project}:setIamPolicy", {"policy": policy})

    def sa_bindings(self, sa_email: str) -> set[tuple[str, str]]:
        policy = self._post(f"{IAM}/projects/{self.project}/serviceAccounts/{sa_email}:getIamPolicy", {})
        return {(b["role"], m) for b in policy.get("bindings", []) for m in b.get("members", [])}

    def add_sa_binding(self, sa_email: str, role: str, member: str) -> None:
        policy = self._post(f"{IAM}/projects/{self.project}/serviceAccounts/{sa_email}:getIamPolicy", {})
        bindings = policy.setdefault("bindings", [])
        b = next((x for x in bindings if x["role"] == role), None)
        if b is None:
            b = {"role": role, "members": []}
            bindings.append(b)
        if member not in b["members"]:
            b["members"].append(member)
        self._post(f"{IAM}/projects/{self.project}/serviceAccounts/{sa_email}:setIamPolicy", {"policy": policy})

    def create_sa_key(self, sa_email: str) -> str:
        d = self._post(f"{IAM}/projects/{self.project}/serviceAccounts/{sa_email}/keys", {})
        return base64.b64decode(d["privateKeyData"]).decode()

    def delete_sa_key(self, sa_email: str, key_id: str) -> None:
        r = self.http.delete(f"{IAM}/projects/{self.project}/serviceAccounts/{sa_email}/keys/{key_id}")
        if r.status_code != 404:
            r.raise_for_status()

    # ---- datasets -----------------------------------------------------------------------------------------------
    def datasets(self) -> dict[str, dict]:
        """This repo's datasets only (the project is shared: other repos' datasets are never read). Special-group
        entries come back as `specialGroup:<name>` so the plan can remove project-wide access."""
        out = {}
        for item in self.bq.list_datasets():
            if not item.dataset_id.startswith(DATASET_PREFIX):
                continue
            ds = self.bq.get_dataset(item.reference)
            access = set()
            for e in ds.access_entries:
                member = e.entity_id if isinstance(e.entity_id, str) else json.dumps(e.entity_id)
                prefix = {"userByEmail": "user:", "groupByEmail": "group:", "specialGroup": "specialGroup:", "iamMember": "iamMember:"}.get(e.entity_type, "")
                if member.endswith(".iam.gserviceaccount.com"):
                    prefix = "serviceAccount:"
                access.add((e.role, prefix + member))
            out[ds.dataset_id] = {"max_time_travel_hours": int(ds.max_time_travel_hours) if ds.max_time_travel_hours else None, "access": access}
        return out

    @staticmethod
    def _entry(role: str, member: str):
        from google.cloud import bigquery

        kind, ident = member.split(":", 1)
        entity_type = {"user": "userByEmail", "serviceAccount": "userByEmail", "group": "groupByEmail", "specialGroup": "specialGroup", "iamMember": "iamMember"}[kind]
        return bigquery.AccessEntry(role=role, entity_type=entity_type, entity_id=ident)

    def create_dataset(self, ds: dict, owner: str) -> None:
        """Creates the dataset with an explicit access list (the creating user and the spec's entries). Without one,
        BigQuery adds projectReaders, projectWriters and projectOwners, so every Viewer, Editor and Owner of the shared
        project (other repos' identities included) could read this repo's data."""
        from google.cloud import bigquery

        d = bigquery.Dataset(f"{self.project}.{ds['dataset']}")
        d.location = ds["location"]
        d.access_entries = [self._entry("OWNER", owner), *(self._entry(a["role"], a["member"]) for a in ds["access"])]
        self.bq.create_dataset(d, exists_ok=True)

    def remove_dataset_access(self, dataset: str, entries: list[tuple[str, str]]) -> None:
        """Read-modify-write of the dataset's access list without the given (role, member) entries."""
        ds = self.bq.get_dataset(f"{self.project}.{dataset}")
        drop = {(r, m.split(":", 1)[1]) for r, m in entries}
        ds.access_entries = [e for e in ds.access_entries if (e.role, e.entity_id if isinstance(e.entity_id, str) else None) not in drop]
        self.bq.update_dataset(ds, ["access_entries"])

    def set_time_travel(self, dataset: str, hours: int) -> None:
        from peoplevault.bqjob import run_query

        run_query(self.bq, f"ALTER SCHEMA `{self.project}.{dataset}` SET OPTIONS (max_time_travel_hours = {int(hours)})").result()

    def add_dataset_access(self, dataset: str, role: str, member: str) -> None:
        ds = self.bq.get_dataset(f"{self.project}.{dataset}")
        entries = list(ds.access_entries)
        entries.append(self._entry(role, member))
        ds.access_entries = entries
        self.bq.update_dataset(ds, ["access_entries"])

    # ---- policy tags and data policies --------------------------------------------------------------------------
    def _ptm(self):
        from google.cloud import datacatalog_v1

        return datacatalog_v1.PolicyTagManagerClient(credentials=self.creds)

    def taxonomy(self, display_name: str) -> dict | None:
        ptm = self._ptm()
        parent = f"projects/{self.project}/locations/us"
        for t in ptm.list_taxonomies(parent=parent):
            if t.display_name == display_name:
                tags = {p.display_name: p.name for p in ptm.list_policy_tags(parent=t.name)}
                return {"name": t.name, "tags": tags}
        return None

    def create_taxonomy(self, tax: dict) -> dict:
        from google.cloud import datacatalog_v1

        t = self._ptm().create_taxonomy(parent=f"projects/{self.project}/locations/{tax['location']}", taxonomy=datacatalog_v1.Taxonomy(
            display_name=tax["display_name"], activated_policy_types=[datacatalog_v1.Taxonomy.PolicyType.FINE_GRAINED_ACCESS_CONTROL]))
        return {"name": t.name, "tags": {}}

    def create_policy_tag(self, taxonomy_name: str, display_name: str, description: str) -> str:
        from google.cloud import datacatalog_v1

        return self._ptm().create_policy_tag(parent=taxonomy_name, policy_tag=datacatalog_v1.PolicyTag(display_name=display_name, description=description)).name

    def taxonomy_bindings(self, taxonomy_name: str) -> set[tuple[str, str]]:
        policy = self._ptm().get_iam_policy(request={"resource": taxonomy_name})
        return {(b.role, m) for b in policy.bindings for m in b.members}

    def add_taxonomy_binding(self, taxonomy_name: str, role: str, member: str) -> None:
        """Resource-scoped (the taxonomy, never the shared project): read-modify-write of the taxonomy's IAM policy."""
        ptm = self._ptm()
        policy = ptm.get_iam_policy(request={"resource": taxonomy_name})
        for b in policy.bindings:
            if b.role == role:
                if member not in b.members:
                    b.members.append(member)
                break
        else:
            policy.bindings.add(role=role, members=[member])
        ptm.set_iam_policy(request={"resource": taxonomy_name, "policy": policy})

    def tag_readers(self, tag_name: str) -> set[str]:
        policy = self._ptm().get_iam_policy(request={"resource": tag_name})
        return {m for b in policy.bindings if b.role == "roles/datacatalog.categoryFineGrainedReader" for m in b.members}

    def add_tag_reader(self, tag_name: str, member: str) -> None:
        ptm = self._ptm()
        policy = ptm.get_iam_policy(request={"resource": tag_name})
        for b in policy.bindings:
            if b.role == "roles/datacatalog.categoryFineGrainedReader":
                if member not in b.members:
                    b.members.append(member)
                break
        else:
            policy.bindings.add(role="roles/datacatalog.categoryFineGrainedReader", members=[member])
        ptm.set_iam_policy(request={"resource": tag_name, "policy": policy})

    def _dp(self):
        from google.cloud import bigquery_datapolicies_v2

        return bigquery_datapolicies_v2.DataPolicyServiceClient(credentials=self.creds)

    def data_policies(self) -> set[str]:
        return {p.data_policy_id for p in self._dp().list_data_policies(parent=f"projects/{self.project}/locations/us")}

    def create_data_policy(self, dp: dict, tag_name: str) -> None:
        from google.cloud import bigquery_datapolicies_v2 as v2

        policy = v2.DataPolicy(
            data_policy_id=dp["data_policy_id"], policy_tag=tag_name, data_policy_type=v2.DataPolicy.DataPolicyType.DATA_MASKING_POLICY,
            data_masking_policy=v2.DataMaskingPolicy(predefined_expression=getattr(v2.DataMaskingPolicy.PredefinedExpression, dp["predefined_expression"])),
            grantees=list(dp["grantees"]),  # member format accepted by the v2 API is unverified (SPEC.md section 27)
        )
        self._dp().create_data_policy(parent=f"projects/{self.project}/locations/us", data_policy_id=dp["data_policy_id"], data_policy=policy)
