"""peoplevault.verify imports nothing from executor, load or lake.ops (ADR 0003), checked on the import graph."""

import ast
from pathlib import Path

import peoplevault.verify as verify_pkg

FORBIDDEN = ("peoplevault.executor", "peoplevault.load", "peoplevault.lake.ops")


def test_verify_imports_nothing_from_erasure():
    pkg = Path(verify_pkg.__file__).parent
    files = sorted(pkg.glob("*.py"))
    assert len(files) >= 3
    for f in files:
        tree = ast.parse(f.read_text())
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for n in names:
                assert not n.startswith(FORBIDDEN), f"{f.name} imports {n}"
