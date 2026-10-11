import hashlib

from synth_helpers import generate_into


def _digest(root):
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(root).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def test_two_runs_are_byte_identical(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    ca = generate_into(a)
    cb = generate_into(b)
    assert ca == cb
    assert _digest(a) == _digest(b)
    files = [p for p in a.rglob("*") if p.is_file()]
    assert len([p for p in files if p.parts[-4:-3] and "exports" in p.relative_to(a).parts[0]]) == 41
