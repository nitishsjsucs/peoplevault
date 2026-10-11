"""Loads policy/cases/authz_cases.yaml and the committed fixture subjects."""

from __future__ import annotations

import json
from dataclasses import dataclass

import yaml

from peoplevault import config


@dataclass(frozen=True)
class Case:
    id: str
    category: str
    layers: tuple[str, ...]
    raw: dict


def load_cases() -> list[Case]:
    data = yaml.safe_load((config.POLICY_DIR / "cases" / "authz_cases.yaml").read_text())
    return [Case(c["id"], c["category"], tuple(c["layers"]), c) for c in data]


def load_subjects() -> dict:
    return json.loads((config.FIXTURES_DIR / "authz_subjects.json").read_text())["principals"]


def subject(subjects: dict, sel: dict) -> dict:
    return subjects[sel["principal"]][sel["selector"]][sel["index"]]
