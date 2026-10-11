"""Exactly-once audit copy into the Iceberg table `governance.audit_events` (SPEC.md section 30.3.3).

Basin Pipelines is Workers Paid only, so the copy is pulled instead of streamed. D1's hash chain stays the source of
truth. One run:

1. opens the catalog (SqlCatalog locally, the Basin Catalog REST catalog in production) and creates the table from
   `infra/lake/audit-events.schema.json` if needed;
2. reads its cursor, `pv.audit.last_seq` and `pv.audit.last_hash`, from the current snapshot's summary (0 and the
   genesis hash for a new table);
3. pages `GET /api/v1/executor/audit-export` from there (at most 20,000 rows per run) and checks that the chain links:
   the first row's `prev_hash` is the cursor's hash and every later `prev_hash` is the previous row's `hash`. A broken
   link stops the run and nothing is committed;
4. appends everything it read in ONE commit whose snapshot summary carries the new cursor. pyiceberg 0.12.0 commits an
   append with `AssertRefSnapshotId`, so a concurrent exporter's commit makes this one fail; the run then reloads the
   cursor and reads again (at most 3 times). pyiceberg would otherwise retry a failed commit by itself, re-applying the
   same rows on top of the other exporter's commit (duplicates), so the table sets `commit.retry.num-retries` to 0.
   The rows and the cursor commit together, so a rerun copies nothing and nothing is copied twice or skipped.

`--rebuild` writes `governance.audit_events_rebuild` from seq 0 and swaps names only after its row count and last hash
match D1.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from peoplevault import config

TABLE = "governance.audit_events"
REBUILD_TABLE = "governance.audit_events_rebuild"
SUMMARY_SEQ = "pv.audit.last_seq"
SUMMARY_HASH = "pv.audit.last_hash"
GENESIS = "0" * 64
PAGE = 500
MAX_ROWS_PER_RUN = 20_000
ATTEMPTS = 3
# executor.yml exports when this many events wait or the last commit is older than a day (SPEC.md 30.3.3)
DUE_EVENTS = 1000
DUE_HOURS = 24

SCHEMA_PATH = config.REPO_ROOT / "infra" / "lake" / "audit-events.schema.json"
# no client-side commit retry: a failed append must surface so the run re-reads its cursor (see the docstring)
TABLE_PROPERTIES = {"commit.retry.num-retries": "0"}

# (after_seq, limit) -> {"rows": [...], "headSeq": int, "nextAfterSeq": int, "complete": bool}
PageFn = Callable[[int, int], dict]


class ChainBreak(Exception):
    """The rows read do not link to the copy's cursor or to each other; nothing was committed."""

    def __init__(self, seq: int):
        super().__init__(f"audit chain does not link at seq {seq}")
        self.seq = seq


@dataclass
class ExportResult:
    table: str
    rows: int
    last_seq: int
    last_hash: str
    head_seq: int
    attempts: int
    snapshot_id: int | None
    # false when the run stopped at MAX_ROWS_PER_RUN with rows still waiting
    complete: bool = True


def schema_fields() -> list[dict]:
    return json.loads(SCHEMA_PATH.read_text())["fields"]


def iceberg_schema():
    from pyiceberg.schema import Schema
    from pyiceberg.types import LongType, NestedField, StringType, TimestamptzType

    types = {"string": StringType, "int64": LongType, "timestamp": TimestamptzType}
    return Schema(*[NestedField(i + 1, f["name"], types[f["type"]](), required=bool(f["required"])) for i, f in enumerate(schema_fields())])


def arrow_schema():
    import pyarrow as pa

    types = {"string": pa.string(), "int64": pa.int64(), "timestamp": pa.timestamp("us", tz="UTC")}
    return pa.schema([pa.field(f["name"], types[f["type"]], nullable=not f["required"]) for f in schema_fields()])


def to_arrow(rows: list[dict]):
    import pyarrow as pa

    names = [f["name"] for f in schema_fields()]
    cols: dict[str, list] = {n: [] for n in names}
    for r in rows:
        if set(r) != set(names):
            raise ValueError("an exported row does not have exactly the schema's fields")
        for n in names:
            v = r[n]
            if n == "ts":
                v = datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(UTC)
            cols[n].append(v)
    return pa.Table.from_pydict(cols, schema=arrow_schema())


def ensure_table(cat, name: str = TABLE):
    from pyiceberg.exceptions import NamespaceAlreadyExistsError, NoSuchTableError

    ns = name.split(".")[0]
    try:
        cat.create_namespace(ns)
    except NamespaceAlreadyExistsError:
        pass
    try:
        tbl = cat.load_table(name)
    except NoSuchTableError:
        return cat.create_table(name, schema=iceberg_schema(), properties=TABLE_PROPERTIES)
    if any(tbl.metadata.properties.get(k) != v for k, v in TABLE_PROPERTIES.items()):
        with tbl.transaction() as tx:
            tx.set_properties(**TABLE_PROPERTIES)
        tbl = cat.load_table(name)
    return tbl


def cursor_of(tbl) -> tuple[int, str]:
    snap = tbl.current_snapshot()
    if snap is None or snap.summary is None:
        return 0, GENESIS
    props = snap.summary.additional_properties
    if SUMMARY_SEQ not in props or SUMMARY_HASH not in props:
        return 0, GENESIS
    return int(props[SUMMARY_SEQ]), props[SUMMARY_HASH]


def last_commit_ms(tbl) -> int | None:
    snap = tbl.current_snapshot()
    return int(snap.timestamp_ms) if snap is not None else None


def read_pages(page: PageFn, after_seq: int, max_rows: int = MAX_ROWS_PER_RUN) -> tuple[list[dict], int, bool]:
    """Rows after `after_seq` until the route says complete or `max_rows` is reached; returns rows, head, complete."""
    rows: list[dict] = []
    head = after_seq
    after = after_seq
    while len(rows) < max_rows:
        out = page(after, min(PAGE, max_rows - len(rows)))
        head = max(head, int(out["headSeq"]))
        got = out["rows"]
        rows.extend(got)
        if out["complete"] or not got:
            return rows, head, True
        after = int(out["nextAfterSeq"])
    return rows, head, False


def check_chain(rows: list[dict], last_seq: int, last_hash: str) -> None:
    prev_seq, prev_hash = last_seq, last_hash
    for r in rows:
        if int(r["seq"]) <= prev_seq or r["prev_hash"] != prev_hash:
            raise ChainBreak(int(r["seq"]))
        prev_seq, prev_hash = int(r["seq"]), r["hash"]


def export_audit(cat, page: PageFn, *, table: str = TABLE, attempts: int = ATTEMPTS, max_rows: int = MAX_ROWS_PER_RUN) -> ExportResult:
    """One exactly-once export run (see the module docstring)."""
    from pyiceberg.exceptions import CommitFailedException

    for attempt in range(1, attempts + 1):
        tbl = ensure_table(cat, table)
        last_seq, last_hash = cursor_of(tbl)
        rows, head, complete = read_pages(page, last_seq, max_rows)
        if not rows:
            snap = tbl.current_snapshot()
            return ExportResult(table, 0, last_seq, last_hash, head, attempt, snap.snapshot_id if snap else None, True)
        check_chain(rows, last_seq, last_hash)
        new_seq, new_hash = int(rows[-1]["seq"]), rows[-1]["hash"]
        try:
            tbl.append(to_arrow(rows), snapshot_properties={SUMMARY_SEQ: str(new_seq), SUMMARY_HASH: new_hash})
        except CommitFailedException:
            continue  # another exporter committed first: reload the cursor and read again
        snap = tbl.current_snapshot()
        return ExportResult(table, len(rows), new_seq, new_hash, head, attempt, snap.snapshot_id if snap else None, complete)
    raise RuntimeError(f"audit export did not commit after {attempts} attempts (concurrent exporters)")


@dataclass
class CopyStatus:
    exists: bool
    rows: int
    last_seq: int
    last_hash: str
    head_seq: int
    lag: int
    last_commit_age_hours: float | None
    d1_hash_at_last_seq: str | None

    @property
    def last_hash_matches(self) -> bool:
        return self.last_seq == 0 or self.d1_hash_at_last_seq == self.last_hash


def copy_status(cat, page: PageFn, *, table: str = TABLE, now_ms: int | None = None, count_rows: bool = True) -> CopyStatus:
    """Lag and freshness of the copy, and whether its last hash is D1's hash at that seq (one page of one row)."""
    from pyiceberg.exceptions import NoSuchTableError

    now_ms = now_ms if now_ms is not None else int(datetime.now(UTC).timestamp() * 1000)
    try:
        tbl = cat.load_table(table)
    except NoSuchTableError:
        out = page(0, 1)
        return CopyStatus(False, 0, 0, GENESIS, int(out["headSeq"]), int(out["headSeq"]), None, None)
    last_seq, last_hash = cursor_of(tbl)
    out = page(max(0, last_seq - 1), 1)
    d1_hash = next((r["hash"] for r in out["rows"] if int(r["seq"]) == last_seq), None)
    committed = last_commit_ms(tbl)
    rows = tbl.scan().to_arrow().num_rows if count_rows else last_seq
    return CopyStatus(True, rows, last_seq, last_hash, int(out["headSeq"]), max(0, int(out["headSeq"]) - last_seq),
                      None if committed is None else (now_ms - committed) / 3_600_000, d1_hash)


def d1_page(query: Callable[[str], list[dict]]) -> PageFn:
    """A read-only page function over D1 itself (SELECT through `wrangler d1 execute`), for status checks only: the
    Worker's export route appends an audit event on every call (reads of the chain are audited), so a status check
    through it would write to the production chain each time the doctor runs. Returns seq and hash only."""

    def page(after_seq: int, limit: int) -> dict:
        rows = query(f"SELECT seq, hash FROM audit_events WHERE seq > {int(after_seq)} ORDER BY seq LIMIT {int(limit)}")
        head = query("SELECT COALESCE(MAX(seq), 0) AS head FROM audit_events")
        return {"rows": rows, "headSeq": int(head[0]["head"]) if head else 0}

    return page


def due(status: CopyStatus) -> bool:
    """executor.yml's rule: export when 1,000 events wait or the last commit is more than 24 hours old."""
    if not status.exists:
        return True
    return status.lag >= DUE_EVENTS or (status.lag > 0 and (status.last_commit_age_hours is None or status.last_commit_age_hours > DUE_HOURS))


def rebuild(cat, page: PageFn) -> ExportResult:
    """Copies the whole chain into a fresh `audit_events_rebuild` table, checks it against D1 (row count and the hash
    at its last seq), then swaps it in for `audit_events`."""
    from pyiceberg.exceptions import NoSuchTableError

    try:
        cat.drop_table(REBUILD_TABLE)
    except NoSuchTableError:
        pass
    total: ExportResult | None = None
    while True:
        # each run reads until the route is complete (or 20,000 rows); the export pages' own audit events, appended
        # while it reads, wait for the next regular export
        res = export_audit(cat, page, table=REBUILD_TABLE)
        total = res if total is None else ExportResult(res.table, total.rows + res.rows, res.last_seq, res.last_hash, res.head_seq, res.attempts, res.snapshot_id, res.complete)
        if res.complete:
            break
    status = copy_status(cat, page, table=REBUILD_TABLE)
    if not status.last_hash_matches or status.rows != total.rows:
        raise RuntimeError("the rebuilt audit copy does not match D1; audit_events was left as it was")
    try:
        cat.drop_table(TABLE)
    except NoSuchTableError:
        pass
    cat.rename_table(REBUILD_TABLE, TABLE)
    return ExportResult(TABLE, total.rows, total.last_seq, total.last_hash, total.head_seq, total.attempts, total.snapshot_id)
