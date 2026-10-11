"""peoplevault_restricted.identity_xref: employee_id to the four pseudonyms (asset id.wh.identity_xref)."""

from __future__ import annotations

from peoplevault.pseudo import Pseudonymizer


def upsert_xref(conn, employee_ids: list[str], ps: Pseudonymizer, suppressed: set[str]) -> int:
    n = 0
    conn.execute("begin transaction")
    for e_id in sorted(set(employee_ids)):
        refs = ps.all(e_id)
        if refs["subject_ref"] in suppressed:
            continue
        conn.execute("delete from peoplevault_restricted.identity_xref where employee_id = $e", {"e": e_id})
        conn.execute(
            "insert into peoplevault_restricted.identity_xref values ($e, $wk, $er, $an, $sr)",
            {"e": e_id, "wk": refs["warehouse_key"], "er": refs["employee_ref"], "an": refs["analytics_id"], "sr": refs["subject_ref"]},
        )
        n += 1
    conn.execute("commit")
    return n
