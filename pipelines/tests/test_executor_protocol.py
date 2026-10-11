"""Executor loop and results: completes every claimed task, fails closed with counts only, and never sends
identifiers back to the Worker."""

from executor_helpers import assert_identifier_free, task

from peoplevault.executor import loop


class FakeApi:
    def __init__(self, batches):
        self.batches = list(batches)
        self.completed = []

    def claim(self, phases, max_tasks=25, lease_seconds=600):
        return self.batches.pop(0) if self.batches else []

    def complete(self, task_id, ok, result):
        self.completed.append((task_id, ok, result))


def test_process_completes_every_task_and_groups_phases(monkeypatch):
    seen = []
    monkeypatch.setattr(loop, "handle_erase_batch", lambda tasks, ctx: (seen.append(("erase", len(tasks))), {t.id: (True, {"assets": [], "findings": [], "residuals": [], "counts": {}}) for t in tasks})[1])
    monkeypatch.setattr(loop, "handle_identity_batch", lambda tasks, ctx: (seen.append(("identity", len(tasks))), {t.id: (True, {"assets": [], "findings": [], "residuals": [], "counts": {}}) for t in tasks})[1])
    api = FakeApi([[task("E00002"), task("E00003"), task("E00004", "identity")]])
    assert loop.run_loop(api, ctx=None, drain=True) == 3
    assert seen == [("erase", 2), ("identity", 1)]  # one erase batch (one aggregate rebuild), then identity
    assert [c[1] for c in api.completed] == [True, True, True]


def test_a_failing_batch_reports_ok_false_with_the_error_type_only(monkeypatch):
    def boom(tasks, ctx):
        raise RuntimeError("could not reach E00002 at ada.abbott@peoplevault.test")

    monkeypatch.setattr(loop, "handle_erase_batch", boom)
    api = FakeApi([[task("E00002")]])
    loop.run_loop(api, ctx=None, once=True)
    (tid, ok, result), = api.completed
    assert ok is False and result["error"] == "RuntimeError"
    assert_identifier_free(result)
