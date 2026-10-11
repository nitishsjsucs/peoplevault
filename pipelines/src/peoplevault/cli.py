"""`pv` command line entry point (SPEC.md section 6.6)."""

from __future__ import annotations

import json
import logging

import click

from peoplevault import __version__
from peoplevault.logging_redact import install as install_redaction
from peoplevault.logging_redact import install_public_excepthook


@click.group()
@click.version_option(__version__, prog_name="pv")
@click.option("--log-level", default="warning", type=click.Choice(["debug", "info", "warning", "error"]), show_default=True)
def main(log_level: str) -> None:
    """PeopleVault pipelines."""
    install_redaction(getattr(logging, log_level.upper()))
    from peoplevault.config import public_logs

    if public_logs():
        install_public_excepthook()


@main.command()
@click.option("--out", "out_dir", default=None, help="output directory (default data/generated)")
@click.option("--master-key-b64", default=None, envvar="PV_SYNTH_MASTER_KEY_B64", show_envvar=True,
              help="pseudonym master key (default: PV_PSEUDONYM_MASTER_KEY from .dev.vars); seed:prod passes the production key in the environment")
@click.option("--write-expected", is_flag=True, help="rewrite the committed data/expected_counts.json")
def synth(out_dir: str | None, master_key_b64: str | None, write_expected: bool) -> None:
    """Deterministic synthetic workforce generator."""
    import base64
    import json
    from pathlib import Path

    from peoplevault import config
    from peoplevault.synth.generate import generate

    key = base64.b64decode(master_key_b64) if master_key_b64 else config.local_settings().master_key
    target = Path(out_dir) if out_dir else config.GENERATED_DIR
    counts = generate(target, key)
    expected_path = config.REPO_ROOT / "data" / "expected_counts.json"
    rendered = json.dumps(counts, indent=2) + "\n"
    if write_expected:
        expected_path.write_text(rendered)
        click.echo(f"wrote {expected_path.relative_to(config.REPO_ROOT)}")
    elif expected_path.exists() and expected_path.read_text() != rendered:
        raise click.ClickException("generated counts differ from data/expected_counts.json (golden); review and rerun with --write-expected")
    click.echo(f"synth: {counts['export_objects']} export objects, {counts['export_rows_total']} export rows, "
               f"{counts['d1']['principals']} principals, {counts['d1']['identity_map']} identity rows -> {target}")


@main.command()
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
@click.option("--from-r2", is_flag=True, help="read export objects from R2 instead of data/generated")
def load(target: str, from_r2: bool) -> None:
    """Raw tables, identity xref, 13-step snapshot replay, dbt build, Iceberg employee_monthly."""
    if target == "prod":
        from peoplevault.load.prod import load_prod

        result = load_prod(from_r2=from_r2)
    else:
        from peoplevault.load.run import load_local

        result = load_local(from_r2=from_r2)
    raw = result["raw"]
    click.echo(f"load: {raw['objects_loaded']} objects, rows {raw['rows_loaded']}, xref {result['identity_xref']}, "
               f"snapshot replays {result['snapshot_replays']}, lake {result['lake']}")
    if raw["quarantined"]:
        raise click.ClickException(f"{len(raw['quarantined'])} export object(s) quarantined (unknown or missing columns); see pipelines/.data/quarantine/")


@main.command()
@click.option("--target", type=click.Choice(["local"]), default="local", show_default=True)
def counts(target: str) -> None:
    """Compares warehouse and lake row counts with data/expected_counts.json (exit 1 on any mismatch)."""
    import json

    from peoplevault import config
    from peoplevault.lake.catalog import EMPLOYEE_MONTHLY, open_catalog
    from peoplevault.warehouse.duck import DuckWarehouse

    golden = json.loads((config.REPO_ROOT / "data" / "expected_counts.json").read_text())
    wh = DuckWarehouse.open()
    problems = []
    for table, want in golden["warehouse"].items():
        got = wh.query(f"select count(*) as n from {table}")[0]["n"]
        if got != want:
            problems.append(f"{table}: expected {want}, found {got}")
    wh.close()
    tbl = open_catalog("local").load_table(EMPLOYEE_MONTHLY)
    lake_rows = tbl.scan().to_arrow().num_rows
    if lake_rows != golden["lake"]["employee_monthly"]["rows"]:
        problems.append(f"lake rows: expected {golden['lake']['employee_monthly']['rows']}, found {lake_rows}")
    if len(tbl.snapshots()) < golden["lake"]["employee_monthly"]["appends"]:
        problems.append("lake snapshots fewer than the 8 yearly appends")
    for p in problems:
        click.echo(f"MISMATCH {p}", err=True)
    if problems:
        raise SystemExit(1)
    click.echo(f"counts match: {len(golden['warehouse'])} warehouse tables and the lake table")


@main.command()
@click.option("--port", type=int, default=None, help="shim port (default 8893 or PV_SHIM_PORT)")
@click.option("--no-executor", is_flag=True, help="run only the shim")
def serve(port: int | None, no_executor: bool) -> None:
    """Local warehouse shim and executor loop for wrangler dev; owns the DuckDB file."""
    from peoplevault.serve import serve as run_serve

    run_serve(port, executor=not no_executor)


@main.group()
def executor() -> None:
    """Python executor (claims tasks from the Worker)."""


@executor.command("run")
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
@click.option("--once", is_flag=True, help="process one claimed batch and exit")
@click.option("--drain", is_flag=True, help="process until no task is pending, then exit")
def executor_run(target: str, once: bool, drain: bool) -> None:
    from peoplevault.executor.loop import PROD_POLL_S, run_loop

    if target == "prod":
        from peoplevault.executor.prod import prod_api, prod_context

        ctx = prod_context()
        try:
            n = run_loop(prod_api(), ctx, poll=PROD_POLL_S, once=once, drain=drain)
        finally:
            ctx.wh.close()
        click.echo(f"executor: {n} task(s) completed")
        return
    from peoplevault.executor.local import local_api, local_context
    from peoplevault.warehouse.duck import DuckWarehouse

    wh = DuckWarehouse.open()
    try:
        n = run_loop(local_api(), local_context(wh), once=once, drain=drain)
    finally:
        wh.close()
    click.echo(f"executor: {n} task(s) completed")


@main.group()
def authz() -> None:
    """Authorization cases at the warehouse layer."""


@authz.command("warehouse")
@click.option("--target", type=click.Choice(["local", "bigquery"]), default="local", show_default=True)
@click.option("--write-results", is_flag=True, help="write evals/results/authz-local-<date>.json")
@click.option("--pdp-report", type=click.Path(exists=True, dir_okay=False), default=None, help="vitest JSON report of the 100 pdp cases")
@click.option("--ceiling-probes", is_flag=True, help="BigQuery only: the 37 ceiling probes (section 15.8)")
@click.option("--cleanup", is_flag=True, help="BigQuery only: remove a leftover pv_authz_probe dataset and its pv_core grants, then exit")
def authz_warehouse(target: str, write_results: bool, pdp_report: str | None, ceiling_probes: bool, cleanup: bool) -> None:
    """Runs the 48 warehouse-layer cases (DuckDB from world.yaml locally; BigQuery as each purpose SA in production)."""
    import tempfile
    from pathlib import Path

    from peoplevault.authz.warehouse_runner import run_all

    if target == "bigquery":
        _authz_bigquery(write_results, ceiling_probes, cleanup)
        return
    if ceiling_probes or cleanup:
        raise click.ClickException("--ceiling-probes and --cleanup run only against BigQuery (--target bigquery)")
    from peoplevault.fixtures.world import build_warehouse, load_world
    from peoplevault.shim.queries import run_named
    from peoplevault.warehouse.duck import DuckWarehouse

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "world.duckdb"
        build_warehouse(load_world(), path)
        wh = DuckWarehouse.open(path)
        report = run_all(lambda purpose, qid, params: run_named(wh, purpose, qid, params))
        wh.close()
    click.echo(f"warehouse layer: {report.passed}/{len(report.results)} passed {report.by_category()}")
    for r in report.results:
        if not r.passed:
            click.echo(f"FAIL {r.id}: {r.detail}", err=True)
    if write_results:
        from peoplevault.authz.results import pdp_results, summarize, write

        pdp = pdp_results(Path(pdp_report)) if pdp_report else {}
        path = write(summarize(pdp, report, "npm run eval:authz"))
        click.echo(f"wrote {path}")
    if report.passed != len(report.results):
        raise SystemExit(1)


@authz.command("api")
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
@click.option("--allow-writes", is_flag=True, help="also run the cases that create a deletion request and place and release a legal hold")
@click.option("--start", is_flag=True, help="local only: start wrangler dev and pv serve for the run, and stop them afterwards")
@click.option("--write-results", is_flag=True, help="write evals/results/authz-api-local-<date>.json or authz-prod-<date>.json")
def authz_api(target: str, allow_writes: bool, start: bool, write_results: bool) -> None:
    """The case file through the deployed API against the full synthetic population (npm run authz:prod)."""
    from peoplevault.authz.api_runner import run_api

    result = run_api(target, allow_writes=allow_writes, start=start, write_results=write_results)
    api = result["layers"]["api"]
    click.echo(f"authz api ({target}): {api['passed']}/{api['runnable']} runnable cases passed, {api['skipped']} skipped")
    for reason, n in sorted(result["skip_reasons"].items()):
        click.echo(f"  skipped {n}: {reason}")
    for f in result["failures"]:
        click.echo(f"FAIL {f['id']}: {f['reason']}", err=True)
    if result.get("written"):
        click.echo(f"wrote {result['written']}")
    if api["failed"]:
        raise SystemExit(1)


def _prod_project() -> str:
    from peoplevault import config

    project = config.prod_env().get("PV_GCP_PROJECT")
    if not project:
        raise click.ClickException("PV_GCP_PROJECT missing from .secrets/prod.env (docs/PRODUCTION.md)")
    return project


def _authz_bigquery(write_results: bool, ceiling_probes: bool, cleanup: bool) -> None:
    """The 48 cases as each purpose's service account and, with --ceiling-probes, the 37 probes (written, not yet executed)."""
    from peoplevault.authz import bq_ceiling
    from peoplevault.authz.warehouse_runner import run_all

    project = _prod_project()
    if cleanup:
        from google.cloud import bigquery

        from peoplevault.warehouse.bq import executor_credentials

        bq_ceiling.cleanup_probe_dataset(bigquery.Client(project=project, credentials=executor_credentials(project), location="US"), project)
        click.echo(f"removed {bq_ceiling.PROBE_DATASET} and its pv_core view grants (if present)")
        return
    report = run_all(bq_ceiling.purpose_runner(project))
    click.echo(f"warehouse layer (BigQuery): {report.passed}/{len(report.results)} passed {report.by_category()}")
    for r in report.results:
        if not r.passed:
            click.echo(f"FAIL {r.id}: {r.detail}", err=True)
    probes = bq_ceiling.run_probes(project) if ceiling_probes else None
    if probes is not None:
        click.echo(f"ceiling probes: {probes['passed']}/{probes['total']} passed {probes['by_kind']}")
    if write_results:
        from peoplevault.authz.results import summarize_bigquery, write_bigquery

        cmd = "pv authz warehouse --target bigquery --write-results" + (" --ceiling-probes" if ceiling_probes else "")
        click.echo(f"wrote {write_bigquery(summarize_bigquery(report, probes, cmd))}")
    if report.passed != len(report.results) or (probes is not None and probes["passed"] != probes["total"]):
        raise SystemExit(1)


@main.group(name="eval")
def eval_group() -> None:
    """Evaluations."""


@eval_group.command("deletion")
@click.option("--profile", type=click.Choice(["full", "ci", "prod"]), default="ci", show_default=True)
@click.option("--no-seed", is_flag=True, help="reuse the current local state (skips seed:local --fresh)")
def eval_deletion(profile: str, no_seed: bool) -> None:
    """Deletion eval with the independent oracle and fault injection (writes evals/results/deletion-<profile>-<date>.*)."""
    if profile == "prod":
        from peoplevault.evals.prod import run_prod

        if no_seed:
            raise click.ClickException("--no-seed applies to the local profiles only (production is seeded by `npm run seed:prod`)")
        result = run_prod()
    else:
        from peoplevault.evals.deletion import run

        result = run(profile, no_seed=no_seed)
    click.echo(json.dumps({"coverage": result["coverage"]["display"], "false_clean": result["oracle"]["false_clean"],
                           "faults": f"{result['faults']['detected']}/{result['faults']['scenarios']}", "gate": result["gate"]}, indent=1))
    if profile == "ci" and not result["gate"]["passed"]:
        raise SystemExit(1)


@main.command()
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
@click.option("--with-extracts", is_flag=True, help="also create the 6 analytics extracts as analyst-01")
def warmup(target: str, with_extracts: bool) -> None:
    """Warms KV entries of kv_warmup.json through the Worker (and creates the extracts).

    Local: all 420 entries, minting a dev token for every principal. Production: only the entries whose principal has an
    Access service token (the four persona principals); the rest need a sign-in that a script cannot do."""
    from peoplevault.evals.warmup import create_extracts, load_truth, warm_kv

    if target == "prod":
        from peoplevault import config
        from peoplevault.evals.client import ProdClient
        from peoplevault.evals.prod import PROD_GENERATED

        client = ProdClient(config.prod_env())
        entries = [w for w in json.loads((PROD_GENERATED / "truth" / "kv_warmup.json").read_text()) if w["principal"] in client.principals()]
        out = {**warm_kv(client, entries), "reachable_with_service_tokens": len(entries)}
    else:
        from peoplevault.evals.client import LocalClient

        client = LocalClient(load_truth("principals.json"))
        out = warm_kv(client)
    if with_extracts:
        out.update(create_extracts(client))
    click.echo(f"warmup ({target}): {out}")
    if out["failed"]:
        raise SystemExit(1)


@main.group()
def lake() -> None:
    """Iceberg archive utilities."""


@lake.command("init")
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
def lake_init(target: str) -> None:
    """Creates hr_history.employee_monthly; for prod, first proves append, delete and overwrite on a scratch table."""
    from peoplevault.lake.catalog import open_catalog
    from peoplevault.load.lake import ensure_table

    cat = open_catalog(target)
    if target == "prod":
        from peoplevault.lake.selftest import run_selftest

        click.echo(f"lake self-test: {run_selftest(cat)['selftest']}")
    tbl = ensure_table(cat)
    click.echo(f"lake: {tbl.name()} ready ({len(tbl.snapshots())} snapshots)")


@lake.command("expire")
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
def lake_expire(target: str) -> None:
    """Local: expire snapshots older than now and purge orphaned data files. Refused for production (ADR 0004)."""
    from datetime import UTC, datetime

    from peoplevault.lake.catalog import EMPLOYEE_MONTHLY, open_catalog
    from peoplevault.lake.ops import ProductionExpiryRefused, expire_and_purge

    if target == "prod":
        raise click.ClickException(str(ProductionExpiryRefused("client-side snapshot expiry is refused for the Basin Catalog (ADR 0004); managed expiration cleans it")))
    res = expire_and_purge(open_catalog("local"), EMPLOYEE_MONTHLY, datetime.now(UTC), target=target)
    click.echo(f"lake expire: snapshots {res.snapshots_before} -> {res.snapshots_after}, orphan files removed {res.orphan_files_removed}")


@main.group()
def audit() -> None:
    """Audit copy into the Iceberg table governance.audit_events (SPEC.md section 30.3.3)."""


def _audit_target(target: str):
    from peoplevault.lake.catalog import open_catalog

    if target == "prod":
        from peoplevault.executor.prod import prod_api

        return open_catalog("prod"), prod_api()
    from peoplevault.executor.local import local_api

    return open_catalog("local"), local_api()


@audit.command("export")
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
@click.option("--rebuild", is_flag=True, help="copy the whole chain into audit_events_rebuild, check it, then swap it in")
@click.option("--if-due", is_flag=True, help="only when 1,000 events wait or the last commit is more than 24 hours old")
def audit_export_cmd(target: str, rebuild: bool, if_due: bool) -> None:
    from peoplevault.lake import audit_export as ax

    cat, api = _audit_target(target)
    if if_due and not rebuild:
        status = ax.copy_status(cat, api.audit_export, count_rows=False)
        if not ax.due(status):
            click.echo(f"audit export: not due (lag {status.lag} events, last commit {status.last_commit_age_hours or 0:.1f} h ago)")
            return
    res = ax.rebuild(cat, api.audit_export) if rebuild else ax.export_audit(cat, api.audit_export)
    click.echo(f"audit export: {res.rows} row(s) copied into {res.table} (last seq {res.last_seq}, head {res.head_seq}, attempt {res.attempts})")


@audit.command("status")
@click.option("--target", type=click.Choice(["local", "prod"]), default="prod", show_default=True)
@click.option("--json", "as_json", is_flag=True)
def audit_status_cmd(target: str, as_json: bool) -> None:
    import json as _json

    from peoplevault.lake import audit_export as ax

    cat, api = _audit_target(target)
    st = ax.copy_status(cat, api.audit_export, count_rows=False)
    out = {"exists": st.exists, "last_seq": st.last_seq, "head_seq": st.head_seq, "lag": st.lag, "last_commit_age_hours": st.last_commit_age_hours, "last_hash_matches": st.last_hash_matches}
    click.echo(_json.dumps(out) if as_json else f"audit copy: lag {st.lag} events, last commit {st.last_commit_age_hours} h ago, last hash matches D1: {st.last_hash_matches}")


@main.group()
def residuals() -> None:
    """Residual tracking."""


@residuals.command("check")
@click.option("--target", type=click.Choice(["local", "prod"]), default="local", show_default=True)
def residuals_check(target: str) -> None:
    """Token-free checks of pending residuals; posts state changes to the Worker (executor principal)."""
    from peoplevault.lake.catalog import open_catalog

    if target == "prod":
        from peoplevault.executor.prod import prod_api
        from peoplevault.residuals.check_prod import check_prod
        from peoplevault.warehouse.bq import BqWarehouse

        wh = BqWarehouse(_prod_project())
        try:
            click.echo(f"residuals check (prod): {check_prod(prod_api(), wh, open_catalog('prod'))}")
        finally:
            wh.close()
        return
    from peoplevault.executor.local import local_api
    from peoplevault.residuals.check import check_local

    out = check_local(local_api(), open_catalog("local"))
    click.echo(f"residuals check: {out}")


@main.group()
def setup() -> None:
    """Production setup steps that run in Python."""


@setup.command("gcp")
@click.option("--dry-run", is_flag=True, help="print the steps that would run; change nothing")
def setup_gcp(dry_run: bool) -> None:
    """Idempotent Google Cloud setup (APIs, service accounts, IAM, datasets, taxonomy, tags, data policies, gateway key)."""
    from peoplevault.setup import gcp
    from peoplevault.setup.doctor_gcp import _user
    from peoplevault.setup.gcp_client import RealGcpClient

    project = _prod_project()
    user = _user()
    if not user:
        raise click.ClickException("no active gcloud account; run `gcloud auth login`")
    client = RealGcpClient(project)
    recorded = gcp.gateway_key_recorded()
    if dry_run:
        res = gcp.plan(client, project, user, gateway_key_recorded=recorded)
        for step in res.steps:
            click.echo(step.line())
        click.echo(f"{len(res.steps)} step(s); nothing changed (dry run)")
        return
    try:
        res = gcp.apply(client, project, user, gateway_key_recorded=recorded)
    except Exception as e:
        if "disableServiceAccountKeyCreation" in str(e):
            raise click.ClickException("organization policy iam.disableServiceAccountKeyCreation blocks the pv-gateway key: use a project outside that "
                                       "organization or ask for an exception (docs/PRODUCTION.md step 14)") from None
        raise
    gcp.record(res.resources)
    for step in res.steps:
        click.echo(step.line())
    click.echo(f"{len(res.steps)} step(s) applied; policy tag names recorded in .secrets/prod-resources.json"
               + ("; pv-gateway key written to .secrets/worker-secrets.env" if res.resources.get("gateway_key") else ""))


@setup.command("actions-key")
@click.option("--repo", required=True, help="OWNER/NAME of the GitHub repository that runs executor.yml")
@click.option("--rotate", is_flag=True, help="replace an existing PV_GCP_EXECUTOR_KEY secret and delete the previous key")
def setup_actions_key(repo: str, rotate: bool) -> None:
    """(P1) pv-executor key for executor.yml, piped into the PV_GCP_EXECUTOR_KEY repository secret; never on disk."""
    from peoplevault import config
    from peoplevault.setup import github
    from peoplevault.setup.gcp_client import RealGcpClient

    project = _prod_project()
    recorded = config.prod_resources().get("executor_actions_key_id")
    try:
        out = github.ensure_actions_key(RealGcpClient(project), github.real_gh, repo, project, rotate=rotate, recorded_key_id=recorded)
    except Exception as e:
        if "disableServiceAccountKeyCreation" in str(e):
            raise click.ClickException("organization policy iam.disableServiceAccountKeyCreation blocks the pv-executor key: the executor keeps "
                                       "running from your machine (pv executor run --target prod --drain)") from None
        raise
    if out.get("key_id"):
        github.record_key_id(out["key_id"])
    click.echo(f"actions key: {out['action']} (secret {github.SECRET} in {repo})")


@main.group()
def doctor() -> None:
    """Checks used by `npm run doctor -- --prod`."""


@doctor.command("gcp")
@click.option("--json", "as_json", is_flag=True, help="print the checks as JSON (merged by scripts/doctor.ts)")
def doctor_gcp_cmd(as_json: bool) -> None:
    from peoplevault.setup.doctor_gcp import run_checks, to_json

    checks = run_checks()
    if as_json:
        click.echo(to_json(checks))
    else:
        for c in checks:
            click.echo(f"[{c.status}] {c.group} / {c.name}: {c.detail}" + (f"\n      fix: {c.fix}" if c.status != "ok" and c.fix else ""))
    if any(c.status == "missing" for c in checks):
        raise SystemExit(1)


@main.group()
def fixtures() -> None:
    """Committed Worker test fixtures built from data/fixtures/world.yaml."""


@fixtures.command("build")
def fixtures_build() -> None:
    from peoplevault import config
    from peoplevault.fixtures.world import build

    for p in build(config.FIXTURES_DIR):
        click.echo(f"wrote {p.relative_to(config.REPO_ROOT)}")


@fixtures.command("check")
def fixtures_check() -> None:
    from peoplevault.fixtures.world import check

    problems = check()
    for p in problems:
        click.echo(p, err=True)
    if problems:
        raise click.ClickException("committed fixtures differ from a rebuild of world.yaml; run `uv run --project pipelines pv fixtures build`")
    click.echo("fixtures check: committed fixtures match a rebuild of world.yaml")


@main.group()
def policy() -> None:
    """Compile policy/policy.yaml or check generated files for drift."""


@policy.command("compile")
def policy_compile() -> None:
    from peoplevault.policy.compile import write_all

    written = write_all()
    click.echo(f"policy compiled: {len(written)} file(s) changed")
    for rel in written:
        click.echo(f"  {rel}")


@policy.command("check")
def policy_check() -> None:
    from peoplevault.policy.compile import check

    problems = check()
    if problems:
        for p in problems:
            click.echo(p, err=True)
        raise click.ClickException("generated files drift from policy/policy.yaml; run `npm run policy:compile`")
    click.echo("policy check: generated files match policy/policy.yaml")


@main.group()
def warehouse() -> None:
    """Warehouse utilities."""


@warehouse.command("protected-schemas")
@click.option("--write", is_flag=True, help="write the baseline (only for a new repository; later changes need migrations)")
def protected_schemas(write: bool) -> None:
    """Builds every model into an empty DuckDB and compares protected table columns to the committed baseline."""
    import tempfile
    from pathlib import Path

    from peoplevault.policy import protected

    with tempfile.TemporaryDirectory() as tmp:
        cols = protected.build_empty_warehouse(Path(tmp) / "empty.duckdb")
    if write:
        protected.SCHEMAS_FILE.parent.mkdir(parents=True, exist_ok=True)
        protected.SCHEMAS_FILE.write_text(protected.render_baseline(cols))
        click.echo(f"wrote {protected.SCHEMAS_FILE}")
        return
    expected = protected.expected_columns()
    bad = [t for t in protected.PROTECTED_MODELS.values() if cols.get(t) != expected.get(t)]
    if bad:
        raise click.ClickException("protected table columns changed without a migration: " + ", ".join(bad))
    click.echo("protected schemas match the baseline plus migrations")


@main.command(name="dbt", context_settings={"ignore_unknown_options": True, "allow_extra_args": True})
@click.argument("dbt_args", nargs=-1, type=click.UNPROCESSED)
def dbt_cmd(dbt_args: tuple[str, ...]) -> None:
    """dbt with the repository's project and profiles (refuses --full-refresh on BigQuery)."""
    from peoplevault.dbtrun import DbtRefused, run

    try:
        result = run(list(dbt_args))
    except DbtRefused as exc:
        raise click.ClickException(str(exc)) from exc
    if not result.success:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
