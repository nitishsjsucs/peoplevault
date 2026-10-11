"""Modeled recovery windows (SPEC.md sections 14.4 and 15.6). Locally DuckDB has no time travel, so BigQuery windows
are modeled from the dataset setting and labeled modeled; fail-safe is never observable; D1 Time Travel is modeled."""

from __future__ import annotations

from datetime import datetime, timedelta

from peoplevault.policy.model import policy

D1_TIME_TRAVEL_DAYS = 30


def time_travel_end(deleted_at: datetime) -> datetime:
    return deleted_at + timedelta(hours=policy().datasets.max_time_travel_hours)


def fail_safe_end(deleted_at: datetime) -> datetime:
    return time_travel_end(deleted_at) + timedelta(days=policy().datasets.fail_safe_days)


def d1_time_travel_end(identity_deleted_at: datetime) -> datetime:
    return identity_deleted_at + timedelta(days=D1_TIME_TRAVEL_DAYS)


MODELED_LABEL = "DuckDB has no time travel; modeled from the BigQuery dataset setting (max_time_travel_hours = 48, fail-safe 7 days)"
