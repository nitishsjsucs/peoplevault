"""`pv doctor gcp [--json]`: the Google Cloud and BigQuery lines of `npm run doctor -- --prod` (SPEC.md section 22.1).

One line per check, ok / warn / missing, and for every non-ok line the exact command or console step that fixes it.
gcloud is called without a shell and its output stays in memory (`print-access-token` output is never printed). The
BigQuery and Basin Catalog lines go through an injectable `Probes` object, so tests drive every branch with fakes.
Status: the gcloud lines and the setup-state line ran read-only against the shared project on 2026-10-11; the BigQuery
data probes wait for the setup steps, so they have not run against Google Cloud yet.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from peoplevault import config
from peoplevault.setup.gcp import WIDE_ACCESS_STEP

G = "Google Cloud"
B = "BigQuery objects"
C = "Cloudflare resources"
ADC_PATH = Path.home() / ".config" / "gcloud" / "application_default_credentials.json"
PROBE_DATASET = "peoplevault_authz_probe"


def required_apis() -> list[str]:
    """The APIs `pv setup gcp` enables (infra/bigquery/iam_bindings.json, generated from the policy)."""
    return list(json.loads((config.REPO_ROOT / "infra" / "bigquery" / "iam_bindings.json").read_text())["spec"]["apis"])

Runner = Callable[[list[str]], tuple[int, str]]


@dataclass
class Check:
    group: str
    name: str
    status: str
    detail: str
    fix: str | None = None


def ok(group: str, name: str, detail: str) -> Check:
    return Check(group, name, "ok", detail)


def warn(group: str, name: str, detail: str, fix: str) -> Check:
    return Check(group, name, "warn", detail, fix)


def missing(group: str, name: str, detail: str, fix: str) -> Check:
    return Check(group, name, "missing", detail, fix)


def default_run(args: list[str]) -> tuple[int, str]:
    exe = shutil.which(args[0])
    if exe is None:
        return 127, ""
    try:
        p = subprocess.run([exe, *args[1:]], capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    return p.returncode, p.stdout


class Probes(Protocol):
    def setup_steps(self) -> list[str]: ...
    def impersonate(self, service_account: str) -> None: ...
    def controls(self) -> list[str]: ...
    def probe_dataset_leftovers(self) -> int: ...
    def counts(self, tables: list[str]) -> dict[str, int]: ...
    def catalog_namespaces(self) -> list: ...


def _json(text: str, default):
    try:
        return json.loads(text) if text.strip() else default
    except json.JSONDecodeError:
        return default


def gcloud_checks(run: Runner, env: dict[str, str], adc_path: Path = ADC_PATH) -> tuple[list[Check], bool]:
    """gcloud, login, ADC and quota project, project, billing, APIs. Returns (checks, BigQuery checks may run)."""
    out: list[Check] = []
    code, text = run(["gcloud", "--version"])
    if code != 0:
        out.append(missing(G, "gcloud", "not installed", "brew install --cask gcloud-cli"))
        return out, False
    out.append(ok(G, "gcloud", (text.splitlines() or ["installed"])[0]))
    code, text = run(["gcloud", "auth", "list", "--format=json"])
    active = [a for a in _json(text, []) if a.get("status") == "ACTIVE"] if code == 0 else []
    out.append(ok(G, "gcloud login", "1 active account") if active else missing(G, "gcloud login", "no active account", "gcloud auth login"))
    code, _token = run(["gcloud", "auth", "application-default", "print-access-token"])
    adc = code == 0
    out.append(ok(G, "application default credentials", "available") if adc else missing(G, "application default credentials", "none", "gcloud auth application-default login"))
    project = env.get("PV_GCP_PROJECT")
    code, text = run(["gcloud", "config", "get-value", "project"])
    current = text.strip() if code == 0 else ""
    if not project:
        value = current or "<PROJECT_ID>"
        out.append(missing(G, "project", "PV_GCP_PROJECT not set", f"add PV_GCP_PROJECT={value} to .secrets/prod.env"
                           + (" (gcloud's current project; " if current else " (") + "docs/PRODUCTION.md step 10 names the shared project)"))
        return out, False
    quota = _json(adc_path.read_text(), {}).get("quota_project_id") if adc_path.exists() else None
    out.append(ok(G, "ADC quota project", project) if quota == project else
               missing(G, "ADC quota project", f"{quota or 'none'} (want {project})", f"gcloud auth application-default set-quota-project {project}"))
    out.append(ok(G, "gcloud project", project) if current == project else warn(G, "gcloud project", f"{current or 'unset'} (want {project})", f"gcloud config set project {project}"))
    code, text = run(["gcloud", "billing", "projects", "describe", project, "--format=json"])
    info = _json(text, {}) if code == 0 else {}
    account = str(info.get("billingAccountName") or "").removeprefix("billingAccounts/")
    if info.get("billingEnabled") is True:
        out.append(ok(G, "billing", "enabled"))
    elif account:
        # the project names a billing account but billing is off: the account is closed or the link was disabled
        out.append(missing(G, "billing", f"not enabled (the project names billing account {account})",
                           f"check that billing account {account} is open, then gcloud billing projects link {project} --billing-account={account} (docs/PRODUCTION.md step 11)"))
    else:
        out.append(missing(G, "billing", "not enabled or not readable", f"gcloud billing projects link {project} --billing-account=<BILLING_ACCOUNT_ID> (docs/PRODUCTION.md step 11)"))
    code, text = run(["gcloud", "services", "list", "--enabled", "--project", project, "--format=json"])
    enabled = {s.get("config", {}).get("name") for s in _json(text, [])} if code == 0 else set()
    apis = required_apis()
    absent = [a for a in apis if a not in enabled]
    # `pv setup gcp` enables them itself (setup:prod does not stop on this line); the command is for doing it by hand
    out.append(ok(G, "APIs", f"{len(apis)} of {len(apis)} enabled") if not absent else
               missing(G, "APIs", f"not enabled: {', '.join(absent)}", "npm run setup:prod (pv setup gcp enables them), or gcloud services enable " + " ".join(absent)))
    return out, adc and bool(active)


DATA_CHECKS = "impersonation, protected tables, probe dataset, data loaded"


def bigquery_checks(probes: Probes, project: str, expected: dict[str, int], purpose_sas: list[str]) -> list[Check]:
    out: list[Check] = []
    try:
        steps = probes.setup_steps()
        out.append(ok(B, "service accounts, IAM, datasets, taxonomy, tags, data policies", "nothing left to create") if not steps else
                   missing(B, "service accounts, IAM, datasets, taxonomy, tags, data policies", f"{len(steps)} setup step(s) outstanding, first: {steps[0]}", "npm run setup:prod"))
    except Exception as e:  # noqa: BLE001
        steps = None
        out.append(missing(B, "setup state", f"could not read ({type(e).__name__})", "npm run setup:prod"))
    if steps is not None:
        # shared project: a dataset with BigQuery's default access list is readable by every project Viewer
        wide = [s.split(": ", 2)[1] for s in steps if s.startswith(f"{WIDE_ACCESS_STEP}: ")]
        out.append(ok(B, "dataset access", "no peoplevault_* dataset grants project-wide special groups") if not wide else
                   missing(B, "dataset access", f"project-wide entries (every Viewer, Editor or Owner of the shared project) on: {', '.join(wide)}", "npm run setup:prod"))
    if steps is None or steps:
        # the identities, datasets and tags these checks use come from the setup steps above
        out.append(missing(B, "BigQuery data checks", f"skipped until the setup steps above are done: {DATA_CHECKS}", "npm run setup:prod, then npm run doctor -- --prod"))
        return out
    failed = []
    for sa in [f"peoplevault-executor@{project}.iam.gserviceaccount.com", *purpose_sas]:
        try:
            probes.impersonate(sa)
        except Exception:  # noqa: BLE001
            failed.append(sa.split("@")[0])
    out.append(ok(B, "impersonation", f"SELECT 1 as peoplevault-executor and {len(purpose_sas)} purpose service accounts") if not failed else
               missing(B, "impersonation", f"failed for: {', '.join(failed)}", "npm run setup:prod (grants your user Token Creator; IAM changes take about 30 seconds)"))
    try:
        problems = probes.controls()
        out.append(ok(B, "protected tables intact", "every tag and both row access policies present") if not problems else
                   missing(B, "protected tables intact", f"{len(problems)} problem(s), first: {problems[0]}", "uv run --project pipelines pv load --target prod (never a full refresh)"))
    except Exception as e:  # noqa: BLE001
        out.append(missing(B, "protected tables intact", f"could not verify ({type(e).__name__})", "uv run --project pipelines pv load --target prod"))
    try:
        leftover = probes.probe_dataset_leftovers()
        out.append(missing(B, "probe dataset", f"{PROBE_DATASET} still holds {leftover} probe view(s)", "uv run --project pipelines pv authz warehouse --target bigquery --cleanup") if leftover else
                   ok(B, "probe dataset", f"{PROBE_DATASET} empty"))
    except Exception as e:  # noqa: BLE001
        out.append(missing(B, "probe dataset", f"could not check ({type(e).__name__})", "npm run setup:prod"))
    try:
        got = probes.counts(sorted(expected))
        empty = [t for t in sorted(expected) if got.get(t, 0) == 0]
        # deletions and retention only ever lower a count, so a count above the seed means a load added rows twice
        above = [t for t in sorted(expected) if got.get(t, 0) > expected[t]]
        differ = [t for t in sorted(expected) if 0 < got.get(t, 0) < expected[t]]
        if empty:
            out.append(missing(B, "data loaded", f"zero rows in: {', '.join(empty)}", "npm run seed:prod"))
        elif above:
            out.append(missing(B, "data loaded", f"{len(above)} table(s) above the seed counts (deletions only lower them): {', '.join(above)}",
                               "a load added rows twice to a merge-only table: inspect it before any further load (no full refresh, ADR 0006)"))
        elif differ:
            out.append(warn(B, "data loaded", f"{len(differ)} table(s) differ from the seed counts (expected after deletions): {', '.join(differ)}", "npm run seed:prod on a fresh project"))
        else:
            out.append(ok(B, "data loaded", f"{len(expected)} tables match data/expected_counts.json"))
    except Exception as e:  # noqa: BLE001
        out.append(missing(B, "data loaded", f"could not count ({type(e).__name__})", "npm run seed:prod"))
    return out


def catalog_check(probes: Probes | None, env: dict[str, str]) -> Check:
    need = [k for k in ("PV_R2_CATALOG_TOKEN", "PV_CATALOG_URI", "PV_CATALOG_WAREHOUSE") if not env.get(k)]
    if need:
        return missing(C, "Basin Catalog (pyiceberg)", f"not set: {', '.join(need)}", "create the R2 API token (docs/PRODUCTION.md step 8), then npm run setup:prod")
    try:
        ns = (probes or LiveProbes(env.get("PV_GCP_PROJECT", ""))).catalog_namespaces()
        return ok(C, "Basin Catalog (pyiceberg)", f"REST catalog reachable, {len(ns)} namespace(s)")
    except Exception as e:  # noqa: BLE001
        return missing(C, "Basin Catalog (pyiceberg)", f"list_namespaces failed ({type(e).__name__})", "check PV_R2_CATALOG_TOKEN (Workers R2 Data Catalog Write and Workers R2 Storage Bucket Item Write on pv-lake, docs/PRODUCTION.md step 8) and npm run setup:prod")


class LiveProbes:
    """The real probes (user ADC; BigQuery reads as peoplevault-executor by impersonation)."""

    def __init__(self, project: str):
        self.project = project

    def setup_steps(self) -> list[str]:
        from peoplevault.setup.gcp import gateway_key_recorded, plan
        from peoplevault.setup.gcp_client import RealGcpClient

        return [s.line() for s in plan(RealGcpClient(self.project), self.project, _user(), gateway_key_recorded=gateway_key_recorded()).steps]

    def impersonate(self, service_account: str) -> None:
        import google.auth
        from google.auth import impersonated_credentials
        from google.cloud import bigquery

        source, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds = impersonated_credentials.Credentials(source_credentials=source, target_principal=service_account, target_scopes=["https://www.googleapis.com/auth/cloud-platform"])
        from peoplevault.bqjob import run_query

        list(run_query(bigquery.Client(project=self.project, credentials=creds, location="US"), "SELECT 1").result())

    def controls(self) -> list[str]:
        from peoplevault.setup.bq_controls import live_verify

        return live_verify(self.project)

    def _bq(self):
        from google.cloud import bigquery

        from peoplevault.warehouse.bq import executor_credentials

        return bigquery.Client(project=self.project, credentials=executor_credentials(self.project), location="US")

    def probe_dataset_leftovers(self) -> int:
        """Probe views left in the probe dataset (setup creates the dataset; a probe run empties it afterwards)."""
        from google.api_core.exceptions import NotFound

        try:
            return sum(1 for _ in self._bq().list_tables(f"{self.project}.{PROBE_DATASET}"))
        except NotFound:
            return 0

    def counts(self, tables: list[str]) -> dict[str, int]:
        from peoplevault.bqjob import run_query

        client = self._bq()
        return {t: int(next(iter(run_query(client, f"SELECT COUNT(*) AS n FROM `{self.project}.{t}`").result()))["n"]) for t in tables}

    def catalog_namespaces(self) -> list:
        from peoplevault.lake.catalog import open_catalog

        return list(open_catalog("prod").list_namespaces())


def _user() -> str:
    code, text = default_run(["gcloud", "config", "get-value", "account"])
    return text.strip() if code == 0 else ""


def run_checks(run: Runner = default_run, env: dict[str, str] | None = None, probes: Probes | None = None, adc_path: Path = ADC_PATH) -> list[Check]:
    env = config.prod_env() if env is None else env
    out, can_query = gcloud_checks(run, env, adc_path)
    project = env.get("PV_GCP_PROJECT", "")
    if can_query and project:
        from peoplevault.policy.model import policy

        expected = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())["warehouse"]
        sas = [f"{pd.bq_identity}@{project}.iam.gserviceaccount.com" for pd in policy().purposes.values()]
        out += bigquery_checks(probes or LiveProbes(project), project, expected, sas)
    else:
        out.append(missing(B, "BigQuery checks", "skipped until the Google Cloud lines above are ok", "fix the lines above, then npm run doctor -- --prod"))
    out.append(catalog_check(probes, env))
    return out


def to_json(checks: list[Check]) -> str:
    return json.dumps([{k: v for k, v in asdict(c).items() if v is not None} for c in checks], indent=1)
