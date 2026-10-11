"""Helpers for executor tests: tasks built from the synthetic population with the test master key."""

from __future__ import annotations

import re

from synth_helpers import population

from peoplevault.executor.api import Task
from peoplevault.pseudo import TEST_MASTER_KEY, Pseudonymizer

PS = Pseudonymizer(TEST_MASTER_KEY)
IDENTIFIER_LIKE = [re.compile(r"@"), re.compile(r"\s"), re.compile(r"\bE\d{5}\b", re.I), re.compile(r"(wk|er|an|sr)_[a-z2-7]{26}")]


def subject_payload(employee_id: str) -> dict:
    e = population().final(employee_id)
    refs = PS.all(employee_id)
    return {
        "employeeId": employee_id, "workEmail": e.work_email, "fullName": e.full_name, "employeeRef": refs["employee_ref"],
        "warehouseKey": refs["warehouse_key"], "analyticsId": refs["analytics_id"], "subjectRef": refs["subject_ref"], "managerOf": [],
    }


def task(employee_id: str, phase: str = "erase", held_refs: list[str] | None = None) -> Task:
    return Task(
        id=f"req-{employee_id}:{phase}", phase=phase, event_type=f"executor_result_{phase}", workflow="DELETION",
        instance_id=f"req-{employee_id}", request_id=f"req-{employee_id}", run_id=None,
        payload={"requestId": f"req-{employee_id}", "subject": subject_payload(employee_id), "assets": [], "heldSubjectRefs": held_refs or []},
    )


def strings_in(obj) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [s for k, v in obj.items() for s in strings_in(k) + strings_in(v)]
    if isinstance(obj, list):
        return [s for v in obj for s in strings_in(v)]
    return []


def assert_identifier_free(result: dict) -> None:
    for s in strings_in(result):
        for pat in IDENTIFIER_LIKE:
            assert not pat.search(s), f"identifier-like value in executor result: {pat.pattern}"
