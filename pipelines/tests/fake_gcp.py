"""In-memory GcpClient for the setup dry-run golden tests."""

from __future__ import annotations

from peoplevault.setup.gcp import fill, spec


class FakeGcp:
    def __init__(self, project: str = "pv-test", user: str = "owner@example.test", complete: bool = False):
        self.project, self.user = project, user
        self.apis: set[str] = set()
        self.sas: set[str] = set()
        self.roles: set[str] = set()
        self.proj: set[tuple[str, str]] = set()
        self.sab: dict[str, set] = {}
        self.ds: dict[str, dict] = {}
        self.tax: dict | None = None
        self.readers: dict[str, set] = {}
        self.dps: set[str] = set()
        self.calls: list[str] = []
        if complete:
            self._complete()

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
