"""Logging filter that replaces employee identifiers with [redacted].

Installed on the root logger before anything else runs (`install()`), so identifiers never reach local
logs or, in P1, public GitHub Actions logs. Covers employee ids, email addresses, pseudonyms of the four
kinds, synthetic full names (any first and last name from the generator's lists, plus names registered
at runtime) and exception text.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable

REDACTED = "[redacted]"

_EMPLOYEE_ID = re.compile(r"E\d{5}")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PSEUDONYM = re.compile(r"(?:wk|er|an|sr)_[a-z2-7]{26}")

_extra_names: set[str] = set()
_name_pattern: re.Pattern[str] | None = None


def _build_name_pattern() -> re.Pattern[str] | None:
    firsts: list[str] = []
    lasts: list[str] = []
    try:
        from peoplevault.synth.names import FIRST_NAMES, LAST_NAMES  # generator lists (commit 7)

        firsts, lasts = list(FIRST_NAMES), list(LAST_NAMES)
    except ImportError:
        pass
    parts: list[str] = []
    if firsts and lasts:
        f = "|".join(sorted(map(re.escape, firsts), key=len, reverse=True))
        last = "|".join(sorted(map(re.escape, lasts), key=len, reverse=True))
        parts.append(rf"\b(?:{f})\s+(?:{last})\b")
        parts.append(rf"\b(?:{last}),\s*(?:{f})\b")
    if _extra_names:
        parts.append("|".join(sorted(map(re.escape, _extra_names), key=len, reverse=True)))
    return re.compile("|".join(parts)) if parts else None


def register_names(names: Iterable[str]) -> None:
    """Adds full names that must be redacted (for example names outside the generator's lists)."""
    global _name_pattern
    _extra_names.update(n for n in names if n)
    _name_pattern = _build_name_pattern()


def redact(text: str) -> str:
    global _name_pattern
    if _name_pattern is None:
        _name_pattern = _build_name_pattern()
    text = _EMAIL.sub(REDACTED, text)
    text = _PSEUDONYM.sub(REDACTED, text)
    text = _EMPLOYEE_ID.sub(REDACTED, text)
    if _name_pattern is not None:
        text = _name_pattern.sub(REDACTED, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # malformed format args: keep the template only
            message = str(record.msg)
        record.msg = redact(message)
        record.args = None
        if record.exc_info:
            etype, evalue, _tb = record.exc_info
            name = etype.__name__ if etype else "Exception"
            record.exc_text = f"{name}: {redact(str(evalue))}"
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = redact(record.exc_text)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        return True


def install(level: int = logging.WARNING) -> None:
    """Installs the filter on the root logger and on every existing handler."""
    root = logging.getLogger()
    if not any(isinstance(f, RedactingFilter) for f in root.filters):
        root.addFilter(RedactingFilter())
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)
    for handler in root.handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())
    root.setLevel(level)


def format_exception_redacted(exc: BaseException) -> str:
    """Type and redacted message only; never the traceback's local values."""
    return f"{type(exc).__name__}: {redact(str(exc))}"


def install_public_excepthook(stream=None) -> None:
    """For public logs (the executor.yml job): an uncaught exception prints its type and redacted message only, never
    a traceback (tracebacks can quote source lines and argument values); Python warnings go through the redacting
    logger."""
    import sys
    import threading

    def write(exc: BaseException) -> None:
        (stream or sys.stderr).write(f"error: {format_exception_redacted(exc)}\n")

    sys.excepthook = lambda _t, exc, _tb: write(exc)
    threading.excepthook = lambda a: write(a.exc_value) if a.exc_value is not None else None
    logging.captureWarnings(True)


__all__ = ["REDACTED", "RedactingFilter", "format_exception_redacted", "install", "install_public_excepthook", "redact", "register_names"]
