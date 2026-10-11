"""Shared synth fixtures for tests (generated once per session into a temp dir with the test master key)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from peoplevault.pseudo import TEST_MASTER_KEY
from peoplevault.synth.exports import all_exports
from peoplevault.synth.history import monthly_rows
from peoplevault.synth.population import build_population
from peoplevault.synth.principals import build_principals
from peoplevault.synth.truth import build_cohorts


@lru_cache(maxsize=1)
def population():
    return build_population()


@lru_cache(maxsize=1)
def exports():
    return all_exports(population())


@lru_cache(maxsize=1)
def lake():
    return monthly_rows(population())


@lru_cache(maxsize=1)
def principals():
    return build_principals(population())


@lru_cache(maxsize=1)
def cohorts():
    return build_cohorts(population())


def generate_into(tmp: Path) -> dict:
    from peoplevault.synth.generate import generate

    return generate(tmp, TEST_MASTER_KEY)


def load_json(path: Path):
    return json.loads(path.read_text())
