"""`pv eval deletion --profile prod` (SPEC.md section 19.1, production profile). Status: written, not yet executed.

Same flow as the local profiles against the deployed Worker, BigQuery and the Basin Catalog, with the cohorts of
`cohorts.json["prod"]` from the production synth output (data/generated-prod): 6 DSRs (D), 1 held subject (H) and 5
planted residues of designed types, one per store (F). No retention sweep runs in this profile. Steps: plant the
faults straight into R2, KV, D1, BigQuery and the Basin Catalog; warm the production caches through the deployed API
with the persona service tokens (entries of the four mapped principals); submit D, H and F as privacy-01 and run the
production executor in a thread until every request is terminal; run the production residual check (BigQuery time
travel observed right after deletion: pending); capture the report; scan every production store with the
independent oracle; remove the planted faults; score with the same code as the local profiles. Writes
evals/results/deletion-prod-<date>.{json,md}. Run `pv residuals check --target prod` again after 48 hours.
"""

from __future__ import annotations

import base64
import json
import threading
import time

from peoplevault import config
from peoplevault.evals import faults as faults_mod
from peoplevault.evals.client import ProdClient
from peoplevault.evals.deletion import (
    PROD_REQUEST_POLL_S,
    RunData,
    _log,
    _wait_requests,
    score,
    verify_audit_chain,
    write,
)
from peoplevault.evals.oracle import OracleSources, run_oracle, subject_tokens
from peoplevault.evals.prod_stores import CloudflareRest, cleanup_prod, d1_query, oauth_token, plant_prod
from peoplevault.evals.report import header
from peoplevault.evals.warmup import warm_kv

PROD_ENVIRONMENT = "production (Cloudflare Workers, Workflows, R2, D1, KV and Access; BigQuery; Basin Catalog)"
PROD_GENERATED = config.REPO_ROOT / "data" / "generated-prod"
TIMEOUT_S = 90 * 60


def _truth(name: str):
    return json.loads((PROD_GENERATED / "truth" / name).read_text())


def run_prod(*, keep_faults: bool = False) -> dict:
    from peoplevault.executor.loop import PROD_POLL_S, start_thread
    from peoplevault.executor.prod import prod_api, prod_context
    from peoplevault.lake.catalog import open_catalog
    from peoplevault.residuals.check_prod import check_prod
    from peoplevault.warehouse.bq import BqWarehouse

    t_start = time.time()
    run_header = header("pv eval deletion --profile prod", "prod", environment=PROD_ENVIRONMENT)
    env = config.prod_env()
    project = env.get("PV_GCP_PROJECT")
    account = env.get("CLOUDFLARE_ACCOUNT_ID")
    kv_ns = config.prod_resources().get("kv_id")
    secrets = config.parse_env_file(config.SECRETS_DIR / "worker-secrets.env")
    if not (project and account and kv_ns and secrets.get("PV_PSEUDONYM_MASTER_KEY") and (PROD_GENERATED / "truth").is_dir()):
        raise RuntimeError("production is not set up: run `npm run setup:prod` (and `npm run doctor -- --prod`) first")
    expected = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())
    truth = {t["employee_id"]: t for t in _truth("subjects.json")}
    cohorts = _truth("cohorts.json")["prod"]
    master = base64.b64decode(secrets["PV_PSEUDONYM_MASTER_KEY"])
    tokens = {e: subject_tokens(master, t) for e, t in truth.items()}
    principals = _truth("principals.json")
    principal_of = {p["employee_id"]: p["id"] for p in principals if p.get("employee_id")}
    client = ProdClient(env)
    warmup = [w for w in _truth("kv_warmup.json") if w["principal"] in client.principals()]
    cohort_ids = set(cohorts["D"]) | set(cohorts["H"]) | {f["subject"] for f in cohorts["F"]}
    other = next(e for e in sorted(truth) if e not in cohort_ids and truth[e]["status"] == "active" and not truth[e]["hold_matter"])
    plan_subjects = {e: {"tokens": {"employee_id": e, "work_email": tokens[e].work_email, "full_name": tokens[e].full_name, "employee_ref": tokens[e].employee_ref,
                                    "warehouse_key": tokens[e].warehouse_key, "analytics_id": tokens[e].analytics_id}} for e in cohort_ids}
    plan, actions, planted = faults_mod.build_plan(cohorts["F"], [], plan_subjects, other)

    if int(d1_query("SELECT COUNT(*) AS n FROM deletion_requests")[0]["n"]):
        raise RuntimeError("the production eval runs once, on a freshly seeded project (deletion requests already exist; their subjects are gone)")
    cf = CloudflareRest(account, oauth_token())
    wh = BqWarehouse(project)
    cat = open_catalog("prod")
    _log(f"planting {len(planted)} faults in production stores")
    targets = plant_prod(plan, actions, cf=cf, kv_namespace=kv_ns, wh=wh, cat=cat, project=project)
    stop = threading.Event()
    ctx = None
    try:
        _log("warming production caches through the API")
        warm = warm_kv(client, warmup)
        kv_after = len(cf.kv_keys(kv_ns))
        _log("submitting D, H and F requests; running the production executor")
        submitted: dict[str, str] = {}
        for e in list(cohorts["D"]) + list(cohorts["H"]) + [f["subject"] for f in cohorts["F"]]:
            r = client.request("privacy-01", "POST", "/api/v1/privacy/deletion-requests", {"employee_ref": tokens[e].employee_ref, "reason": "eval data subject request"})
            if r.status_code != 202:
                raise RuntimeError(f"DSR submission failed with {r.status_code}")
            submitted[r.json()["requestId"]] = e
        ctx = prod_context()
        start_thread(prod_api(), ctx, stop, poll=PROD_POLL_S)
        _wait_requests(client, set(submitted), TIMEOUT_S, poll_s=PROD_REQUEST_POLL_S)
        stop.set()
        report_before = client.request("privacy-01", "GET", "/api/v1/privacy/reports/deletion").json()
        _log("production residual check")
        check_out = json.dumps(check_prod(prod_api(), wh, cat))
        report = client.request("privacy-01", "GET", "/api/v1/privacy/reports/deletion").json()
        audit_ok = verify_audit_chain(client)
        _log("oracle over the production stores")
        requests = d1_query("SELECT id, kind, subject_ref, status, created_at, completed_at FROM deletion_requests")
        results = d1_query("SELECT request_id, asset_id, category, applicability, action_status, verify_status, verify_matches FROM deletion_asset_results")
        residual_rows = d1_query("SELECT request_id, kind, state, evidence FROM residuals")
        sources = OracleSources(r2_objects=lambda: cf.r2_objects(["pv-source-exports", "pv-derived"]), kv_items=lambda: cf.kv_items(kv_ns), d1_query=d1_query,
                                warehouse=wh, catalog=cat)
        found = run_oracle({e: tokens[e] for e in cohort_ids}, sources=sources)
    finally:
        stop.set()
        if not keep_faults:
            left = cleanup_prod(targets, cf=cf, kv_namespace=kv_ns, wh=wh, cat=cat, project=project)
            if left:
                _log(f"could not remove planted faults: {', '.join(left)}")
        if ctx is not None:
            ctx.wh.close()
    result = score(RunData(
        profile="prod", run_header=run_header, t_start=t_start, truth=truth, cohorts={**cohorts, "R": []}, tokens=tokens, expected=expected, warmup=warmup,
        principal_of=principal_of, planted=planted, submitted=submitted, requests=requests, results=results, residual_rows=residual_rows, found=found,
        retention_run=None, report_before=report_before, report=report, audit_ok=audit_ok, warmup_counts={**warm, "kv_keys_after_warmup": kv_after},
        expire_out="not run in production (managed snapshot expiration, ADR 0004)", check_out=check_out,
    ))
    write(result)
    return result
