"""Production store access for `pv eval deletion --profile prod` (SPEC.md section 19.1). Status: written, not yet
executed against Cloudflare or Google Cloud.

R2 and KV go through the Cloudflare REST API with wrangler's OAuth token (read into memory with `wrangler auth token
--json`, never printed or logged); D1 through `wrangler d1 execute --remote --json` with the rendered production
config; BigQuery through BqWarehouse as peoplevault-executor; Iceberg through the Basin Catalog REST endpoint. The eval oracle
reads production only through these readers, and planting goes straight to the stores, never through product code.
Endpoints: R2 objects list/get/delete and KV keys/values from the Cloudflare API reference (2026-10-10); the R2 list
pagination fields (`result_info.cursor`, `is_truncated`) follow the API's usual envelope and are unverified.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

import httpx

from peoplevault import config
from peoplevault.policy.model import policy

CF = "https://api.cloudflare.com/client/v4"
PROD_CONFIG = "infra/cloudflare/wrangler.production.jsonc"


def wrangler(args: list[str], *, input_text: str | None = None) -> str:
    """Runs the repository's wrangler without a shell; on failure the message names the subcommand only."""
    res = subprocess.run([str(config.REPO_ROOT / "node_modules" / ".bin" / "wrangler"), *args], cwd=config.REPO_ROOT, input=input_text,
                         capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"wrangler {' '.join(args[:2])} failed ({res.returncode})")
    return res.stdout


def _json_out(text: str):
    starts = [i for i in (text.find("["), text.find("{")) if i >= 0]
    return json.loads(text[min(starts):]) if starts else None


def oauth_token() -> str:
    token = (_json_out(wrangler(["auth", "token", "--json"])) or {}).get("token")
    if not token:
        raise RuntimeError("no wrangler OAuth token; run `npx wrangler login`")
    return token


@dataclass
class R2Object:
    bucket: str
    key: str
    body: bytes
    custom_metadata: dict = field(default_factory=dict)


class CloudflareRest:
    def __init__(self, account_id: str, token: str, http: httpx.Client | None = None):
        self.account = account_id
        self.http = http or httpx.Client(timeout=60.0)
        self.headers = {"authorization": f"Bearer {token}"}

    def _url(self, path: str) -> str:
        return f"{CF}/accounts/{self.account}{path}"

    def _envelope(self, r: httpx.Response) -> dict:
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400 or not body.get("success", False):
            codes = [e.get("code") for e in body.get("errors", [])]
            raise RuntimeError(f"Cloudflare API error {r.status_code} {codes}")
        return body

    # ---- R2 -------------------------------------------------------------------------------------------------------
    def r2_list(self, bucket: str) -> list[dict]:
        out: list[dict] = []
        cursor = None
        while True:
            params = {"per_page": 1000, **({"cursor": cursor} if cursor else {})}
            body = self._envelope(self.http.get(self._url(f"/r2/buckets/{bucket}/objects"), params=params, headers=self.headers))
            out.extend(body.get("result") or [])
            info = body.get("result_info") or {}
            cursor = info.get("cursor")
            if not cursor or info.get("is_truncated") is False:
                return out

    def r2_get(self, bucket: str, key: str) -> bytes:
        r = self.http.get(self._url(f"/r2/buckets/{bucket}/objects/{quote(key, safe='')}"), headers=self.headers)
        if r.status_code >= 400:
            raise RuntimeError(f"R2 get failed ({r.status_code})")
        return r.content

    def r2_delete(self, bucket: str, key: str) -> None:
        self._envelope(self.http.delete(self._url(f"/r2/buckets/{bucket}/objects/{quote(key, safe='')}"), headers=self.headers))

    def r2_objects(self, buckets: list[str]) -> Iterator[R2Object]:
        for b in buckets:
            for entry in self.r2_list(b):
                yield R2Object(b, entry["key"], self.r2_get(b, entry["key"]), dict(entry.get("custom_metadata") or {}))

    # ---- KV -------------------------------------------------------------------------------------------------------
    def kv_keys(self, namespace: str) -> list[str]:
        out: list[str] = []
        cursor = None
        while True:
            params = {"limit": 1000, **({"cursor": cursor} if cursor else {})}
            body = self._envelope(self.http.get(self._url(f"/storage/kv/namespaces/{namespace}/keys"), params=params, headers=self.headers))
            out.extend(k["name"] for k in body.get("result") or [])
            cursor = (body.get("result_info") or {}).get("cursor")
            if not cursor:
                return out

    def kv_get(self, namespace: str, key: str) -> str | None:
        r = self.http.get(self._url(f"/storage/kv/namespaces/{namespace}/values/{quote(key, safe='')}"), headers=self.headers)
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise RuntimeError(f"KV get failed ({r.status_code})")
        return r.text

    def kv_put(self, namespace: str, key: str, value: str) -> None:
        self._envelope(self.http.put(self._url(f"/storage/kv/namespaces/{namespace}/values/{quote(key, safe='')}"), content=value.encode(), headers=self.headers))

    def kv_delete(self, namespace: str, key: str) -> None:
        self._envelope(self.http.delete(self._url(f"/storage/kv/namespaces/{namespace}/values/{quote(key, safe='')}"), headers=self.headers))

    def kv_items(self, namespace: str) -> list[tuple[str, str]]:
        return [(k, self.kv_get(namespace, k) or "") for k in self.kv_keys(namespace)]


# ---- D1 ---------------------------------------------------------------------------------------------------------------
def d1_query(sql: str) -> list[dict]:
    return _json_out(wrangler(["d1", "execute", "pv-control", "--remote", "-c", PROD_CONFIG, "--json", "--command", sql]))[0]["results"]


def d1_exec(sql: str) -> None:
    wrangler(["d1", "execute", "pv-control", "--remote", "-c", PROD_CONFIG, "--command", sql], input_text="y\n")


# ---- planting and cleanup ----------------------------------------------------------------------------------------------
_QUALIFIED = re.compile(r"(?<![`.\w])(peoplevault_\w+\.\w+)\b")


def bigquery_sql(sql: str, project: str) -> str:
    """The fault plan's DuckDB statements in BigQuery form: project-qualified names, STRING columns, US schemas."""
    m = re.fullmatch(r"create schema if not exists (\w+)", sql.strip(), re.I)
    if m:
        return f"CREATE SCHEMA IF NOT EXISTS `{project}.{m.group(1)}` OPTIONS (location = 'US')"
    out = _QUALIFIED.sub(lambda x: f"`{project}.{x.group(1)}`", sql)
    return re.sub(r"\bvarchar\b", "STRING", out, flags=re.I)


def d1_statements(text: str) -> list[str]:
    return [s.strip() for s in text.split(";") if s.strip()]


@dataclass
class ProdTargets:
    """What planting touches, so cleanup removes exactly that."""

    r2: list[tuple[str, str]] = field(default_factory=list)
    kv: list[str] = field(default_factory=list)
    d1_tables: list[str] = field(default_factory=list)
    bq_tables: list[str] = field(default_factory=list)
    bq_schemas: list[str] = field(default_factory=list)
    lake_tables: list[str] = field(default_factory=list)
    lake_namespaces: list[str] = field(default_factory=list)


def plant_prod(plan: dict, actions: list[dict], *, cf: CloudflareRest, kv_namespace: str, wh, cat, project: str, d1=d1_exec, put_object=None) -> ProdTargets:
    t = ProdTargets()
    put_object = put_object or _wrangler_put
    for o in plan["r2"]:
        if o.get("customMetadata"):
            raise ValueError("custom-metadata faults are planted only locally (wrangler cannot set custom metadata)")
        put_object(o["bucket"], o["key"], o["body"])
        t.r2.append((o["bucket"], o["key"]))
    for o in plan["kv"]:
        cf.kv_put(kv_namespace, o["key"], o["value"])
        t.kv.append(o["key"])
    for text in plan["d1"]:
        for stmt in d1_statements(text):
            d1(stmt)
            m = re.match(r"create table if not exists (\w+)", stmt, re.I)
            if m and m.group(1) not in t.d1_tables:
                t.d1_tables.append(m.group(1))
    for a in actions:
        if a["kind"] == "duckdb":
            for sql in a["sql"]:
                wh.query(bigquery_sql(sql, project))
                m = re.match(r"create table (\S+)", sql, re.I)
                if m:
                    t.bq_tables.append(m.group(1))
                s = re.fullmatch(r"create schema if not exists (\w+)", sql.strip(), re.I)
                # the scratch dataset is created by `pv setup gcp` (the executor cannot create datasets in the shared
                # project), so cleanup drops only the planted tables in it, never the dataset
                if s and s.group(1) != policy().scratch_dataset:
                    t.bq_schemas.append(s.group(1))
        elif a["kind"] == "lake":
            import pyarrow as pa

            ns = a["table"].split(".")[0]
            if (ns,) not in cat.list_namespaces():
                cat.create_namespace(ns)
                t.lake_namespaces.append(ns)
            data = pa.table({k: pa.array(v) for k, v in a["rows"].items()})
            cat.create_table(a["table"], schema=data.schema).append(data)
            t.lake_tables.append(a["table"])
    return t


def cleanup_prod(t: ProdTargets, *, cf: CloudflareRest, kv_namespace: str, wh, cat, project: str, d1=d1_exec) -> list[str]:
    """Removes every planted object, key, table and namespace; returns what could not be removed (names only)."""
    failed: list[str] = []

    def attempt(label: str, fn) -> None:
        try:
            fn()
        except Exception:  # noqa: BLE001
            failed.append(label)

    for bucket, key in t.r2:
        attempt(f"r2:{bucket}", lambda b=bucket, k=key: cf.r2_delete(b, k))
    for key in t.kv:
        attempt("kv", lambda k=key: cf.kv_delete(kv_namespace, k))
    for table in t.d1_tables:
        attempt(f"d1:{table}", lambda x=table: d1(f"DROP TABLE IF EXISTS {x}"))
    for table in t.bq_tables:
        attempt(f"bigquery:{table}", lambda x=table: wh.query(f"DROP TABLE IF EXISTS `{project}.{x}`"))
    for schema in t.bq_schemas:
        attempt(f"bigquery:{schema}", lambda x=schema: wh.query(f"DROP SCHEMA IF EXISTS `{project}.{x}` CASCADE"))
    for table in t.lake_tables:
        attempt(f"iceberg:{table}", lambda x=table: cat.purge_table(x) if hasattr(cat, "purge_table") else cat.drop_table(x))
    for ns in t.lake_namespaces:
        attempt(f"iceberg:{ns}", lambda x=ns: cat.drop_namespace(x))
    return failed


def _wrangler_put(bucket: str, key: str, body: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "body"
        f.write_text(body)
        wrangler(["r2", "object", "put", f"{bucket}/{key}", "--remote", "-c", PROD_CONFIG, "--file", str(f)])
