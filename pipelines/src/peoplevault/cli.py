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
