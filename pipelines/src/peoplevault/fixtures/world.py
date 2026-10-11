"""`pv fixtures build | check`: data/fixtures/world.yaml -> temp DuckDB (real loaders and dbt) -> committed fixtures.

Writes three files the Worker test project reads (it never reads data/generated):
- purpose_rows.json: every row of every purpose view, read from the real DuckDB purpose views (the FakeWarehouse
  in test/fixtures applies the compiled named-query filters to these rows);
- authz_subjects.json: case selectors -> subject refs and truth values from world.yaml;
- d1_seed.sql: principals, identity_map, legal_holds and suppression_list for the world.
The rebuild in `pv fixtures check` (CI) is the DuckDB cross-check of the hand-authored world.
"""

from __future__ import annotations

import csv
import io
import json
import os
import tempfile
from datetime import date, datetime
from pathlib import Path

import yaml

from peoplevault import config
from peoplevault.dbtrun import run as dbt
from peoplevault.load import identity, raw, snapshots, suppression
from peoplevault.load.schema import create_all_duckdb
from peoplevault.policy.model import policy
from peoplevault.pseudo import TEST_MASTER_KEY, Pseudonymizer
from peoplevault.sources.local_files import SourceObject
from peoplevault.synth.principals import sql_literal
from peoplevault.warehouse.duck import connect

WORLD = config.FIXTURES_DIR / "world.yaml"
OUTPUTS = ("purpose_rows.json", "authz_subjects.json", "d1_seed.sql")
CREATED_AT = "2026-09-01T00:00:00Z"


def load_world(path: Path = WORLD) -> dict:
    return yaml.safe_load(path.read_text())


def _email(e: dict) -> str:
    return f"{e['first'].lower()}.{e['last'].lower()}@peoplevault.test"


def _name(e: dict) -> str:
    return f"{e['first']} {e['last']}"


PHONE = "+1-555-0150"
BONUS_TARGET_PCT = 10.0
REVIEW_TEXT = "Met expectations with steady delivery across the cycle."


def _personal_email(e: dict) -> str:
    return f"{e['first'].lower()}{e['last'].lower()}77@example.test"


def _active(e: dict, on: str) -> bool:
    return e["hire"] <= on and (not e.get("termination") or e["termination"] > on)


def export_objects(world: dict) -> list[SourceObject]:
    emps = world["employees"]
    d = world["export_date"]
    hris = []
    for e in emps:
        hris.append(json.dumps({
            "employee_id": e["id"], "full_name": _name(e), "work_email": _email(e),
            "personal_email": _personal_email(e), "phone": PHONE,
            "birth_date": e["birth"], "gender": e["gender"], "ethnicity": e["ethnicity"], "hire_date": e["hire"],
            "termination_date": e.get("termination"), "employment_status": "terminated" if e.get("termination") else "active",
            "job_title": e["title"], "job_level": e["level"], "org_unit": e["unit"], "location": "Austin",
            "manager_employee_id": e.get("manager"), "is_restricted": bool(e.get("restricted", False)), "export_date": d,
        }))
    period = world["pay_period"]
    period_end = "2026-09-30"
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["employee_id", "pay_period_end", "base_salary", "bonus_target_pct", "currency"])
    for e in emps:
        if _active(e, period_end):
            w.writerow([e["id"], period_end, e["salary"], BONUS_TARGET_PCT, "USD"])
    leave = []
    n = 0
    for e in emps:
        if e.get("leave"):
            n += 1
            ltype, reason, note = e["leave"]
            leave.append(json.dumps({
                "leave_id": f"LV-9{n:05d}", "employee_id": e["id"], "start_date": "2026-09-08", "end_date": "2026-09-19",
                "leave_type": ltype, "leave_category": "statutory", "leave_reason": reason, "accommodation_note": note, "status": "approved",
            }))
    reviews = []
    n = 0
    for e in emps:
        if e.get("rating") and _active(e, "2026-06-30"):
            n += 1
            reviews.append(json.dumps({
                "review_id": f"RV-9{n:05d}", "employee_id": e["id"], "cycle": world["review_cycle"], "rating": e["rating"],
                "review_text": REVIEW_TEXT, "reviewer_employee_id": e.get("manager"),
            }))
    return [
        SourceObject(f"exports/hris/employees/dt={d}/employees.jsonl", "hris", d, "\n".join(hris) + "\n"),
        SourceObject(f"exports/payroll/compensation/period={period}/compensation.csv", "payroll", period_end, buf.getvalue()),
        SourceObject(f"exports/leave/requests/month={world['leave_month']}/requests.jsonl", "leave", "2026-09-30", "\n".join(leave) + "\n"),
        SourceObject(f"exports/performance/reviews/cycle={world['review_cycle']}/reviews.jsonl", "performance", "2026-06-30", "\n".join(reviews) + "\n"),
    ]


def _jsonable(v):
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return v


def build_warehouse(world: dict, path: Path) -> dict[str, list[dict]]:
    ps = Pseudonymizer(TEST_MASTER_KEY)
    deleted = {ps.pseudonym("subject_ref", e["id"]) for e in world["employees"] if e.get("deleted")}
    os.environ["PV_DUCKDB_PATH"] = str(path)
    conn = connect(path)
    try:
        create_all_duckdb(conn)
        suppression.sync_duckdb(conn, deleted, request_id="fixture-deleted")
        identity.upsert_xref(conn, [e["id"] for e in world["employees"]], ps, deleted)
        report = raw.load_objects(conn, export_objects(world), ps, deleted)
        if report.quarantined:
            raise RuntimeError(f"fixture export quarantined: {report.quarantined}")
        conn.execute("checkpoint")
        snapshots.replay([world["export_date"]])
        res = dbt(["build", "--target", "local", "--vars", json.dumps({"pv_as_of": world["as_of"]})])
        if not res.success:
            raise RuntimeError("dbt build of the fixture world failed")
        rows: dict[str, list[dict]] = {}
        p = policy()
        for purpose, views in p.purpose_views.items():
            for view, v in views.items():
                cols = v.columns
                order = ", ".join(c for c in ("employee_ref", "analytics_id", "month", "org_unit", "job_level") if c in cols) or cols[0]
                cur = conn.execute(f"select {', '.join(cols)} from {p.purpose_dataset(purpose)}.{view} order by {order}")
                rows[f"{purpose}.{view}"] = [{c: _jsonable(val) for c, val in zip(cols, r, strict=True)} for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


def subjects(world: dict) -> dict:
    ps = Pseudonymizer(TEST_MASTER_KEY)
    emps = {e["id"]: e for e in world["employees"]}
    as_of = world["as_of"]

    def entry(e_id: str) -> dict:
        e = emps[e_id]
        refs = ps.all(e_id)
        return {
            "employee_ref": refs["employee_ref"], "analytics_id": refs["analytics_id"], "subject_ref": refs["subject_ref"],
            # every column of a tagged class that a purpose query can return, so the C cases compare each one
            "truth": {
                "full_name": _name(e), "work_email": _email(e), "personal_email": _personal_email(e), "phone": PHONE, "birth_date": e["birth"],
                "base_salary": float(e["salary"]) if _active(e, "2026-09-30") else None,
                "bonus_target_pct": BONUS_TARGET_PCT if _active(e, "2026-09-30") else None,
                "rating": e.get("rating") if _active(e, "2026-06-30") else None,
                "review_text": REVIEW_TEXT if e.get("rating") and _active(e, "2026-06-30") else None,
                "leave_type": (e.get("leave") or [None])[0], "leave_reason": (e.get("leave") or [None, None])[1],
                "accommodation_note": (e.get("leave") or [None, None, None])[2], "gender": e["gender"], "ethnicity": e["ethnicity"],
                "org_unit": e["unit"], "employment_status": "terminated" if e.get("termination") else "active",
                "is_restricted": bool(e.get("restricted", False)), "deleted": bool(e.get("deleted", False)), "held": e.get("held"),
            },
        }

    def live(e: dict) -> bool:
        return not e.get("deleted")

    def active_ok(e: dict) -> bool:
        return live(e) and _active(e, as_of)

    out: dict[str, dict[str, list]] = {}
    for p in world["principals"]:
        if "persona" not in p:
            continue
        me = p["employee"]
        reports = [i for i, e in emps.items() if e.get("manager") == me]
        sel: dict[str, list[str]] = {
            "self": [me],
            "direct_report": [i for i in reports if active_ok(emps[i]) and not emps[i].get("restricted") and not emps[i].get("held")],
            "restricted_direct_report": [i for i in reports if active_ok(emps[i]) and emps[i].get("restricted")],
            "held_direct_report": [i for i in reports if active_ok(emps[i]) and emps[i].get("held")],
            "skip_level_report": [j for i in reports for j, e in emps.items() if e.get("manager") == i and active_ok(e) and not e.get("restricted")],
        }
        boss = emps[me].get("manager")
        peers = [i for i, e in emps.items() if boss and e.get("manager") == boss and i != me]
        sel["peer_report"] = [j for i in peers for j, e in emps.items() if e.get("manager") == i and active_ok(e) and not e.get("restricted")]
        units = p.get("org_units", [])
        if units:
            sel["in_unit"] = [i for i, e in emps.items() if e["unit"] in units and active_ok(e) and not e.get("restricted") and not e.get("held")]
            sel["restricted_in_unit"] = [i for i, e in emps.items() if e["unit"] in units and active_ok(e) and e.get("restricted")]
            sel["terminated_in_unit"] = [i for i, e in emps.items() if e["unit"] in units and live(e) and e.get("termination")]
            sel["held_in_unit"] = [i for i, e in emps.items() if e["unit"] in units and live(e) and e.get("held")]
            sel["outside_unit"] = [i for i, e in emps.items() if e["unit"] not in units and active_ok(e) and not e.get("restricted")]
        out[p["id"]] = {k: [entry(i) for i in sorted(v)] for k, v in sel.items()}
    out["*"] = {
        "active": [entry(i) for i in sorted(emps) if active_ok(emps[i]) and not emps[i].get("restricted") and not emps[i].get("held")],
        "restricted": [entry(i) for i in sorted(emps) if active_ok(emps[i]) and emps[i].get("restricted")],
        "terminated": [entry(i) for i in sorted(emps) if live(emps[i]) and emps[i].get("termination")],
        "held": [entry(i) for i in sorted(emps) if emps[i].get("held")],
        # D14 (HR, SALES-NA), D15 (manager mgr-001), D16 (analyst)
        "deleted": [entry(i) for i in ("E10016", "E10011", "E10022")],
    }
    for e_id in ("E10016", "E10011", "E10022"):
        assert emps[e_id].get("deleted")
    return {"description": "Generated by `pv fixtures build` from data/fixtures/world.yaml with the TEST master key. Do not edit.", "principals": out}


def d1_seed(world: dict) -> str:
    ps = Pseudonymizer(TEST_MASTER_KEY)
    emps = {e["id"]: e for e in world["employees"]}
    lines = ["-- Generated by `pv fixtures build` from data/fixtures/world.yaml with the TEST master key. Do not edit."]
    for p in world["principals"]:
        if "system_role" in p:
            vals = [p["id"], "system", None, p["system_role"], None, p["id"], None, "[]", "active", CREATED_AT]
        else:
            vals = [p["id"], "human", p["persona"], None, _email(emps[p["employee"]]), None, p["employee"], json.dumps(p.get("org_units", [])), p.get("status", "active"), CREATED_AT]
        lines.append(
            "INSERT INTO principals (id, kind, persona, system_role, email, service_client_id, employee_id, org_units, status, created_at) VALUES ("
            + ", ".join(sql_literal(v) for v in vals) + ");"
        )
    for e_id in sorted(emps):
        e = emps[e_id]
        refs = ps.all(e_id)
        vals = [e_id, _email(e), _name(e), refs["employee_ref"], refs["warehouse_key"], refs["analytics_id"], refs["subject_ref"], e.get("manager"),
                "terminated" if e.get("termination") else "active", e.get("termination")]
        lines.append(
            "INSERT INTO identity_map (employee_id, work_email, full_name, employee_ref, warehouse_key, analytics_id, subject_ref, manager_employee_id, employment_status, termination_date) VALUES ("
            + ", ".join(sql_literal(v) for v in vals) + ");"
        )
    for h in world.get("legal_holds", []):
        vals = [h["id"], h["matter"], ps.pseudonym("subject_ref", h["employee"]), h["reason"], "privacy-01", "2026-09-15T00:00:00Z", None, None]
        lines.append(
            "INSERT INTO legal_holds (id, matter_id, subject_ref, reason, placed_by, placed_at, released_at, released_by) VALUES ("
            + ", ".join(sql_literal(v) for v in vals) + ");"
        )
    for e_id in sorted(emps):
        if emps[e_id].get("deleted"):
            lines.append(
                "INSERT INTO suppression_list (subject_ref, request_id, created_at) VALUES ("
                + ", ".join(sql_literal(v) for v in [ps.pseudonym("subject_ref", e_id), "fixture-deleted", CREATED_AT]) + ");"
            )
    return "\n".join(lines) + "\n"


def build(out_dir: Path) -> list[Path]:
    world = load_world()
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        rows = build_warehouse(world, Path(tmp) / "world.duckdb")
    files = {
        "purpose_rows.json": json.dumps({"description": "Generated by `pv fixtures build`: rows of the real DuckDB purpose views for world.yaml. Do not edit.", "views": rows}, indent=1, sort_keys=False) + "\n",
        "authz_subjects.json": json.dumps(subjects(world), indent=1) + "\n",
        "d1_seed.sql": d1_seed(world),
    }
    written = []
    for name, content in files.items():
        p = out_dir / name
        p.write_text(content)
        written.append(p)
    return written


def check() -> list[str]:
    problems = []
    with tempfile.TemporaryDirectory() as tmp:
        build(Path(tmp))
        for name in OUTPUTS:
            committed = config.FIXTURES_DIR / name
            fresh = Path(tmp) / name
            if not committed.exists():
                problems.append(f"missing: data/fixtures/{name}")
            elif committed.read_bytes() != fresh.read_bytes():
                problems.append(f"differs: data/fixtures/{name}")
    return problems
