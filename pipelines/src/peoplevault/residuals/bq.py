"""BigQuery recovery-window residuals (SPEC.md section 14.4).

Production: right after the erase the executor counts the subject's rows FOR SYSTEM_TIME AS OF just before the
deletion; later `pv residuals check` runs the same read without tokens (SELECT COUNT(*)). Success means the pre-deletion
version is still recoverable (pending). Only the documented out-of-window error counts as cleared; any other error
(for example accessDenied) is error, never cleared. pv-executor can read history of row-policy tables only because it
holds bigquery.rowAccessPolicies.overrideTimeTravelRestrictions through the custom role pvTimeTravelReader.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

OUT_OF_WINDOW = re.compile(r"was created at time which is before its allowed time travel interval|before its allowed time travel interval", re.I)


@dataclass(frozen=True)
class Classification:
    state: str  # pending | cleared | error
    reason: str


def classify_time_travel_error(error: dict | None) -> Classification:
    """error: the BigQuery error object ({reason, message}) of a FOR SYSTEM_TIME AS OF read, or None on success."""
    if error is None:
        return Classification("pending", "history_readable")
    reason = str(error.get("reason", ""))
    message = str(error.get("message", ""))
    if reason == "invalid" and OUT_OF_WINDOW.search(message):
        return Classification("cleared", "out_of_time_travel_window")
    return Classification("error", reason or "unknown")


def time_travel_count_sql(table: str, deleted_ms: int) -> str:
    """Token-free probe of the pre-deletion version (timestamp one second before the deletion)."""
    return f"SELECT COUNT(*) AS n FROM `{table}` FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS({int(deleted_ms) - 1000})"
