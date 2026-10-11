"""Production eval store access with recorded-style responses (httpx MockTransport): R2 and KV listing with cursors,
object and value reads, planting and cleanup of exactly what was planted, and the BigQuery form of the fault SQL.
The response shapes follow the Cloudflare API reference (2026-10-10); none was captured from production yet."""


import httpx
import pytest

from peoplevault.evals.prod_stores import (
    CloudflareRest,
    ProdTargets,
    bigquery_sql,
    cleanup_prod,
    d1_statements,
    plant_prod,
)


def raw(req: httpx.Request) -> str:
    """The path as sent on the wire (percent-encoded), without the query string."""
    return req.url.raw_path.decode().split("?")[0]


def envelope(result, info=None, status=200):
    return httpx.Response(status, json={"success": status < 400, "errors": [] if status < 400 else [{"code": 10000, "message": "x"}], "result": result, **({"result_info": info} if info else {})})


def client(handler):
    return CloudflareRest("acct", "tok-value-zq", httpx.Client(transport=httpx.MockTransport(handler)))


def test_r2_list_follows_cursors_and_reads_bodies_and_metadata():
    seen = []

    def handler(req: httpx.Request):
        seen.append((req.method, raw(req), dict(req.url.params), req.headers["authorization"]))
        if raw(req).endswith("/objects") and "cursor" not in req.url.params:
            return envelope([{"key": "exports/a.jsonl", "custom_metadata": {"owner": "er_x"}}], {"cursor": "c1", "is_truncated": True})
        if raw(req).endswith("/objects"):
            return envelope([{"key": "notes/b c.txt"}], {"cursor": "", "is_truncated": False})
        return httpx.Response(200, content=b"body:" + raw(req).rsplit("/", 1)[1].encode())

    objs = list(client(handler).r2_objects(["pv-source-exports"]))
    assert [(o.key, o.custom_metadata) for o in objs] == [("exports/a.jsonl", {"owner": "er_x"}), ("notes/b c.txt", {})]
    assert objs[1].body == b"body:notes%2Fb%20c.txt"
    assert all(h == "Bearer tok-value-zq" for *_, h in seen)
    assert seen[1][2]["cursor"] == "c1"


def test_kv_keys_values_and_missing_values():
    def handler(req: httpx.Request):
        if raw(req).endswith("/keys"):
            return envelope([{"name": "profile:x"}, {"name": "tmp:er_y"}], {"cursor": ""})
        if raw(req).endswith("tmp%3Aer_y"):
            return httpx.Response(404, json={"success": False, "errors": [{"code": 10009}]})
        return httpx.Response(200, text='{"v":1}')

    assert client(handler).kv_items("ns") == [("profile:x", '{"v":1}'), ("tmp:er_y", "")]


def test_api_errors_never_carry_the_token():
    with pytest.raises(RuntimeError) as e:
        client(lambda req: envelope(None, status=403)).kv_keys("ns")
    assert "tok-value-zq" not in str(e.value) and "403" in str(e.value)


def test_bigquery_form_of_the_fault_sql():
    assert bigquery_sql("create table pv_core.tmp_backup_2 (employee_key varchar, full_name varchar)", "p") == \
        "create table `p.pv_core.tmp_backup_2` (employee_key STRING, full_name STRING)"
    assert bigquery_sql("insert into pv_core.tmp_backup_2 values ('wk_a', 'Ann Lee')", "p") == "insert into `p.pv_core.tmp_backup_2` values ('wk_a', 'Ann Lee')"
    assert bigquery_sql("create schema if not exists scratch", "p") == "CREATE SCHEMA IF NOT EXISTS `p.scratch` OPTIONS (location = 'US')"
    assert d1_statements("CREATE TABLE IF NOT EXISTS t (a TEXT); INSERT INTO t VALUES ('x');") == ["CREATE TABLE IF NOT EXISTS t (a TEXT)", "INSERT INTO t VALUES ('x')"]


class FakeWh:
    def __init__(self):
        self.sql = []

    def query(self, sql, params=None):
        self.sql.append(sql)
        return []


class FakeCat:
    def __init__(self):
        self.ns, self.tables, self.dropped = set(), {}, []

    def list_namespaces(self):
        return [(n,) for n in self.ns]

    def create_namespace(self, n):
        self.ns.add(n)

    def create_table(self, name, schema):
        cat = self

        class T:
            def append(self, data):
                cat.tables[name] = data.num_rows

        return T()

    def purge_table(self, name):
        self.dropped.append(name)

    def drop_namespace(self, n):
        self.dropped.append(n)


def test_plant_then_cleanup_removes_exactly_what_was_planted():
    calls = []

    def handler(req: httpx.Request):
        calls.append((req.method, raw(req)))
        return envelope({})

    cf = client(handler)
    wh, cat, d1, puts = FakeWh(), FakeCat(), [], []
    plan = {"r2": [{"bucket": "pv-source-exports", "key": "exports/adhoc/backup-1.jsonl", "body": "{}\n"}], "kv": [{"key": "tmp:er_a", "value": "1"}],
            "d1": ["CREATE TABLE IF NOT EXISTS support_notes (id TEXT, body TEXT); INSERT INTO support_notes VALUES ('n5', 'call from E1 today');"]}
    actions = [{"kind": "duckdb", "sql": ["create table pv_core.tmp_backup_2 (employee_key varchar, full_name varchar)", "insert into pv_core.tmp_backup_2 values ('wk_a', 'A B')"]},
               {"kind": "lake", "table": "hr_history.adhoc_backup_3", "rows": {"employee_key": ["wk_a"]}}]
    t = plant_prod(plan, actions, cf=cf, kv_namespace="ns", wh=wh, cat=cat, project="p", d1=d1.append, put_object=lambda b, k, body: puts.append((b, k)))
    assert t == ProdTargets(r2=[("pv-source-exports", "exports/adhoc/backup-1.jsonl")], kv=["tmp:er_a"], d1_tables=["support_notes"], bq_tables=["pv_core.tmp_backup_2"],
                            bq_schemas=[], lake_tables=["hr_history.adhoc_backup_3"], lake_namespaces=["hr_history"])
    assert len(d1) == 2 and puts == [("pv-source-exports", "exports/adhoc/backup-1.jsonl")] and cat.tables == {"hr_history.adhoc_backup_3": 1}
    assert cleanup_prod(t, cf=cf, kv_namespace="ns", wh=wh, cat=cat, project="p", d1=d1.append) == []
    assert d1[-1] == "DROP TABLE IF EXISTS support_notes"
    assert wh.sql[-1] == "DROP TABLE IF EXISTS `p.pv_core.tmp_backup_2`"
    assert ("DELETE", "/client/v4/accounts/acct/r2/buckets/pv-source-exports/objects/exports%2Fadhoc%2Fbackup-1.jsonl") in calls
    assert cat.dropped == ["hr_history.adhoc_backup_3", "hr_history"]


def test_custom_metadata_faults_are_refused_in_production():
    with pytest.raises(ValueError):
        plant_prod({"r2": [{"bucket": "b", "key": "k", "body": "", "customMetadata": {"o": "x"}}], "kv": [], "d1": []}, [], cf=None, kv_namespace="ns", wh=None, cat=None,
                   project="p", put_object=lambda *a: None)




def test_prod_client_sends_the_persona_service_token_and_csrf_header():
    from peoplevault.evals.client import ProdClient

    seen = []

    def handler(req: httpx.Request):
        seen.append((req.method, str(req.url), req.headers.get("CF-Access-Client-Id"), req.headers.get("CF-Access-Client-Secret"), req.headers.get("X-PV-Requested-With")))
        return httpx.Response(202, json={"requestId": "r1"})

    env = {"PV_BASE_URL": "https://peoplevault.example.workers.dev/", "PV_CF_ACCESS_CLIENT_ID_PRIVACY": "pr.access", "PV_CF_ACCESS_CLIENT_SECRET_PRIVACY": "s",
           "PV_CF_ACCESS_CLIENT_ID_HR": "hr.access"}
    c = ProdClient(env, httpx.Client(transport=httpx.MockTransport(handler)))
    assert c.principals() == {"privacy-01"}  # the HR token has no recorded secret
    c.request("privacy-01", "POST", "/api/v1/privacy/deletion-requests", {"employee_ref": "er_x"})
    c.request("privacy-01", "GET", "/api/v1/me")
    assert seen == [("POST", "https://peoplevault.example.workers.dev/api/v1/privacy/deletion-requests", "pr.access", "s", "peoplevault"),
                    ("GET", "https://peoplevault.example.workers.dev/api/v1/me", "pr.access", "s", None)]
    with pytest.raises(RuntimeError):
        ProdClient({"PV_BASE_URL": "https://x"})


def test_truth_applicability_without_a_retention_sweep_keeps_every_export_and_the_whole_lake():
    from peoplevault.evals.deletion import _truth_applicability

    expected = {"retention_expected": {"expired_export_keys": ["exports/hris/a.jsonl"], "minimized_export_keys": []}}
    t = {"export_rows": {"exports/hris/a.jsonl": 1}, "export_refs": {}, "hold_matter": None, "lake_rows": 4, "lake_ref_rows": 0,
         "lake_rows_after_retention_cutoff": 0, "lake_ref_rows_after_retention_cutoff": 0}
    assert _truth_applicability("src.r2.exports", t, expected, [], {}, None) == "not_present"
    assert _truth_applicability("src.r2.exports", t, expected, [], {}, None, retention_ran=False) == "present"
    assert _truth_applicability("hist.lake.employee_monthly", t, expected, [], {}, None) == "not_present"
    assert _truth_applicability("hist.lake.employee_monthly", t, expected, [], {}, None, retention_ran=False) == "present"
