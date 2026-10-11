"""Export objects read from R2 `pv-source-exports` with `wrangler r2 object get --pipe` (local or remote)."""

from __future__ import annotations

import subprocess
from collections.abc import Iterator
from pathlib import Path

from peoplevault import config
from peoplevault.sources.local_files import SourceObject, manifest


def _wrangler() -> str:
    return str(config.REPO_ROOT / "node_modules" / ".bin" / "wrangler")


def get_object(key: str, *, remote: bool, config_path: str | None = None) -> str:
    args = [_wrangler(), "r2", "object", "get", f"pv-source-exports/{key}", "--pipe", "--remote" if remote else "--local"]
    if config_path:
        args += ["-c", config_path]
    res = subprocess.run(args, cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"wrangler r2 object get failed for an export object ({res.returncode})")
    return res.stdout


def iter_objects(*, remote: bool, config_path: str | None = None, root: Path | None = None) -> Iterator[SourceObject]:
    """Keys and families from the manifest under `root` (default data/generated), bodies from R2."""
    for entry in manifest(root)["exports"]:
        yield SourceObject(entry["key"], entry["family"], entry["basis_date"], get_object(entry["key"], remote=remote, config_path=config_path))
