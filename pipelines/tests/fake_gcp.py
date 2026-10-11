"""In-memory GcpClient for the setup dry-run golden tests."""

from __future__ import annotations

from peoplevault.setup.gcp import fill, spec


class ServiceDisabled(Exception):
    """What Google answers for a call through an API that is off: 403 PERMISSION_DENIED, reason SERVICE_DISABLED."""


class NotFound(Exception):
    """404 for a resource that does not exist (for example the IAM policy of a service account not yet created)."""


class FakeGcp:
    """`strict=True` behaves like the real project on 2026-10-11 (read-only check of master-magnet-444903-u4): a read
    or write through an API that is not enabled raises ServiceDisabled, and the IAM policy of a missing service account
    raises NotFound. The default is lenient (every read finds what exists)."""

    API_OF = {"service_accounts": "iam.googleapis.com", "create_service_account": "iam.googleapis.com", "custom_roles": "iam.googleapis.com",
              "create_custom_role": "iam.googleapis.com", "sa_bindings": "iam.googleapis.com", "add_sa_binding": "iam.googleapis.com", "create_sa_key": "iam.googleapis.com",
              "project_bindings": "cloudresourcemanager.googleapis.com", "add_project_bindings": "cloudresourcemanager.googleapis.com",
              "datasets": "bigquery.googleapis.com", "create_dataset": "bigquery.googleapis.com", "set_time_travel": "bigquery.googleapis.com", "add_dataset_access": "bigquery.googleapis.com",
              "taxonomy": "datacatalog.googleapis.com", "create_taxonomy": "datacatalog.googleapis.com", "create_policy_tag": "datacatalog.googleapis.com",
              "taxonomy_bindings": "datacatalog.googleapis.com", "add_taxonomy_binding": "datacatalog.googleapis.com", "tag_readers": "datacatalog.googleapis.com",
              "add_tag_reader": "datacatalog.googleapis.com", "data_policies": "bigquerydatapolicy.googleapis.com", "create_data_policy": "bigquerydatapolicy.googleapis.com"}

    def __getattribute__(self, name):
        attr = object.__getattribute__(self, name)
        api = FakeGcp.API_OF.get(name)
        if api is None or not object.__getattribute__(self, "strict"):
            return attr

        def guarded(*args, **kwargs):
            if api not in object.__getattribute__(self, "apis"):
                object.__getattribute__(self, "calls").append(f"refused:{name}")
                raise ServiceDisabled(f"403 {api} has not been used in project or it is disabled (SERVICE_DISABLED)")
            if name in ("sa_bindings", "add_sa_binding") and args[0].split("@")[0] not in object.__getattribute__(self, "sas"):
                raise NotFound(f"404 service account {args[0]} does not exist")
            return attr(*args, **kwargs)

        return guarded

    def __init__(self, project: str = "pv-test", user: str = "owner@example.test", complete: bool = False, strict: bool = False, apis: set[str] | None = None):
        self.strict = strict
        self.project, self.user = project, user
        self.apis: set[str] = set()
        self.sas: set[str] = set()
        self.roles: set[str] = set()
        self.proj: set[tuple[str, str]] = set()
        self.sab: dict[str, set] = {}
        self.ds: dict[str, dict] = {}
        self.tax: dict | None = None
        self.readers: dict[str, set] = {}
        self.taxb: set[tuple[str, str]] = set()
        self.dps: set[str] = set()
        self.calls: list[str] = []
        if complete:
            self._complete()
        if apis is not None:
            self.apis = set(apis)

    def _complete(self):
        iam = fill(spec("iam_bindings"), self.project, self.user)
        self.apis = set(iam["apis"])
        self.sas = {s["account_id"] for s in spec("service_accounts")}
        self.roles = {r["role_id"] for r in spec("custom_roles")}
        self.proj = {(b["role"], b["member"]) for b in iam["project"]}
        for b in iam["service_account"]:
            self.sab.setdefault(b["service_account"], set()).add((b["role"], b["member"]))
        for d in fill(spec("datasets"), self.project, self.user):
            self.ds[d["dataset"]] = {"max_time_travel_hours": d["max_time_travel_hours"], "access": {(a["role"], a["member"]) for a in d["access"]}}
        for r in fill(spec("custom_roles"), self.project, self.user):
            for g in r["grants"]:
                self.ds[g["dataset"]]["access"].add((f"projects/{self.project}/roles/{r['role_id']}", g["member"]))
        tags = {t["display_name"]: f"projects/{self.project}/locations/us/taxonomies/1/policyTags/{i}" for i, t in enumerate(spec("taxonomy")["policy_tags"], start=1)}
        self.tax = {"name": f"projects/{self.project}/locations/us/taxonomies/1", "tags": tags}
        for cls, members in iam["fine_grained_reader"].items():
            self.readers[tags[cls]] = set(members)
        self.taxb = {(b["role"], b["member"]) for b in iam["taxonomy"]}
        self.dps = {d["data_policy_id"] for d in spec("data_policies")}

    def enabled_apis(self):
        return set(self.apis)
    def enable_apis(self, apis):
        self.calls.append("enable_apis")
        self.apis |= set(apis)
    def service_accounts(self):
        return set(self.sas)
    def create_service_account(self, a, d):
        self.calls.append(f"sa:{a}")
        self.sas.add(a)
    def custom_roles(self):
        return set(self.roles)
    def create_custom_role(self, r):
        self.calls.append(f"role:{r['role_id']}")
        self.roles.add(r["role_id"])
    def project_bindings(self):
        return set(self.proj)
    def add_project_bindings(self, b):
        self.calls.append("project_bindings")
        self.proj |= set(b)
    def sa_bindings(self, e):
        return set(self.sab.get(e, set()))
    def add_sa_binding(self, e, r, m):
        self.calls.append(f"sab:{e}")
        self.sab.setdefault(e, set()).add((r, m))
    def datasets(self):
        return {k: {"max_time_travel_hours": v["max_time_travel_hours"], "access": set(v["access"])} for k, v in self.ds.items()}
    def create_dataset(self, d):
        self.calls.append(f"ds:{d['dataset']}")
        self.ds[d["dataset"]] = {"max_time_travel_hours": None, "access": set()}
    def set_time_travel(self, d, h):
        self.calls.append(f"tt:{d}")
        self.ds[d]["max_time_travel_hours"] = h
    def add_dataset_access(self, d, r, m):
        self.calls.append(f"acl:{d}")
        self.ds[d]["access"].add((r, m))
    def taxonomy(self, n):
        return None if self.tax is None else {"name": self.tax["name"], "tags": dict(self.tax["tags"])}
    def create_taxonomy(self, t):
        self.calls.append("taxonomy")
        self.tax = {"name": f"projects/{self.project}/locations/us/taxonomies/1", "tags": {}}
        return self.taxonomy("x")
    def create_policy_tag(self, tn, d, desc):
        name = f"{tn}/policyTags/{len(self.tax['tags']) + 1}"
        self.calls.append(f"tag:{d}")
        self.tax["tags"][d] = name
        return name
    def taxonomy_bindings(self, t):
        return set(self.taxb)
    def add_taxonomy_binding(self, t, r, m):
        self.calls.append("taxonomy-iam")
        self.taxb.add((r, m))
    def tag_readers(self, t):
        return set(self.readers.get(t, set()))
    def add_tag_reader(self, t, m):
        self.calls.append("reader")
        self.readers.setdefault(t, set()).add(m)
    def data_policies(self):
        return set(self.dps)
    def create_data_policy(self, dp, t):
        self.calls.append(f"dp:{dp['data_policy_id']}")
        self.dps.add(dp["data_policy_id"])
    def create_sa_key(self, e):
        self.calls.append("key")
        return f'{{"type": "service_account", "client_email": "{e}", "private_key": "x"}}'
