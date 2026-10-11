"""Pure helpers of the real Google Cloud client: recognizing a disabled API and waiting for an enabled one to answer."""

import pytest

from peoplevault.setup.gcp_client import answers, is_service_disabled, wait_for


class Http403(Exception):
    def __init__(self, text: str):
        super().__init__("403 Client Error: Forbidden for url: https://iam.googleapis.com/v1/projects/p/serviceAccounts")
        self.response = type("R", (), {"text": text})()


def test_service_disabled_is_recognized_for_rest_and_grpc_errors():
    assert is_service_disabled(Http403('{"error": {"status": "PERMISSION_DENIED", "details": [{"reason": "SERVICE_DISABLED"}]}}'))
    assert is_service_disabled(PermissionError("403 Google Cloud Data Catalog API has not been used in project p before or it is disabled."))
    assert not is_service_disabled(Http403('{"error": {"status": "PERMISSION_DENIED", "details": [{"reason": "IAM_PERMISSION_DENIED"}]}}'))


def test_answers_is_false_while_disabled_and_raises_other_errors():
    def disabled():
        raise Http403("SERVICE_DISABLED")

    def denied():
        raise Http403("IAM_PERMISSION_DENIED")

    assert answers(lambda: {"accounts": []}) is True
    assert answers(disabled) is False
    with pytest.raises(Http403):
        answers(denied)


def test_wait_for_polls_until_ready_and_times_out():
    t = {"now": 0.0}
    sleeps: list[float] = []

    def sleep(s: float) -> None:
        sleeps.append(s)
        t["now"] += s

    seen = iter([False, False, True])
    wait_for(lambda: next(seen), "x", timeout_s=60, interval_s=10, sleep=sleep, clock=lambda: t["now"])
    assert sleeps == [10, 10]
    with pytest.raises(TimeoutError, match="timed out waiting for the API"):
        wait_for(lambda: False, "the API", timeout_s=30, interval_s=10, sleep=sleep, clock=lambda: t["now"])
