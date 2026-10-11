"""Identifier tokens of a subject and boundary-aware matchers (SPEC.md section 14.3).

Known identifier and pseudonym columns are compared with exact equality. Every other string is searched with
one regex per token, written in RE2 syntax (no lookbehind) so the same pattern works in BigQuery
REGEXP_CONTAINS, DuckDB regexp_matches, Python re and JavaScript. Out-of-design spellings (uppercased email,
"Last, First", base64 of the id) are deliberately not matched.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TOKEN_KINDS = ("employee_id", "work_email", "full_name", "employee_ref", "warehouse_key", "analytics_id")
EXACT_COLUMNS = frozenset({
    "employee_id", "manager_employee_id", "reviewer_employee_id", "employee_key", "manager_key", "reviewer_key",
    "employee_ref", "analytics_id", "work_email",
})
_RE2_SPECIAL = set("\\.^$|?*+()[]{}/")


def re2_escape(s: str) -> str:
    return "".join("\\" + c if c in _RE2_SPECIAL else c for c in s)


def pattern_for(kind: str, token: str) -> str:
    esc = re2_escape(token)
    if kind == "work_email":
        return r"(?:^|[^A-Za-z0-9._%+-])" + esc + r"(?:$|[^A-Za-z0-9-])"
    if kind == "full_name":
        return r"(?:^|[^A-Za-z])" + esc + r"(?:$|[^A-Za-z])"
    if kind == "employee_id":
        return r"(?:^|[^A-Za-z0-9])" + esc + r"(?:$|[^0-9])"
    if kind in ("employee_ref", "warehouse_key", "analytics_id"):
        return r"(?:^|[^a-z0-9_])" + esc + r"(?:$|[^a-z0-9])"
    raise ValueError(f"unknown token kind {kind}")


@dataclass(frozen=True)
class TokenMatcher:
    kind: str
    token: str
    pattern: str

    def test(self, value: str) -> bool:
        return re.search(self.pattern, value) is not None


def subject_tokens(ids: dict[str, str], *, include_full_name: bool = True) -> dict[str, str]:
    """ids: employee_id, work_email, full_name, employee_ref, warehouse_key, analytics_id -> {token: kind}."""
    out = {}
    for kind in TOKEN_KINDS:
        if kind == "full_name" and not include_full_name:
            continue
        value = ids.get(kind)
        if value:
            out[value] = kind
    return out


def matchers(tokens: dict[str, str]) -> list[TokenMatcher]:
    return [TokenMatcher(kind, token, pattern_for(kind, token)) for token, kind in tokens.items()]


def value_matches(column: str | None, value: object, ms: list[TokenMatcher]) -> list[str]:
    """Token kinds that match one value. Exact equality on identifier columns, boundary-aware regex elsewhere."""
    if value is None:
        return []
    text = value if isinstance(value, str) else str(value)
    if column is not None and column in EXACT_COLUMNS:
        return [m.kind for m in ms if text == m.token]
    return [m.kind for m in ms if m.test(text)]
