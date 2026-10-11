"""The eval oracle (SPEC.md section 19.1): an independent checker that shares no code with the product's verifiers
(it imports nothing from peoplevault.verify). It computes every subject's tokens from ground truth with its own
HKDF and HMAC code, finds tokens by extraction (Python regexes with lookbehind, unlike the product's RE2 patterns),
and reads every store directly: DuckDB, pyiceberg, D1 and KV through `wrangler ... --local`, and R2 from Miniflare's
state files. The production profile passes `OracleSources` instead (evals/prod_stores.py: R2 and KV through the
Cloudflare REST API, D1 through `wrangler --remote`, BigQuery as peoplevault-executor, the Basin Catalog).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import subprocess
import tempfile
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from peoplevault import config
from peoplevault.evals.miniflare_state import read_r2_objects

# ---- tokens (independent implementation) ------------------------------------------------------------------------
_SALT = b"peoplevault/v1"


def _hkdf(master: bytes, info: bytes) -> bytes:
    prk = hmac.new(_SALT, master, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()


def oracle_pseudonym(master: bytes, kind: str, employee_id: str) -> str:
    prefix = {"warehouse_key": "wk_", "employee_ref": "er_", "analytics_id": "an_", "subject_ref": "sr_"}[kind]
    mac = hmac.new(_hkdf(master, b"pv-pseudonym:" + kind.encode()), b"v1|" + employee_id.encode(), hashlib.sha256).digest()
    return prefix + base64.b32encode(mac).decode().rstrip("=").lower()[:26]


@dataclass(frozen=True)
class SubjectTokens:
    employee_id: str
    work_email: str
    full_name: str
    employee_ref: str
    warehouse_key: str
    analytics_id: str
    subject_ref: str

    def all(self) -> list[str]:
        return [self.employee_id, self.work_email, self.full_name, self.employee_ref, self.warehouse_key, self.analytics_id]


def subject_tokens(master: bytes, truth: dict) -> SubjectTokens:
    e = truth["employee_id"]
    return SubjectTokens(e, truth["work_email"], truth["full_name"], oracle_pseudonym(master, "employee_ref", e),
                         oracle_pseudonym(master, "warehouse_key", e), oracle_pseudonym(master, "analytics_id", e), oracle_pseudonym(master, "subject_ref", e))


_ID = re.compile(r"(?<![A-Za-z0-9])E\d{5}(?!\d)")
_EMAIL = re.compile(r"(?<![A-Za-z0-9._%+-])[a-z]+\.[a-z]+@peoplevault\.test(?![A-Za-z0-9-])")
_PSEUDO = re.compile(r"(?<![a-z0-9_])(?:wk|er|an)_[a-z2-7]{26}(?![a-z0-9])")
_WORD = re.compile(r"(?<![A-Za-z])[A-Z][a-z]+(?![A-Za-z])")


class TokenIndex:
    """token -> subject id, for the subjects the oracle checks."""

    def __init__(self, subjects: dict[str, SubjectTokens]):
        self.owner: dict[str, str] = {}
        for sid, t in subjects.items():
            for tok in t.all():
                self.owner[tok] = sid

    def subjects_in(self, text: str) -> set[str]:
        if not text:
            return set()
        found = set()
        for rx in (_ID, _EMAIL, _PSEUDO):
            for m in rx.findall(text):
                if m in self.owner:
                    found.add(self.owner[m])
        words = [(m.group(), m.start(), m.end()) for m in _WORD.finditer(text)]
        for (w1, _s1, e1), (w2, s2, _e2) in zip(words, words[1:], strict=False):
            if s2 == e1 + 1 and text[e1] == " ":
                name = f"{w1} {w2}"
                if name in self.owner:
                    found.add(self.owner[name])
        return found


# ---- location to asset (the oracle's own mapping, from the policy registry data) ---------------------------------
def _registry() -> list[dict]:
    return json.loads((config.POLICY_DIR / "compiled" / "policy.json").read_text())["assets"]


def r2_asset(bucket: str, key: str) -> str | None:
    for a in _registry():
        if a["store"] == "r2" and a["location"].split("/")[0] == bucket:
            for p in a["parts"]:
                if p["location"] and key.startswith(p["location"]):
                    return a["id"]
    return None


def table_asset(store: str, table: str) -> str | None:
    for a in _registry():
        if a["store"] == store and any(p["name"] == table for p in a["parts"]):
            return a["id"]
    return None


def kv_asset(key: str) -> str | None:
    return "cache.kv.profile_cards" if key.startswith("profile:") else "cache.kv.team_rosters" if key.startswith("team:") else None


@dataclass
class OracleFindings:
    """subject id -> list of (store, location, asset id or None, match count)."""

    by_subject: dict[str, list[tuple[str, str, str | None, int]]] = field(default_factory=lambda: defaultdict(list))
    scanned: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def add(self, sid: str, store: str, location: str, asset: str | None, n: int = 1) -> None:
        for i, (s, loc, a, c) in enumerate(self.by_subject[sid]):
            if s == store and loc == location:
                self.by_subject[sid][i] = (s, loc, a, c + n)
                return
        self.by_subject[sid].append((store, location, asset, n))


# ---- store readers ------------------------------------------------------------------------------------------------
def _wrangler(args: list[str]) -> str:
    res = subprocess.run([str(config.REPO_ROOT / "node_modules" / ".bin" / "wrangler"), *args], cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"wrangler {' '.join(args[:3])} failed")
    return res.stdout


def _json_out(text: str):
    return json.loads(text[min(i for i in (text.find("["), text.find("{")) if i >= 0):])


def d1_query(sql: str) -> list[dict]:
    return _json_out(_wrangler(["d1", "execute", "pv-control", "--local", "--json", "--command", sql]))[0]["results"]


def scan_r2(idx: TokenIndex, out: OracleFindings, objects: Iterable | None = None) -> None:
    """objects: items with bucket, key, body (bytes) and custom_metadata; default Miniflare's local state files."""
    for o in read_r2_objects() if objects is None else objects:
        out.scanned["r2_objects"] += 1
        text = o.body.decode("utf-8", errors="replace")
        hits: dict[str, int] = defaultdict(int)
        for sid in idx.subjects_in(o.key):
            hits[sid] += 1
        for v in o.custom_metadata.values():
            for sid in idx.subjects_in(str(v)):
                hits[sid] += 1
        for line in text.split("\n"):
            for sid in idx.subjects_in(line):
                hits[sid] += 1
        for sid, n in hits.items():
            out.add(sid, "r2", f"{o.bucket}/{o.key}", r2_asset(o.bucket, o.key), n)


def scan_kv(idx: TokenIndex, out: OracleFindings, items: list[tuple[str, str]] | None = None) -> None:
    """items: (key, value) pairs; default every key of the local CACHE namespace through wrangler."""
    if items is not None:
        out.scanned["kv_keys"] = len(items)
        for k, v in items:
            for sid in idx.subjects_in(k) | idx.subjects_in(v or ""):
                out.add(sid, "kv", k, kv_asset(k))
        return
    keys = [k["name"] for k in _json_out(_wrangler(["kv", "key", "list", "--binding", "CACHE", "--local"]))]
    out.scanned["kv_keys"] = len(keys)
    values: dict[str, str] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(0, len(keys), 100):
            f = Path(tmp) / "keys.json"
            f.write_text(json.dumps(keys[i : i + 100]))
            got = _json_out(_wrangler(["kv", "bulk", "get", str(f), "--binding", "CACHE", "--local"]))
            values.update({k: (v if isinstance(v, str) else json.dumps(v)) for k, v in got.items() if v is not None})
    for k in keys:
        for sid in idx.subjects_in(k) | idx.subjects_in(values.get(k, "")):
            out.add(sid, "kv", k, kv_asset(k))


def scan_d1(idx: TokenIndex, out: OracleFindings, query: Callable[[str], list[dict]] | None = None) -> None:
    query = query or d1_query
    tables = [r["name"] for r in query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
    for t in tables:
        if t.startswith(("_cf_", "sqlite_")) or t == "d1_migrations":
            continue
        out.scanned["d1_tables"] += 1
        for row in query(f"SELECT * FROM {t}"):
            for v in row.values():
                if isinstance(v, str):
                    for sid in idx.subjects_in(v):
                        out.add(sid, "d1", t, "id.d1.identity_records" if t in ("identity_map", "principals") else None)


def scan_duckdb(idx: TokenIndex, out: OracleFindings, path: Path | None = None) -> None:
    import duckdb

    conn = duckdb.connect(str(path or config.DUCKDB_PATH), read_only=True)
    try:
        tables = conn.execute("select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' order by 1, 2").fetchall()
        for schema, table in tables:
            cols = [r[0] for r in conn.execute("select column_name from information_schema.columns where table_schema = ? and table_name = ? and data_type = 'VARCHAR'", [schema, table]).fetchall()]
            if not cols:
                continue
            out.scanned["warehouse_tables"] += 1
            fqn = f"{schema}.{table}"
            for row in conn.execute(f'select {", ".join(chr(34) + c + chr(34) for c in cols)} from "{schema}"."{table}"').fetchall():
                for v in row:
                    if v:
                        for sid in idx.subjects_in(v):
                            out.add(sid, "warehouse", fqn, table_asset("warehouse", fqn))
    finally:
        conn.close()


def _own_datasets(names: Iterable[str]) -> list[str]:
    """This repo's datasets: names with the policy's prefix (`peoplevault_`). The Google Cloud project is shared with three
    other repos, so a dataset of theirs that becomes visible to peoplevault-executor is never read (computed here, not
    imported from peoplevault.verify, so the oracle stays independent of the verifiers)."""
    import json as _json

    prefix = _json.loads((config.POLICY_DIR / "compiled" / "policy.json").read_text())["naming"]["prefix"] + "_"
    return [n for n in names if n.startswith(prefix)]


def scan_warehouse(idx: TokenIndex, out: OracleFindings, wh: Any) -> None:
    """Any warehouse with the Warehouse protocol (production: BigQuery as peoplevault-executor): every base table of every
    `peoplevault_*` dataset, every string column, every row."""
    for ds in _own_datasets(wh.list_datasets()):
        for ref in wh.list_base_tables([ds]):
            cols = wh.string_columns(ref)
            if not cols:
                continue
            out.scanned["warehouse_tables"] += 1
            fqn = f"{ref.dataset}.{ref.table}"
            rel = f"`{wh.project}.{fqn}`" if getattr(wh, "dialect", "") == "bigquery" else f'"{ref.dataset}"."{ref.table}"'
            quote = "`" if getattr(wh, "dialect", "") == "bigquery" else chr(34)
            for row in wh.query(f"select {', '.join(quote + c + quote for c in cols)} from {rel}"):
                for v in row.values():
                    if v:
                        for sid in idx.subjects_in(str(v)):
                            out.add(sid, "warehouse", fqn, table_asset("warehouse", fqn))


def scan_lake(idx: TokenIndex, out: OracleFindings, cat: Any = None) -> None:
    import pyarrow as pa
    import pyarrow.compute as pc

    from peoplevault.lake.catalog import open_catalog

    cat = cat if cat is not None else open_catalog("local")
    for ns in cat.list_namespaces():
        for ident in cat.list_tables(ns):
            name = ".".join(ident)
            tbl = cat.load_table(name)
            if tbl.current_snapshot() is None:
                continue
            out.scanned["lake_tables"] += 1
            t = tbl.scan().to_arrow()
            tokens = pa.array(sorted(idx.owner))
            for col in t.column_names:
                typ = t.schema.field(col).type
                if not (pa.types.is_string(typ) or pa.types.is_large_string(typ)):
                    continue
                arr = t[col].combine_chunks()
                exact = arr.filter(pc.fill_null(pc.is_in(arr, value_set=tokens), False)).to_pylist()
                for v in exact:
                    out.add(idx.owner[v], "iceberg", name, table_asset("iceberg", name))
                for v in pc.unique(arr).to_pylist():
                    if v and v not in idx.owner:
                        for sid in idx.subjects_in(v):
                            n = int(pc.sum(pc.cast(pc.equal(arr, v), pa.int64())).as_py() or 0)
                            out.add(sid, "iceberg", name, table_asset("iceberg", name), n)


@dataclass
class OracleSources:
    """Production readers (evals/prod_stores.py); every field is required so no store is skipped by accident."""

    r2_objects: Callable[[], Iterable]
    kv_items: Callable[[], list[tuple[str, str]]]
    d1_query: Callable[[str], list[dict]]
    warehouse: Any
    catalog: Any


def run_oracle(subjects: dict[str, SubjectTokens], duckdb_path: Path | None = None, *, sources: OracleSources | None = None) -> OracleFindings:
    idx = TokenIndex(subjects)
    out = OracleFindings()
    if sources is None:
        scan_r2(idx, out)
        scan_kv(idx, out)
        scan_d1(idx, out)
        scan_duckdb(idx, out, duckdb_path)
        scan_lake(idx, out)
        return out
    scan_r2(idx, out, sources.r2_objects())
    scan_kv(idx, out, sources.kv_items())
    scan_d1(idx, out, sources.d1_query)
    scan_warehouse(idx, out, sources.warehouse)
    scan_lake(idx, out, sources.catalog)
    return out
