"""`pv eval deletion --profile full|ci|prod [--no-seed]` (SPEC.md section 19.1).

Procedure (full and ci): seed (fresh) and plant faults; start wrangler dev and pv serve; warm the caches right before
submitting; run the retention sweep as privacy-01 and wait for it and its requests; submit the D, H and F requests
together and wait until all are terminal; local lake expiry and the residual check; capture the report and every
receipt; stop both servers; then run the independent oracle over every store and compute the metrics. Writes
evals/results/deletion-<profile>-<date>.json and .md. Every number in the README comes from these files.
"""

from __future__ import annotations

import json
import statistics
import subprocess
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime

from peoplevault import config
from peoplevault.evals import faults as faults_mod
from peoplevault.evals.client import LocalClient
from peoplevault.evals.oracle import (
    OracleFindings,
    SubjectTokens,
    _json_out,
    _wrangler,
    d1_query,
    run_oracle,
    subject_tokens,
)
from peoplevault.evals.report import header, write_result
from peoplevault.evals.warmup import create_extracts, load_truth, warm_kv

CATEGORIES = ["source_exports", "warehouse_tables", "historical_snapshots", "identity_mappings", "derived_datasets", "application_caches"]
TERMINAL = {"completed", "completed_with_residuals", "failed", "held"}
TIMEOUT_S = {"full": 30 * 60, "ci": 15 * 60}


def _node(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    res = subprocess.run(["node", *args], cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    if check and res.returncode != 0:
        raise RuntimeError(f"node {args[0]} failed: {res.stderr[-400:]}")
    return res


def _pv(args: list[str]) -> str:
    res = subprocess.run(["uv", "run", "--project", "pipelines", "pv", *args], cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"pv {args[0]} failed: {res.stderr[-400:]}")
    return res.stdout.strip()


def _log(msg: str) -> None:
    print(f"[eval] {msg}", flush=True)


def _wait_requests(client: LocalClient, ids: set[str], timeout_s: int) -> dict[str, dict]:
    deadline = time.time() + timeout_s
    while True:
        r = client.request("privacy-01", "GET", "/api/v1/privacy/deletion-requests")
        r.raise_for_status()
        rows = {x["id"]: x for x in r.json()["requests"] if x["id"] in ids}
        if len(rows) == len(ids) and all(x["status"] in TERMINAL for x in rows.values()):
            return rows
        if time.time() > deadline:
            pending = sorted(i for i in ids if rows.get(i, {}).get("status") not in TERMINAL)
            raise TimeoutError(f"{len(pending)} request(s) not terminal after {timeout_s} s")
        time.sleep(2)


def _wait_run(client: LocalClient, run_id: str, timeout_s: int) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        runs = client.request("privacy-01", "GET", "/api/v1/privacy/retention/runs").json()["runs"]
        run = next((r for r in runs if r["id"] == run_id), None)
        if run and run["status"] in ("completed", "failed"):
            return run
        time.sleep(2)
    raise TimeoutError("retention run did not finish")


def _pairs(rows: list[dict]) -> list[dict]:
    """Applicable pairs: present, not_present with residue or error, and unregistered locations."""
    out = []
    for r in rows:
        if r["applicability"] in ("present", "unregistered") or (r["applicability"] == "not_present" and r["verify_status"] in ("residue", "error")):
            out.append(r)
    return out


def _coverage(clean: int, applicable: int) -> dict:
    return {"value": (clean / applicable) if applicable else None, "display": f"{100 * clean / applicable:.1f}%" if applicable else "n/a", "applicable_pairs": applicable, "clean_pairs": clean}


def _truth_applicability(asset_id: str, t: dict, expected: dict, warmup: list[dict], principal_of: dict, refs: SubjectTokens, *, retention_ran: bool = True) -> str | None:
    """Ground truth for one pair. Without a retention sweep (the production profile) every export object is kept and
    the whole lake history counts."""
    expired = set(expected["retention_expected"]["expired_export_keys"]) if retention_ran else set()
    minimized = set(expected["retention_expected"]["minimized_export_keys"])
    held = t["hold_matter"] is not None

    def kept(key: str) -> bool:
        return key not in expired or (key in minimized and held)

    if asset_id == "src.r2.exports":
        return "present" if any(kept(k) for k in list(t["export_rows"]) + list(t["export_refs"])) else "not_present"
    if asset_id == "wh.raw":
        return "present" if any(kept(k) for k in list(t["export_rows"]) + list(t["export_refs"])) else "not_present"
    if asset_id in ("wh.core", "hist.dbt.dim_employee_history", "id.d1.identity_records", "id.wh.identity_xref"):
        return "present"
    if asset_id == "hist.lake.employee_monthly":
        rows = t["lake_rows_after_retention_cutoff"] + t["lake_ref_rows_after_retention_cutoff"] if retention_ran else t["lake_rows"] + t["lake_ref_rows"]
        return "present" if rows > 0 else "not_present"
    if asset_id == "drv.marts.attrition_features":
        return "present" if any("/payroll/" in k for k in t["export_rows"]) else "not_present"
    if asset_id == "drv.marts.team_roster":
        return "present" if t["manager_id"] else "not_present"
    if asset_id == "drv.r2.analytics_extracts":
        months = {k.split("period=")[1][:7] for k in t["export_rows"] if "/payroll/" in k}
        return "present" if not t["is_restricted"] and months & {"2026-07", "2026-08", "2026-09"} else "not_present"
    if asset_id == "cache.kv.profile_cards":
        mine = {refs.employee_ref, refs.analytics_id}
        own_principal = principal_of.get(t["employee_id"])
        hit = any(w["kind"] == "profile" and (w["ref"] in mine or (w["purpose"] == "team_management" and w["principal"] == own_principal)) for w in warmup)
        return "present" if hit else "not_present"
    if asset_id == "cache.kv.team_rosters":
        own_principal = principal_of.get(t["employee_id"])
        listed = t["status"] == "active" and not t["is_restricted"] and t["manager_id"] is not None
        return "present" if listed or own_principal is not None and t["role"] != "staff" else "not_present"
    return None


def run(profile: str, *, no_seed: bool = False) -> dict:
    t_start = time.time()
    run_header = header(f"npm run eval:deletion{':ci' if profile == 'ci' else ''}", profile)  # the code state that ran
    if not no_seed:
        _log("seeding (fresh)")
        _node(["scripts/seed-local.ts", "--fresh"])
    expected = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())
    truth_list = load_truth("subjects.json")
    truth = {t["employee_id"]: t for t in truth_list}
    cohorts = load_truth("cohorts.json")[profile]
    warmup = load_truth("kv_warmup.json")
    principals = load_truth("principals.json")
    principal_of = {p["employee_id"]: p["id"] for p in principals if p.get("employee_id")}
    master = config.local_settings().master_key
    tokens = {e: subject_tokens(master, t) for e, t in truth.items()}
    f_entries = cohorts["F"]
    cohort_ids = set(cohorts["R"]) | set(cohorts["D"]) | set(cohorts["H"]) | {f["subject"] for f in f_entries}
    other = next(e for e in sorted(truth) if e not in cohort_ids and truth[e]["status"] == "active" and not truth[e]["hold_matter"])
    plan_subjects = {e: {"tokens": {"employee_id": e, "work_email": tokens[e].work_email, "full_name": tokens[e].full_name, "employee_ref": tokens[e].employee_ref,
                                    "warehouse_key": tokens[e].warehouse_key, "analytics_id": tokens[e].analytics_id}} for e in cohort_ids}
    plan, actions, planted = faults_mod.build_plan(f_entries, cohorts.get("variants", []), plan_subjects, other)
    _log(f"planting {len(planted)} faults and variants")
    faults_mod.apply(plan, actions)

    client = LocalClient(principals)
    stack_started = False
    try:
        _node(["scripts/dev.ts", "--detach"])
        stack_started = True
        _log("warming caches through the API")
        warm = warm_kv(client, warmup)
        kv_keys_after_warmup = len(_json_out(_wrangler(["kv", "key", "list", "--binding", "CACHE", "--local"])))
        extracts = create_extracts(client)

        _log("retention sweep")
        body = {"as_of": "2026-09-30", **({"max_subjects": 10} if profile == "ci" else {})}
        r = client.request("privacy-01", "POST", "/api/v1/privacy/retention/run", body)
        r.raise_for_status()
        run_id = r.json()["runId"]
        retention_run = _wait_run(client, run_id, TIMEOUT_S[profile])
        ret_ids = {x["id"] for x in client.request("privacy-01", "GET", "/api/v1/privacy/deletion-requests").json()["requests"] if x["kind"] == "retention"}
        _wait_requests(client, ret_ids, TIMEOUT_S[profile])

        _log("submitting D, H and F requests")
        submitted: dict[str, str] = {}
        for e in list(cohorts["D"]) + list(cohorts["H"]) + [f["subject"] for f in f_entries]:
            resp = client.request("privacy-01", "POST", "/api/v1/privacy/deletion-requests", {"employee_ref": tokens[e].employee_ref, "reason": "eval data subject request"})
            if resp.status_code != 202:
                raise RuntimeError(f"DSR submission failed with {resp.status_code}")
            submitted[resp.json()["requestId"]] = e
        _wait_requests(client, set(submitted), TIMEOUT_S[profile])

        report_before = client.request("privacy-01", "GET", "/api/v1/privacy/reports/deletion").json()
        _log("local lake expiry and residual check")
        expire_out = _pv(["lake", "expire", "--target", "local"])
        check_out = _pv(["residuals", "check", "--target", "local"])
        report = client.request("privacy-01", "GET", "/api/v1/privacy/reports/deletion").json()
        audit_ok = client.request("privacy-01", "GET", "/api/v1/privacy/audit/verify").json()
    finally:
        if stack_started:
            _node(["scripts/stop-local.ts"], check=False)

    _log("oracle")
    requests = d1_query("SELECT id, kind, subject_ref, status, created_at, completed_at FROM deletion_requests")
    results = d1_query("SELECT request_id, asset_id, category, applicability, action_status, verify_status, verify_matches FROM deletion_asset_results")
    residual_rows = d1_query("SELECT request_id, kind, state, evidence FROM residuals")
    found = run_oracle({e: tokens[e] for e in cohort_ids})
    result = score(RunData(
        profile=profile, run_header=run_header, t_start=t_start, truth=truth, cohorts=cohorts, tokens=tokens, expected=expected, warmup=warmup,
        principal_of=principal_of, planted=planted, submitted=submitted, requests=requests, results=results, residual_rows=residual_rows, found=found,
        retention_run=retention_run, report_before=report_before, report=report, audit_ok=audit_ok,
        warmup_counts={**warm, "kv_keys_after_warmup": kv_keys_after_warmup, **extracts}, expire_out=expire_out, check_out=check_out,
    ))
    write(result)
    return result


@dataclass
class RunData:
    """Everything a run gathered; score() turns it into the metrics (the same for local and production runs)."""

    profile: str
    run_header: dict
    t_start: float
    truth: dict
    cohorts: dict
    tokens: dict
    expected: dict
    warmup: list
    principal_of: dict
    planted: list
    submitted: dict
    requests: list
    results: list
    residual_rows: list
    found: OracleFindings
    retention_run: dict | None
    report_before: dict
    report: dict
    audit_ok: dict
    warmup_counts: dict
    expire_out: str
    check_out: str


def score(d: RunData) -> dict:
    requests, results, residuals, found, tokens, truth, cohorts = d.requests, d.results, d.residual_rows, d.found, d.tokens, d.truth, d.cohorts
    expected, warmup, principal_of, planted, submitted = d.expected, d.warmup, d.principal_of, d.planted, d.submitted
    cohort_ids = set(cohorts["R"]) | set(cohorts["D"]) | set(cohorts["H"]) | {f["subject"] for f in cohorts["F"]}
    by_sref = {tokens[e].subject_ref: e for e in tokens}
    req_subject = {r["id"]: by_sref.get(r["subject_ref"]) for r in requests}
    rows_by_req: dict[str, list[dict]] = defaultdict(list)
    for row in results:
        rows_by_req[row["request_id"]].append(row)

    def oracle_residue(subject: str, asset_id: str) -> bool:
        if asset_id.startswith("unregistered:"):
            _, store, loc = asset_id.split(":", 2)
            return any(s == store and _matches_location(store, location, loc, tokens[subject]) for s, location, _a, _n in found.by_subject.get(subject, []))
        return any(a == asset_id for _s, _l, a, _n in found.by_subject.get(subject, []))

    # coverage over R and D requests that were not held
    scored_requests = [r for r in requests if r["status"] != "held" and req_subject.get(r["id"]) in (set(cohorts["R"]) | set(cohorts["D"]))]
    pairs = []
    for r in scored_requests:
        for row in _pairs(rows_by_req[r["id"]]):
            pairs.append((r["id"], req_subject[r["id"]], row))
    clean = sum(1 for _, _, row in pairs if row["verify_status"] == "clean")
    by_cat = {}
    for cat in CATEGORIES:
        cp = [p for p in pairs if p[2]["category"] == cat]
        by_cat[cat] = _coverage(sum(1 for p in cp if p[2]["verify_status"] == "clean"), len(cp))
    oracle_clean = sum(1 for _rid, subj, row in pairs if not oracle_residue(subj, row["asset_id"]))
    agreement = sum(1 for _rid, subj, row in pairs if (row["verify_status"] == "clean") == (not oracle_residue(subj, row["asset_id"])))
    false_clean_pairs = 0
    for r in scored_requests:
        subj = req_subject[r["id"]]
        for row in rows_by_req[r["id"]]:
            if row["verify_status"] in ("clean", "not_applicable", "pending") and row["applicability"] not in ("held", "aggregate_recompute") and oracle_residue(subj, row["asset_id"]):
                false_clean_pairs += 1
    reported_locations = {(req_subject[r["id"]], row["asset_id"]) for r in scored_requests for row in rows_by_req[r["id"]]}
    missed = 0
    for r in scored_requests:
        subj = req_subject[r["id"]]
        for store, loc, asset, _n in found.by_subject.get(subj, []):
            if asset is None and not any(a.startswith(f"unregistered:{store}:") and _matches_location(store, loc, a.split(":", 2)[2], tokens[subj]) for s2, a in reported_locations if s2 == subj):
                missed += 1
    false_residue = sum(1 for _rid, subj, row in pairs if row["verify_status"] != "clean" and not oracle_residue(subj, row["asset_id"]))

    # applicability agreement (system present/not_present vs truth)
    agree = total_app = 0
    disagreements: list[dict] = []  # asset and both answers only (no identifiers), so each one can be explained
    for r in scored_requests:
        subj = req_subject[r["id"]]
        for row in rows_by_req[r["id"]]:
            if row["applicability"] not in ("present", "not_present"):
                continue
            want = _truth_applicability(row["asset_id"], truth[subj], expected, warmup, principal_of, tokens[subj], retention_ran=d.retention_run is not None)
            if want is None:
                continue
            total_app += 1
            agree += int(want == row["applicability"])
            if want != row["applicability"]:
                disagreements.append({"asset_id": row["asset_id"], "system": row["applicability"], "truth": want})

    # holds
    held_subjects = [e for e in cohort_ids if truth[e]["hold_matter"]]
    held_requests = [r for r in requests if req_subject.get(r["id"]) in held_subjects and r["status"] == "held"]
    intact = 0
    for e in held_subjects:
        stores = {s for s, _l, _a, _n in found.by_subject.get(e, [])}
        if {"r2", "warehouse", "d1"} <= stores and ("iceberg" in stores or truth[e]["lake_rows"] == 0):
            intact += 1

    # faults
    status_by_subject = {req_subject[r["id"]]: r["status"] for r in requests if r["kind"] == "dsr"}
    fault_rows = []
    for p in planted:
        req_ids = [rid for rid, e in submitted.items() if e == p.subject]
        locs = {row["asset_id"] for rid in req_ids for row in rows_by_req[rid]}
        hit = f"unregistered:{p.store}:{p.location}"[:200] in locs
        fault_rows.append({"scenario": p.scenario, "store": p.store, "variant": p.variant, "request_failed": status_by_subject.get(p.subject) == "failed", "finding_at_location": hit})
    designed = [f for f in fault_rows if not f["variant"]]
    detected = [f for f in designed if f["request_failed"] and f["finding_at_location"]]
    by_store = {}
    for f in designed:
        st = by_store.setdefault(f["store"], {"detected": 0, "scenarios": 0})
        st["scenarios"] += 1
        st["detected"] += int(f["request_failed"] and f["finding_at_location"])

    # retention vs golden (local profiles; production runs no sweep in the eval)
    retention_out: dict = {"run": False}
    if d.retention_run is not None:
        retention_out = _retention_metrics(d.retention_run, expected["retention_expected" if d.profile == "full" else "retention_expected_ci"])

    # residuals
    res_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in residuals:
        res_counts[r["kind"]][f"{r['state']}/{r['evidence']}"] += 1
    before = {x["kind"]: {} for x in d.report_before.get("residuals", [])}
    for x in d.report_before.get("residuals", []):
        before[x["kind"]][f"{x['state']}/{x['evidence']}"] = x["n"]

    # timing
    durations = []
    for r in requests:
        if r["completed_at"] and r["created_at"]:
            durations.append((datetime.fromisoformat(r["completed_at"].replace("Z", "+00:00")) - datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))).total_seconds() * 1000)
    durations.sort()

    result = {
        **d.run_header,
        "kind": "deletion",
        "requests": {"total": len(requests), "by_status": _count(r["status"] for r in requests), "by_kind": _count(r["kind"] for r in requests),
                     "cohorts": {k: len(v) for k, v in cohorts.items() if isinstance(v, list)}},
        "assets_registered": 13,
        "coverage": {**_coverage(clean, len(pairs)), "by_category": by_cat, "scope": "R and D requests that were not held; system verdicts"},
        "oracle": {"oracle_coverage": _coverage(oracle_clean, len(pairs)), "agreement": (agreement / len(pairs)) if pairs else None, "false_clean": false_clean_pairs + missed,
                   "false_clean_pairs": false_clean_pairs, "missed_locations": missed, "false_residue": false_residue, "scanned": dict(found.scanned)},
        "applicability_agreement": {"value": (agree / total_app) if total_app else None, "pairs": total_app, "agree": agree, "disagreements": disagreements},
        "holds": {"held_requests": len(held_requests), "held_subjects": len(held_subjects), "held_data_intact": intact},
        "faults": {"scenarios": len(designed), "detected": len(detected), "by_store": by_store, "undetected_by_design": sum(1 for f in fault_rows if f["variant"] and not f["finding_at_location"]),
                   "variants": [{"variant": f["scenario"], "finding_at_location": f["finding_at_location"]} for f in fault_rows if f["variant"]],
                   "note": "planted residues of designed types; detection shows the probes reach every store and location type, not that they would find any possible copy"},
        "retention": retention_out,
        "residuals": {"by_kind": {k: dict(v) for k, v in res_counts.items()}, "before_lake_expiry": before, "lake_expire": d.expire_out, "residual_check": d.check_out},
        "warmup": d.warmup_counts,
        "audit_chain": d.audit_ok,
        "report": {"coverage": d.report.get("coverage"), "requests": d.report.get("requests")},
        "timing_ms": {"workflow_p50": statistics.median(durations) if durations else None, "workflow_p95": durations[int(0.95 * (len(durations) - 1))] if durations else None,
                      "total_run": int((time.time() - d.t_start) * 1000)},
    }
    result["gate"] = gate(result)
    return result


def _retention_metrics(retention_run: dict, exp_ret: dict) -> dict:
    rs = retention_run.get("summary") or {}
    ex_counts = rs.get("executorCounts", {})
    retention = {
        "export_objects_deleted": rs.get("exportObjectsDeleted"),
        "export_objects_minimized_for_hold": rs.get("exportObjectsMinimized"),
        "extracts_expired": (rs.get("extractsDeleted") or 0) + (rs.get("extractsMinimized") or 0),
        "retention_requests": rs.get("retentionRequests"),
        "retention_held": rs.get("retentionHeld"),
        "raw_rows_expired": {k.replace("raw_rows_expired_", ""): v for k, v in ex_counts.items() if k.startswith("raw_rows_expired_")},
        "lake_rows_expired_employee_monthly": ex_counts.get("lake_rows_expired_employee_monthly"),
    }
    expected_raw = {"hris_employees": exp_ret["raw_rows_expired"].get("hris", 0), "payroll_compensation": exp_ret["raw_rows_expired"].get("payroll", 0),
                    "performance_reviews": exp_ret["raw_rows_expired"].get("performance", 0), "leave_requests": exp_ret["raw_rows_expired"].get("leave", 0)}
    retention_matches = {
        "export_objects_deleted": retention["export_objects_deleted"] == exp_ret["export_objects_deleted"],
        "export_objects_minimized_for_hold": retention["export_objects_minimized_for_hold"] == exp_ret["export_objects_minimized_for_hold"],
        "extracts_expired": retention["extracts_expired"] == exp_ret["extracts_expired"],
        "retention_requests": retention["retention_requests"] == exp_ret["retention_requests"],
        "retention_held": retention["retention_held"] == exp_ret["retention_held"],
        "raw_rows_expired": retention["raw_rows_expired"] == expected_raw,
        "lake_rows_expired_employee_monthly": retention["lake_rows_expired_employee_monthly"] == exp_ret["lake_rows_expired_employee_monthly"],
    }
    return {**retention, "expected": exp_ret, "matches_expected": retention_matches}


def write(result: dict) -> None:
    name = f"deletion-{result['profile']}-{date.today().isoformat()}"
    write_result(f"{name}.json", result)
    (config.REPO_ROOT / "evals" / "results" / f"{name}.md").write_text(render_md(result))


def _count(values) -> dict:
    out: dict = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return dict(sorted(out.items()))


def _matches_location(store: str, oracle_location: str, system_location: str, t: SubjectTokens) -> bool:
    redacted = oracle_location
    for tok in t.all():
        redacted = redacted.replace(tok, "[redacted]")
    return redacted == system_location or oracle_location == system_location


def gate(r: dict) -> dict:
    checks = {
        "false_clean_zero": r["oracle"]["false_clean"] == 0,
        "all_faults_detected": r["faults"]["detected"] == r["faults"]["scenarios"],
        "held_data_intact": r["holds"]["held_data_intact"] == r["holds"]["held_requests"],
        "coverage_100": r["coverage"]["value"] == 1.0,
        "every_category_applicable": all(c["applicable_pairs"] > 0 for c in r["coverage"]["by_category"].values()),
    }
    return {"passed": all(checks.values()), "checks": checks}


def render_md(r: dict) -> str:
    lines = [
        f"# Deletion eval ({r['profile']}, {r['environment']})",
        "",
        f"Command: `{r['command']}`. Date: {r['date']}.",
        "",
        f"- Requests: {r['requests']['total']} ({', '.join(f'{k} {v}' for k, v in r['requests']['by_status'].items())})",
        f"- Coverage (system, R and D not held): {r['coverage']['display']} of {r['coverage']['applicable_pairs']} applicable pairs",
    ]
    for cat, c in r["coverage"]["by_category"].items():
        lines.append(f"  - {cat}: {c['display']} of {c['applicable_pairs']}")
    o = r["oracle"]
    lines += [
        f"- Oracle coverage: {o['oracle_coverage']['display']}; agreement {o['agreement']}; false_clean {o['false_clean']}; false_residue {o['false_residue']}",
        f"- Faults: {r['faults']['detected']} of {r['faults']['scenarios']} planted residues of designed types detected; {r['faults']['undetected_by_design']} out-of-design variants undetected by design",
        f"- Applicability agreement with ground truth: {r['applicability_agreement']['agree']} of {r['applicability_agreement']['pairs']} pairs"
        + "".join(f"; {d['asset_id']} system {d['system']}, truth {d['truth']}" for d in r["applicability_agreement"].get("disagreements", [])),
        f"- Holds: {r['holds']['held_requests']} held requests, held data intact for {r['holds']['held_data_intact']}",
        f"- Gate: {'passed' if r['gate']['passed'] else 'FAILED'} {r['gate']['checks']}",
    ]
    return "\n".join(lines) + "\n"
