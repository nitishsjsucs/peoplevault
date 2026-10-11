from __future__ import annotations

import pytest

from peoplevault import logging_redact


@pytest.fixture(autouse=True)
def _redacting_logger():
    logging_redact.install()
    yield
