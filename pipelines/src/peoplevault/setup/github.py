"""`pv setup actions-key --repo OWNER/NAME [--rotate]`: the peoplevault-executor key for the P1 executor.yml job.

The key is created through the IAM API and handed to `gh secret set PV_GCP_EXECUTOR_KEY` on standard input. It is
never written to disk and never printed, so no peoplevault-executor key exists on the owner's machine (the executor there
keeps impersonating peoplevault-executor). Only the key id is recorded (`executor_actions_key_id` in
.secrets/prod-resources.json), so a rotation can delete the previous key. Idempotent: an existing repository secret
is left alone unless `--rotate` is given. Status: written, not yet executed against Google Cloud or GitHub.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass

from peoplevault import config

SECRET = "PV_GCP_EXECUTOR_KEY"
_REPO = r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"


@dataclass
class GhResult:
    returncode: int
    stdout: str


GhRunner = Callable[[list[str], str | None], GhResult]


def real_gh(args: list[str], stdin: str | None = None) -> GhResult:
    """Runs gh without a shell; the secret travels on stdin, never in argv."""
    p = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True, check=False)
    return GhResult(p.returncode, p.stdout)


def check_repo(repo: str) -> str:
    import re

    if not re.match(_REPO, repo or ""):
        raise ValueError("--repo must be OWNER/NAME")
    return repo


def secret_names(gh: GhRunner, repo: str) -> set[str]:
    r = gh(["secret", "list", "--app", "actions", "--repo", repo, "--json", "name"], None)
    if r.returncode != 0:
        raise RuntimeError("gh secret list failed (run `gh auth status`; the repository must exist on GitHub)")
    return {s["name"] for s in json.loads(r.stdout or "[]")}


def set_secret(gh: GhRunner, repo: str, name: str, value: str) -> None:
    if gh(["secret", "set", name, "--app", "actions", "--repo", repo], value).returncode != 0:
        raise RuntimeError(f"gh secret set {name} failed")


def ensure_actions_key(client, gh: GhRunner, repo: str, project: str, *, rotate: bool = False, recorded_key_id: str | None = None) -> dict:
    """Returns {action: exists|created|rotated, key_id?}. A key whose upload fails is deleted again."""
    check_repo(repo)
    sa = config.executor_service_account(project)
    if SECRET in secret_names(gh, repo) and not rotate:
        return {"action": "exists"}
    key_json = client.create_sa_key(sa)
    key_id = json.loads(key_json)["private_key_id"]
    try:
        set_secret(gh, repo, SECRET, key_json)
    except Exception:
        client.delete_sa_key(sa, key_id)
        raise
    if rotate and recorded_key_id and recorded_key_id != key_id:
        client.delete_sa_key(sa, recorded_key_id)
    return {"action": "rotated" if rotate else "created", "key_id": key_id}


def record_key_id(key_id: str) -> None:
    config.SECRETS_DIR.mkdir(mode=0o700, exist_ok=True)
    path = config.SECRETS_DIR / "prod-resources.json"
    current = json.loads(path.read_text()) if path.exists() else {}
    current["executor_actions_key_id"] = key_id
    path.write_text(json.dumps(current, indent=2) + "\n")
    path.chmod(0o600)


__all__ = ["SECRET", "GhResult", "check_repo", "ensure_actions_key", "real_gh", "record_key_id", "secret_names", "set_secret"]
