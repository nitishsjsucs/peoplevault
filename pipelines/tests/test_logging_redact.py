import logging

from peoplevault.logging_redact import REDACTED, RedactingFilter, redact, register_names


def _record(msg, *args, exc_info=None):
    return logging.LogRecord("t", logging.WARNING, __file__, 1, msg, args, exc_info)


def test_redacts_ids_emails_pseudonyms():
    text = "subject E00042 mail ann.li@peoplevault.test ref er_abcdefghijklmnopqrstuvwxyz and sr_" + "a" * 26
    out = redact(text)
    assert "E00042" not in out and "ann.li@" not in out and "er_abc" not in out and "sr_aaa" not in out
    assert out.count(REDACTED) == 4


def test_redacts_registered_names_and_format_args():
    register_names(["Zelda Quorum"])
    rec = _record("deleting %s (%s)", "Zelda Quorum", "E01200")
    RedactingFilter().filter(rec)
    assert rec.getMessage() == f"deleting {REDACTED} ({REDACTED})"


def test_redacts_exception_text():
    try:
        raise ValueError("bad row for E00007 / x@example.test")
    except ValueError:
        import sys

        rec = _record("failed", exc_info=sys.exc_info())
    RedactingFilter().filter(rec)
    assert rec.exc_info is None
    assert rec.exc_text == f"ValueError: bad row for {REDACTED} / {REDACTED}"


def test_logger_output_is_redacted(caplog):
    caplog.set_level(logging.WARNING)
    logging.getLogger("pv.test").addFilter(RedactingFilter())
    logging.getLogger("pv.test").warning("id %s", "E00001")
    assert "E00001" not in caplog.text
