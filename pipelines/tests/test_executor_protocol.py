"""Executor loop and results: completes every claimed task, fails closed with counts only, and never sends
identifiers back to the Worker."""

from dataclasses import replace

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


def test_a_task_whose_completion_fails_twice_does_not_stop_the_batch(monkeypatch):
    """The first completion of t1 fails (for example the event delivery after the commit) and so does the fallback:
    the loop logs the error type and still completes t2, and the executor thread keeps running."""
    monkeypatch.setattr(loop, "handle_erase_batch", lambda tasks, ctx: {t.id: (True, {"assets": [], "findings": [], "residuals": [], "counts": {}}) for t in tasks})

    class Flaky(FakeApi):
        def complete(self, task_id, ok, result):
            self.completed.append((task_id, ok))
            if task_id == "t1":
                raise RuntimeError("HTTP 500")

    t1, t2 = replace(task("E00002"), id="t1"), replace(task("E00003"), id="t2")
    api = Flaky([[t1, t2], []])
    assert loop.run_loop(api, ctx=None, drain=True) == 1
    assert api.completed == [("t1", True), ("t1", False), ("t2", True)]


def test_bigquery_concurrent_update_aborts_are_retried():
    from peoplevault.warehouse.bq import BqWarehouse

    class Job:
        def __init__(self, fail):
            self.fail = fail
            self.job_id = "j1"

        def result(self):
            if self.fail:
                raise RuntimeError("Transaction is aborted due to concurrent update against table peoplevault_core.dim_employee")
            return []

    class Child:
        def __init__(self, n, i):
            self.num_dml_affected_rows = n
            self.statement_type = "DELETE"
            self.created = i

    class Client:
        def __init__(self):
            self.calls = 0

        def query(self, sql, job_config=None, job_id_prefix=None):
            self.calls += 1
            self.sql = sql
            assert job_config.maximum_bytes_billed == 1 << 30 and job_id_prefix == "peoplevault_"
            return Job(fail=self.calls < 3)

        def list_jobs(self, parent_job=None):
            return [Child(4, 2), Child(1, 1)]

    client = Client()
    sleeps = []
    wh = BqWarehouse("pv-test", client=client, sleep=sleeps.append)
    counts = wh.execute_script([("delete from `peoplevault_core.dim_employee` where employee_key = @v", {"v": "wk_x"}), ("delete from `peoplevault_raw.hris_employees` where employee_id = $v", {"v": "x"})])
    assert counts == [1, 4] and client.calls == 3 and len(sleeps) == 2
    assert client.sql.startswith("BEGIN TRANSACTION;") and client.sql.rstrip().endswith("COMMIT TRANSACTION;")
    assert "@s0_v" in client.sql and "@s1_v" in client.sql


def test_bigquery_other_errors_are_not_retried():
    import pytest

    from peoplevault.warehouse.bq import BqWarehouse

    class Client:
        calls = 0

        def query(self, sql, job_config=None, job_id_prefix=None):
            Client.calls += 1
            raise RuntimeError("Access Denied: Table peoplevault_core.dim_employee")

    with pytest.raises(RuntimeError, match="Access Denied"):
        BqWarehouse("pv-test", client=Client(), sleep=lambda s: None).execute_script([("select 1", {})])
    assert Client.calls == 1
