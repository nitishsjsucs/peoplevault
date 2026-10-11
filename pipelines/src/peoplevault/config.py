"""Paths, targets and local secrets shared by every `pv` command.

Locally the Python side reads the same `.dev.vars` (secrets) and `wrangler.jsonc` (issuer, audience,
shim URL) as the Worker, so the executor and loaders use the same master key and can mint executor JWTs.
"""

from __future__ import annotations

import base64
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Target = Literal["local", "prod"]


def _find_repo_root() -> Path:
    override = os.environ.get("PV_REPO_ROOT")
    if override:
        return Path(override).resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "wrangler.jsonc").exists() and (parent / "pipelines").is_dir():
            return parent
    raise RuntimeError("cannot locate the repository root (set PV_REPO_ROOT)")


REPO_ROOT = _find_repo_root()
PIPELINES_DIR = REPO_ROOT / "pipelines"
DATA_DIR = Path(os.environ.get("PV_DATA_DIR", PIPELINES_DIR / ".data"))
DUCKDB_PATH = Path(os.environ.get("PV_DUCKDB_PATH", DATA_DIR / "warehouse.duckdb"))
LAKE_DIR = DATA_DIR / "lake"
DBT_DIR = PIPELINES_DIR / "dbt"
POLICY_DIR = REPO_ROOT / "policy"
POLICY_YAML = POLICY_DIR / "policy.yaml"
GENERATED_DIR = REPO_ROOT / "data" / "generated"
FIXTURES_DIR = REPO_ROOT / "data" / "fixtures"
SECRETS_DIR = REPO_ROOT / ".secrets"
DEV_VARS = REPO_ROOT / ".dev.vars"
WRANGLER_JSONC = REPO_ROOT / "wrangler.jsonc"
PIDS_DIR = REPO_ROOT / ".dev" / "pids"

SHIM_PORT = int(os.environ.get("PV_SHIM_PORT", "8893"))
WORKER_PORT = 8793
INSPECTOR_PORT = 9243


def parse_env_file(path: Path) -> dict[str, str]:
    """Parses KEY=VALUE lines (no shell expansion, no quotes stripping beyond one matching pair)."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def strip_jsonc(text: str) -> str:
    """Removes // and /* */ comments outside strings, and trailing commas."""
    out: list[str] = []
    i, n, in_str = 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def read_jsonc_text(text: str) -> dict:
    return json.loads(strip_jsonc(text))


def read_jsonc(path: Path) -> dict:
    return read_jsonc_text(path.read_text())


@dataclass(frozen=True)
class LocalSettings:
    issuer: str
    audience: str
    shim_url: str
    master_key: bytes
    shim_token: str
    private_jwk: dict | None


def local_settings() -> LocalSettings:
    cfg = read_jsonc(WRANGLER_JSONC)
    vars_ = cfg.get("vars", {})
    secrets = parse_env_file(DEV_VARS)
    for name in ("PV_PSEUDONYM_MASTER_KEY", "WAREHOUSE_SHIM_TOKEN"):
        if not secrets.get(name):
            raise RuntimeError(f"{name} missing from .dev.vars; run `npm run dev:keys`")
    private = secrets.get("DEV_ACCESS_PRIVATE_JWK")
    return LocalSettings(
        issuer=vars_["DEV_ACCESS_ISSUER"],
        audience=vars_["DEV_ACCESS_AUD"],
        shim_url=vars_["WAREHOUSE_SHIM_URL"],
        master_key=base64.b64decode(secrets["PV_PSEUDONYM_MASTER_KEY"]),
        shim_token=secrets["WAREHOUSE_SHIM_TOKEN"],
        private_jwk=json.loads(private) if private else None,
    )


def prod_env() -> dict[str, str]:
    """`.secrets/prod.env` merged under the process environment (process wins)."""
    merged = parse_env_file(SECRETS_DIR / "prod.env")
    merged.update({k: v for k, v in os.environ.items() if k.startswith(("PV_", "CLOUDFLARE_"))})
    return merged


def prod_resources() -> dict:
    """`.secrets/prod-resources.json`; in the executor.yml job (no .secrets/ on the runner) the policy tag names come
    from the PV_POLICY_TAGS_JSON repository secret instead, and an environment value wins over the file."""
    path = SECRETS_DIR / "prod-resources.json"
    out = json.loads(path.read_text()) if path.exists() else {}
    raw = os.environ.get("PV_POLICY_TAGS_JSON")
    if raw:
        tags = json.loads(raw)
        if not isinstance(tags, dict) or not tags or not all(isinstance(k, str) and isinstance(v, str) and v for k, v in tags.items()):
            raise RuntimeError("PV_POLICY_TAGS_JSON must be a JSON object of data class -> policy tag resource name")
        out["policy_tags"] = tags
    return out


def executor_service_account(project: str) -> str:
    """dbt, loaders and the executor always run as pv-executor (never as the owner's user, who is in no
    row access policy and would silently read zero rows)."""
    return f"pv-executor@{project}.iam.gserviceaccount.com"


PROD_DBT_TARGETS = ("bigquery", "bigquery_actions")


def prod_dbt_target(project: str) -> str:
    """dbt target for production runs: `bigquery` (the owner's machine, impersonating pv-executor) unless
    PV_DBT_TARGET=bigquery_actions (the executor.yml job), which runs with the pv-executor key named by
    GOOGLE_APPLICATION_CREDENTIALS and refuses a key that belongs to any other identity."""
    target = os.environ.get("PV_DBT_TARGET", "bigquery")
    if target not in PROD_DBT_TARGETS:
        raise RuntimeError(f"PV_DBT_TARGET must be one of {', '.join(PROD_DBT_TARGETS)}")
    if target == "bigquery_actions":
        keyfile = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
        if not keyfile or not Path(keyfile).is_file():
            raise RuntimeError("PV_DBT_TARGET=bigquery_actions needs GOOGLE_APPLICATION_CREDENTIALS pointing at the pv-executor key")
        try:
            email = json.loads(Path(keyfile).read_text()).get("client_email")
        except (OSError, ValueError) as exc:
            raise RuntimeError("GOOGLE_APPLICATION_CREDENTIALS is not a service account key file") from exc
        if email != executor_service_account(project):
            raise RuntimeError("the key in GOOGLE_APPLICATION_CREDENTIALS is not pv-executor's; dbt runs only as pv-executor")
    return target


def public_logs() -> bool:
    """True in the executor.yml job: the repository is public and so are its Actions logs."""
    return os.environ.get("PV_PUBLIC_LOGS", "").lower() == "true"
