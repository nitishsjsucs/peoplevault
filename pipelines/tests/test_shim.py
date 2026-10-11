import json
import urllib.error
import urllib.request

import pytest

from peoplevault.shim.queries import ShimError, resolve, run_named
from peoplevault.shim.server import start
from peoplevault.warehouse.duck import DuckWarehouse


def test_purpose_cannot_read_another_purpose_schema():
    with pytest.raises(ShimError) as e:
        resolve("workforce_analytics", "employee_relations.list", {"org_units": ["X"], "cursor": "", "limit": 10})
    assert e.value.status == 403 and e.value.code == "purpose_dataset_denied"


def test_unknown_query_id_rejected():
    with pytest.raises(ShimError) as e:
        resolve("employee_relations", "employee_relations.everything", {})
    assert e.value.code == "unknown_query"


def test_params_are_typed_and_exact():
    with pytest.raises(ShimError):
        resolve("team_management", "team_management.list", {"manager_key": ["x"], "cursor": "", "limit": 10})
    with pytest.raises(ShimError):
        resolve("team_management", "team_management.list", {"manager_key": "x", "cursor": "", "limit": 10, "extra": 1})
    with pytest.raises(ShimError):
        resolve("team_management", "team_management.list", {"manager_key": "x", "cursor": "", "limit": 100000})
    sql, bound = resolve("team_management", "team_management.list", {"manager_key": "x", "cursor": "", "limit": 10})
    assert "pv_purpose_team_management.direct_reports($manager_key)" in sql and bound["limit"] == 10


def test_http_token_required_and_query_runs(full_load):
    wh = DuckWarehouse.open(full_load["duckdb"])
    server, _ = start(wh, "test-token", 0)
    port = server.server_address[1]
    body = json.dumps({"purpose": "workforce_analytics", "query_id": "workforce_analytics.headcount_monthly", "params": {}}).encode()

    def post(token):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/query", data=body, method="POST", headers={"content-type": "application/json", "X-PV-Shim-Token": token})
        return urllib.request.urlopen(req, timeout=10)

    try:
        with pytest.raises(urllib.error.HTTPError) as e:
            post("wrong")
        assert e.value.code == 401
        res = json.loads(post("test-token").read())
        assert res["backend"] == "duckdb-shim" and len(res["rows"]) > 0
        assert set(res["rows"][0]) == {"month", "org_unit", "job_level", "headcount"}
        rows = run_named(wh, "employee_relations", "employee_relations.list", {"org_units": ["LEGAL"], "cursor": "", "limit": 5})
        assert len(rows) == 5 and all(r["org_unit"] == "LEGAL" for r in rows)
        page2 = run_named(wh, "employee_relations", "employee_relations.list", {"org_units": ["LEGAL"], "cursor": rows[-1]["employee_ref"], "limit": 5})
        assert page2 and page2[0]["employee_ref"] > rows[-1]["employee_ref"]
    finally:
        server.shutdown()
