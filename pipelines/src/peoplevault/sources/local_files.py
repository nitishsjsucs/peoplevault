"""Export objects from a directory that mirrors the R2 key layout (data/generated/exports/...)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from peoplevault import config


@dataclass(frozen=True)
class SourceObject:
    key: str
    family: str
    basis_date: str
    body: str


def manifest(root: Path | None = None) -> dict:
    return json.loads(((root or config.GENERATED_DIR) / "manifest.json").read_text())


def iter_objects(root: Path | None = None) -> Iterator[SourceObject]:
    base = root or config.GENERATED_DIR
    for entry in manifest(base)["exports"]:
        yield SourceObject(entry["key"], entry["family"], entry["basis_date"], (base / entry["key"]).read_text())
