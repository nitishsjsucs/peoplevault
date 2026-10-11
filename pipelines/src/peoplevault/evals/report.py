"""Result file headers and writers. Results carry the command, date, git SHA and dirty flag; the README quotes only
the command and date (never a SHA), and only numbers present in committed evals/results/*.json files."""

from __future__ import annotations

import json
import subprocess
from datetime import date
from importlib import metadata
from pathlib import Path

from peoplevault import config

LOCAL_ENVIRONMENT = "local (Miniflare, DuckDB, pyiceberg SqlCatalog)"


def _git(*args: str) -> str:
    res = subprocess.run(["git", *args], cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    return res.stdout.strip() if res.returncode == 0 else ""


def wrangler_version() -> str:
    pkg = config.REPO_ROOT / "node_modules" / "wrangler" / "package.json"
    return json.loads(pkg.read_text())["version"] if pkg.exists() else "unknown"


def header(command: str, profile: str | None = None, environment: str = LOCAL_ENVIRONMENT) -> dict:
    def v(name: str) -> str:
        try:
            return metadata.version(name)
        except metadata.PackageNotFoundError:
            return "unknown"

    out = {
        "command": command,
        "date": date.today().isoformat(),
        "git_sha": _git("rev-parse", "HEAD") or "unknown",
        "git_dirty": bool(_git("status", "--porcelain")),
        "environment": environment,
        "versions": {"wrangler": wrangler_version(), "dbt-core": v("dbt-core"), "dbt-duckdb": v("dbt-duckdb"), "duckdb": v("duckdb"), "pyiceberg": v("pyiceberg")},
    }
    if profile:
        out["profile"] = profile
    return out


def write_result(name: str, payload: dict) -> Path:
    target = config.REPO_ROOT / "evals" / "results" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2) + "\n")
    return target
