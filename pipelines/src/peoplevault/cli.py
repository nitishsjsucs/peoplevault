"""`pv` command line entry point (SPEC.md section 6.6)."""

from __future__ import annotations

import logging

import click

from peoplevault import __version__
from peoplevault.logging_redact import install as install_redaction


@click.group()
@click.version_option(__version__, prog_name="pv")
@click.option("--log-level", default="warning", type=click.Choice(["debug", "info", "warning", "error"]), show_default=True)
def main(log_level: str) -> None:
    """PeopleVault pipelines."""
    install_redaction(getattr(logging, log_level.upper()))


@main.command()
@click.option("--out", "out_dir", default=None, help="output directory (default data/generated)")
@click.option("--master-key-b64", default=None, help="pseudonym master key (default: PV_PSEUDONYM_MASTER_KEY from .dev.vars)")
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
        raise click.ClickException("pv load --target prod is not implemented yet; it lands with the production commit (see PROGRESS.md)")
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
def serve(port: int | None) -> None:
    """Local warehouse shim (DuckDB) for wrangler dev; owns the DuckDB file."""
    from peoplevault.serve import serve as run_serve

    run_serve(port)


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
