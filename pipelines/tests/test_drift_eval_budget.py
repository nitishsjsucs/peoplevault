"""The drift eval's budget logic (SPEC.md sections 18 and 30.3.6): neurons from token usage at the dated rates of each
model, a stop before a call that could pass the daily cap, a resume from the checkpoint on the next UTC day, and a
result header naming the model, neurons_total and days. The stub never produces a reported number."""

import json

import pytest

from peoplevault.drift.columns import columns
from peoplevault.evals import drift

PROD = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"


class FakeWorker:
    """The usage and classify routes with the Worker's meter: reserve the worst case, settle to the usage."""

    def __init__(self, model: str, cap: float | None, answer: str = "health_leave", usage=(300, 8)):
        self.model, self.cap, self.answer, self.usage_tokens = model, cap, answer, usage
        self.day = "2026-10-11"
        self.spent: dict[str, float] = {}
        self.calls = 0

    def usage(self) -> dict:
        return {"day": self.day, "neurons": self.spent.get(self.day, 0.0), "calls": self.calls, "cap": self.cap, "model": self.model}

    def classify(self, column: str, samples: list[str]) -> dict:
        worst = drift.worst_case(self.model)
        spent = self.spent.get(self.day, 0.0)
        if self.cap is not None and spent + worst > self.cap:
            return {"model": self.model, "ruleClass": None, "modelClass": None, "suggestedClass": None, "ai": {"status": "budget_exhausted", "neurons": 0, "usage": None}}
        self.calls += 1
        p, c = self.usage_tokens
        self.spent[self.day] = spent + drift.neurons(self.model, p, c)
        return {"model": self.model, "ruleClass": None, "modelClass": self.answer, "suggestedClass": self.answer,
                "ai": {"status": "ok", "neurons": drift.neurons(self.model, p, c), "usage": {"promptTokens": p, "completionTokens": c, "estimated": False}}}


@pytest.fixture(autouse=True)
def isolated_results(tmp_path, monkeypatch):
    monkeypatch.setattr(drift, "RESULTS_DIR", tmp_path / "results")
    monkeypatch.setattr(drift, "CHECKPOINT_DIR", tmp_path / "results" / ".checkpoints")


def test_neurons_at_the_dated_rates():
    table = drift.rates()
    assert table["checked"] == "2026-10-10"
    assert drift.neurons(PROD, 1_000_000, 0) == 26668
    assert drift.neurons(PROD, 0, 1_000_000) == 204805
    assert round(drift.worst_case(PROD), 2) == 25.83
    assert drift.worst_case("llama-server/Qwen3-1.7B-Q4_0") == 0
    # 120 calls at the worst case need 3,100 neurons (SPEC.md section 30.3.6 says 3,098): more than one day's 2,000
    assert round(120 * drift.worst_case(PROD)) == 3100


def test_stops_before_a_call_that_could_pass_the_cap_and_resumes_the_next_day():
    w = FakeWorker(PROD, cap=2000, usage=(600, 48))  # every call costs the worst case
    days = iter(["2026-10-11"] * 200)
    first = drift.run(w, "prod", today=lambda: next(days))
    assert first["complete"] is False
    assert first["done"] == 77 and first["remaining"] == 43  # 77 x 25.83 = 1,989 <= 2,000 < 78 x 25.83
    assert "would pass the daily cap" in first["stopped"]
    assert w.calls == 77 and w.spent["2026-10-11"] <= 2000
    ckpt = drift.checkpoint_path("prod", PROD)
    assert len(ckpt.read_text().splitlines()) == 77

    w.day = "2026-10-12"
    second = drift.run(w, "prod", today=lambda: "2026-10-12")
    assert second["complete"] is True and w.calls == 120
    header = second["result"]
    assert header["model"] == PROD and header["calls"] == 120 and header["days"] == 2
    assert header["neurons_total"] == round(120 * drift.worst_case(PROD), 4)
    written = json.loads(open(second["written"]).read())
    assert written["model"] == PROD and written["days"] == 2 and written["neurons_total"] == header["neurons_total"]
    assert written["scores"]["sensitive_recall"] == 1.0  # the fake answers health_leave everywhere
    assert not ckpt.exists()


def test_the_workers_refusal_also_stops_the_run():
    w = FakeWorker(PROD, cap=None)
    w.cap = 100  # the eval does not know the cap (usage reports None) but the Worker enforces it
    w.usage = lambda: {"day": w.day, "neurons": 0.0, "calls": 0, "cap": None, "model": PROD}  # type: ignore[method-assign]
    out = drift.run(w, "prod", today=lambda: "2026-10-11")
    assert out["complete"] is False and out["stopped"].startswith("the Worker refused")
    assert out["done"] == len(drift.load_checkpoint(drift.checkpoint_path("prod", PROD)))


def test_scores_count_invalid_answers_as_misses_and_separate_rules_from_the_model():
    cols = columns()
    recs = [{"id": c.id, "label": c.label, "opaque": c.opaque, "ruleClass": None, "modelClass": None if i == 0 else c.label,
             "suggestedClass": c.label, "status": "invalid_output" if i == 0 else "ok"} for i, c in enumerate(cols)]
    s = drift.score(recs)
    assert s["columns"] == 120 and s["sensitive_columns"] == 84
    assert s["sensitive_recall"] == round(83 / 84, 4)
    assert s["rule_sensitive_recall"] == 0.0 and s["suggested_sensitive_recall"] == 1.0
    assert s["invalid_outputs"] == 1 and s["suggested_false_sensitive_rate"] == 0.0


def test_the_stub_produces_no_reported_number():
    out = drift.run(FakeWorker("stub", cap=None, answer="direct_identifier"), "local", today=lambda: "2026-10-11")
    assert out["complete"] is True and out["reported"] is False and "written" not in out
    assert not drift.RESULTS_DIR.exists() or not list(drift.RESULTS_DIR.glob("drift-*.json"))


def test_a_failed_call_records_nothing_and_a_model_change_stops_the_run():
    class Failing(FakeWorker):
        def classify(self, column, samples):
            return {"model": self.model, "ruleClass": None, "modelClass": None, "suggestedClass": None, "ai": {"status": "unavailable", "neurons": 0, "usage": None}}

    with pytest.raises(drift.EvalStopped, match="nothing was recorded"):
        drift.run(Failing("llama-server/Qwen3-1.7B-Q4_0", cap=None), "local")
    assert drift.load_checkpoint(drift.checkpoint_path("local", "llama-server/Qwen3-1.7B-Q4_0")) == {}

    class Switching(FakeWorker):
        def classify(self, column, samples):
            r = super().classify(column, samples)
            return {**r, "model": "@cf/meta/llama-3.1-8b-instruct-fp8"}

    with pytest.raises(drift.EvalStopped, match="model changed"):
        drift.run(Switching(PROD, cap=None), "prod")
