"""Fault injection for the deletion eval (SPEC.md section 19.1).

20 planted residues of designed types (R2 6, warehouse 5, Iceberg 3, KV 3, D1 3) on F-cohort subjects, plus 3
out-of-design variants (uppercased email, "Last, First", base64 employee id) reported as undetected_by_design.
Planting happens while no local server runs (DuckDB lock), through DuckDB, pyiceberg and Miniflare's own storage API
(scripts/eval-plant.ts); none of it goes through product code, and product code has no fault switches. Detecting
these faults shows the probes reach every store and location type they are designed for, not that they would find
any possible copy.
"""

from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pyarrow as pa

from peoplevault import config


@dataclass
class Planted:
    subject: str  # employee id (truth key)
    store: str
    scenario: str
    location: str  # as the product reports it (token occurrences replaced by [redacted])
    variant: bool = False


def _redact(location: str, tokens: list[str]) -> str:
    for t in tokens:
        location = location.replace(t, "[redacted]")
    return location


def build_plan(f_entries: list[dict], variants: list[dict], subjects: dict, other_employee: str) -> tuple[dict, list[dict], list[Planted]]:
    """Returns (plan for scripts/eval-plant.ts, warehouse and lake actions, planted records)."""
    plan: dict[str, list] = {"r2": [], "kv": [], "d1": []}
    actions: list[dict] = []
    planted: list[Planted] = []
    for i, f in enumerate(f_entries, start=1):
        s = subjects[f["subject"]]
        tok = s["tokens"]
        sid = f["subject"]
        scen = f["scenario"]
        r2 = lambda bucket, key, body, meta=None: plan["r2"].append({"bucket": bucket, "key": key, "body": body, **({"customMetadata": meta} if meta else {})})  # noqa: E731
        if scen == "r2.adhoc_export_rows":
            key = f"exports/adhoc/backup-{i}.jsonl"
            row = {"employee_id": tok["employee_id"], "full_name": tok["full_name"], "work_email": tok["work_email"]}
            r2("pv-source-exports", key, json.dumps(row) + "\n" + json.dumps({**row, "note": "duplicate"}) + "\n")
            loc = f"pv-source-exports/{key}"
        elif scen == "r2.notes_email":
            key = f"notes/ticket-{i}.json"
            r2("pv-source-exports", key, json.dumps({"text": f"Caller asked to update {tok['work_email']} on file."}) + "\n")
            loc = f"pv-source-exports/{key}"
        elif scen == "r2.derived_adhoc_extract":
            key = f"extracts/adhoc/scratch-{i}.jsonl"
            r2("pv-derived", key, json.dumps({"analytics_id": tok["analytics_id"], "org_unit": "SCRATCH"}) + "\n")
            loc = f"pv-derived/{key}"
        elif scen == "r2.custom_metadata_ref":
            key = f"exports/adhoc/meta-{i}.txt"
            r2("pv-source-exports", key, "owner recorded in metadata\n", {"owner": tok["employee_ref"]})
            loc = f"pv-source-exports/{key}"
        elif scen == "r2.manager_reference_row":
            key = f"exports/adhoc/reports-{i}.jsonl"
            r2("pv-source-exports", key, json.dumps({"employee_id": other_employee, "manager_employee_id": tok["employee_id"]}) + "\n")
            loc = f"pv-source-exports/{key}"
        elif scen == "r2.key_name_id":
            key = f"exports/adhoc/{tok['employee_id']}.json"
            r2("pv-source-exports", key, "{}\n")
            loc = f"pv-source-exports/{key}"
        elif scen == "wh.core_tmp_backup":
            loc = f"peoplevault_core.tmp_backup_{i}"
            actions.append({"kind": "duckdb", "sql": [f"create table {loc} (employee_key varchar, full_name varchar)", f"insert into {loc} values ('{tok['warehouse_key']}', '{tok['full_name']}')"]})
        elif scen == "wh.marts_analyst_scratch":
            loc = f"peoplevault_marts.analyst_scratch_{i}"
            actions.append({"kind": "duckdb", "sql": [f"create table {loc} (analytics_id varchar, org_unit varchar)", f"insert into {loc} values ('{tok['analytics_id']}', 'SCRATCH')"]})
        elif scen == "wh.scratch_schema":
            loc = f"peoplevault_scratch.copy_{i}"
            actions.append({"kind": "duckdb", "sql": ["create schema if not exists peoplevault_scratch", f"create table {loc} (employee_id varchar, full_name varchar)", f"insert into {loc} values ('{tok['employee_id']}', '{tok['full_name']}')"]})
        elif scen == "wh.restricted_legacy_xref":
            loc = f"peoplevault_restricted.legacy_xref_{i}"
            actions.append({"kind": "duckdb", "sql": [f"create table {loc} (employee_id varchar, employee_ref varchar)", f"insert into {loc} values ('{tok['employee_id']}', '{tok['employee_ref']}')"]})
        elif scen == "wh.unregistered_email_text":
            loc = f"peoplevault_core.support_notes_{i}"
            actions.append({"kind": "duckdb", "sql": [f"create table {loc} (note varchar)", f"insert into {loc} values ('Please reach {tok['work_email']} about the request.')"]})
        elif scen == "lake.adhoc_backup":
            loc = f"hr_history.adhoc_backup_{i}"
            actions.append({"kind": "lake", "table": loc, "rows": {"employee_key": [tok["warehouse_key"]], "month": [date(2026, 9, 1)]}})
        elif scen == "lake.scratch_namespace":
            loc = f"scratch.lake_copy_{i}"
            actions.append({"kind": "lake", "table": loc, "rows": {"employee_key": [tok["warehouse_key"]]}})
        elif scen == "lake.adhoc_notes_analytics_id":
            loc = f"hr_history.adhoc_notes_{i}"
            actions.append({"kind": "lake", "table": loc, "rows": {"note": [f"analytics {tok['analytics_id']} flagged for review"]}})
        elif scen == "kv.tmp_employee_ref":
            key = f"tmp:{tok['employee_ref']}"
            plan["kv"].append({"key": key, "value": "1"})
            loc = key
        elif scen == "kv.report_summary_name":
            key = "report:summary"
            plan["kv"].append({"key": key, "value": f"top performer: {tok['full_name']}, again"})
            loc = key
        elif scen == "kv.export_pending_analytics_id":
            key = f"export:pending:{tok['analytics_id']}"
            plan["kv"].append({"key": key, "value": "queued"})
            loc = key
        elif scen == "d1.support_notes":
            loc = "support_notes"
            plan["d1"].append(f"CREATE TABLE IF NOT EXISTS support_notes (id TEXT, body TEXT); INSERT INTO support_notes VALUES ('n{i}', 'call from {tok['employee_id']} today');")
        elif scen == "d1.principal_aliases":
            loc = "principal_aliases"
            plan["d1"].append(f"CREATE TABLE IF NOT EXISTS principal_aliases (alias TEXT, email TEXT); INSERT INTO principal_aliases VALUES ('a{i}', '{tok['work_email']}');")
        elif scen == "d1.cache_mirror":
            loc = "cache_mirror"
            plan["d1"].append(f"CREATE TABLE IF NOT EXISTS cache_mirror (k TEXT, v TEXT); INSERT INTO cache_mirror VALUES ('c{i}', '{tok['employee_ref']}');")
        else:
            raise ValueError(f"unknown fault scenario {scen}")
        planted.append(Planted(sid, f["store"], scen, _redact(loc, list(tok.values()))))
    for j, v in enumerate(variants, start=1):
        tok = subjects[v["subject"]]["tokens"]
        if v["variant"] == "variant.r2_uppercase_email":
            key = f"notes/variant-{j}.txt"
            plan["r2"].append({"bucket": "pv-source-exports", "key": key, "body": f"contact {tok['work_email'].upper()}\n"})
            loc = f"pv-source-exports/{key}"
        elif v["variant"] == "variant.d1_last_comma_first":
            first, last = tok["full_name"].split(" ", 1)
            plan["d1"].append(f"CREATE TABLE IF NOT EXISTS name_variants (v TEXT); INSERT INTO name_variants VALUES ('{last}, {first}');")
            loc = "name_variants"
        elif v["variant"] == "variant.kv_base64_employee_id":
            key = f"variant:{j}"
            plan["kv"].append({"key": key, "value": base64.b64encode(tok["employee_id"].encode()).decode()})
            loc = key
        else:
            raise ValueError(v["variant"])
        planted.append(Planted(v["subject"], v["store"], v["variant"], loc, variant=True))
    return plan, actions, planted


def apply(plan: dict, actions: list[dict], *, duckdb_path: Path | None = None) -> dict:
    import duckdb

    from peoplevault.lake.catalog import open_catalog

    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "plan.json"
        f.write_text(json.dumps(plan))
        res = subprocess.run(["node", "scripts/eval-plant.ts", str(f)], cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
        if res.returncode != 0:
            raise RuntimeError("planting R2, KV and D1 faults failed")
    conn = duckdb.connect(str(duckdb_path or config.DUCKDB_PATH))
    try:
        for a in actions:
            if a["kind"] == "duckdb":
                for sql in a["sql"]:
                    conn.execute(sql)
    finally:
        conn.close()
    cat = open_catalog("local")
    for a in actions:
        if a["kind"] != "lake":
            continue
        ns = a["table"].split(".")[0]
        if (ns,) not in cat.list_namespaces():
            cat.create_namespace(ns)
        data = pa.table({k: pa.array(v) for k, v in a["rows"].items()})
        t = cat.create_table(a["table"], schema=data.schema)
        t.append(data)
    return {"r2": len(plan["r2"]), "kv": len(plan["kv"]), "d1": len(plan["d1"]), "warehouse_and_lake": len(actions)}
