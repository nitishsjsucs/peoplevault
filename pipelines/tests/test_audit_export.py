"""Exactly-once audit copy into governance.audit_events (SPEC.md sections 18.5 and 30.3.3), against a temporary pyiceberg
SqlCatalog and a fake export route: the first run copies the whole chain, a rerun copies nothing, a concurrent commit
makes the second exporter retry without duplicates, a tampered prev_hash stops the run with nothing committed, and the
snapshot summary holds the cursor. The same code runs against the local stack in `pv eval deletion` (audit_copy)."""

from __future__ import annotations

import hashlib

import pytest

from peoplevault.lake import audit_export as ax
from peoplevault.lake.catalog import open_catalog


def make_chain(n: int, start: int = 1, prev: str = ax.GENESIS) -> list[dict]:
    rows = []
    for seq in range(start, start + n):
        h = hashlib.sha256(f"{prev}\n{seq}".encode()).hexdigest()
        rows.append({
            "seq": seq, "id": f"id-{seq}", "ts": f"2026-10-10T00:{seq // 60 % 60:02d}:{seq % 60:02d}.000Z", "actor": "privacy-01", "actor_kind": "human",
            "persona": "privacy_officer", "purpose": "privacy_compliance", "action": "read_audit", "route": "/api/v1/privacy/audit", "subject_ref": None,
            "request_id": None, "decision": "allow", "reason": "ok", "row_count": seq, "prev_hash": prev, "hash": h,
        })
        prev = h
    return rows


class FakeRoute:
    """GET /api/v1/executor/audit-export over an in-memory chain; `on_page` runs before a page is served."""

    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.calls = 0
        self.on_page = None

    def __call__(self, after_seq: int, limit: int) -> dict:
        self.calls += 1
        if self.on_page:
            hook, self.on_page = self.on_page, None
            hook()
        page = [r for r in self.rows if r["seq"] > after_seq][:limit]
        return {"rows": [dict(r) for r in page], "headSeq": self.rows[-1]["seq"] if self.rows else 0, "nextAfterSeq": page[-1]["seq"] if page else after_seq,
                "complete": len(page) < limit}


@pytest.fixture()
def cat(tmp_path):
    return open_catalog("local", root=tmp_path / "lake")


def table_rows(cat) -> list[dict]:
    return sorted(cat.load_table(ax.TABLE).scan().to_arrow().to_pylist(), key=lambda r: r["seq"])


def test_first_run_copies_the_whole_chain_and_a_rerun_copies_nothing(cat):
    route = FakeRoute(make_chain(1234))
    first = ax.export_audit(cat, route)
    assert (first.rows, first.last_seq, first.attempts, first.complete) == (1234, 1234, 1, True)
    rows = table_rows(cat)
    assert [r["seq"] for r in rows] == list(range(1, 1235))
    assert set(rows[0]) == {f["name"] for f in ax.schema_fields()} and "detail_json" not in rows[0]
    assert rows[-1]["hash"] == route.rows[-1]["hash"]
    snaps = len(cat.load_table(ax.TABLE).snapshots())
    again = ax.export_audit(cat, route)
    assert again.rows == 0 and len(cat.load_table(ax.TABLE).snapshots()) == snaps
    assert len(table_rows(cat)) == 1234


def test_new_events_are_appended_once_in_one_commit(cat):
    route = FakeRoute(make_chain(10))
    ax.export_audit(cat, route)
    route.rows += make_chain(700, start=11, prev=route.rows[-1]["hash"])
    snaps = len(cat.load_table(ax.TABLE).snapshots())
    res = ax.export_audit(cat, route)
    assert (res.rows, res.last_seq) == (700, 710)
    assert len(cat.load_table(ax.TABLE).snapshots()) == snaps + 1  # 2 pages read, one append
    assert [r["seq"] for r in table_rows(cat)] == list(range(1, 711))


def test_the_snapshot_summary_holds_the_cursor(cat):
    route = FakeRoute(make_chain(42))
    ax.export_audit(cat, route)
    props = cat.load_table(ax.TABLE).current_snapshot().summary.additional_properties
    assert props["pv.audit.last_seq"] == "42"
    assert props["pv.audit.last_hash"] == route.rows[-1]["hash"]
    assert ax.cursor_of(cat.load_table(ax.TABLE)) == (42, route.rows[-1]["hash"])


def test_a_concurrent_commit_makes_the_second_exporter_retry_without_duplicates(cat):
    route = FakeRoute(make_chain(300))
    ax.export_audit(cat, FakeRoute(route.rows[:100]))
    other = FakeRoute(route.rows)
    # while this exporter reads its first page, another exporter commits rows 101 to 300
    route.on_page = lambda: ax.export_audit(cat, other)
    res = ax.export_audit(cat, route)
    assert res.attempts == 2 and res.rows == 0
    seqs = [r["seq"] for r in table_rows(cat)]
    assert seqs == list(range(1, 301)) and len(seqs) == len(set(seqs))


def test_a_tampered_prev_hash_stops_the_run_with_nothing_committed(cat):
    route = FakeRoute(make_chain(50))
    ax.export_audit(cat, FakeRoute(route.rows[:20]))
    before = len(cat.load_table(ax.TABLE).snapshots())
    route.rows[30] = {**route.rows[30], "prev_hash": "f" * 64}
    with pytest.raises(ax.ChainBreak) as err:
        ax.export_audit(cat, route)
    assert err.value.seq == 31
    assert len(cat.load_table(ax.TABLE).snapshots()) == before
    assert [r["seq"] for r in table_rows(cat)] == list(range(1, 21))


def test_a_chain_that_does_not_continue_the_copy_is_refused(cat):
    ax.export_audit(cat, FakeRoute(make_chain(5)))
    forged = FakeRoute(make_chain(10, prev="1" * 64))  # rows 6.. do not link to the copy's last hash
    with pytest.raises(ax.ChainBreak) as err:
        ax.export_audit(cat, forged)
    assert err.value.seq == 6


def test_status_lag_due_and_rebuild(cat):
    route = FakeRoute(make_chain(120))
    st = ax.copy_status(cat, route)
    assert (st.exists, st.lag) == (False, 120) and ax.due(st)
    ax.export_audit(cat, route)
    st = ax.copy_status(cat, route, now_ms=None)
    assert (st.exists, st.lag, st.last_hash_matches) == (True, 0, True)
    assert not ax.due(st)
    route.rows += make_chain(ax.DUE_EVENTS, start=121, prev=route.rows[-1]["hash"])
    st = ax.copy_status(cat, route)
    assert st.lag == ax.DUE_EVENTS and ax.due(st)
    stale = ax.copy_status(cat, FakeRoute(route.rows[:121]), now_ms=ax.last_commit_ms(cat.load_table(ax.TABLE)) + 25 * 3_600_000)
    assert stale.lag == 1 and ax.due(stale)
    rebuilt = ax.rebuild(cat, route)
    assert rebuilt.rows == 1120 and rebuilt.table == ax.TABLE
    assert [r["seq"] for r in table_rows(cat)] == list(range(1, 1121))
    assert ax.copy_status(cat, route).last_hash_matches


def test_rows_must_have_exactly_the_schema_fields(cat):
    rows = make_chain(3)
    rows[1]["detail_json"] = "{}"
    with pytest.raises(ValueError):
        ax.export_audit(cat, FakeRoute(rows))
