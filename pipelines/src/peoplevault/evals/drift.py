"""Schema-drift triage eval (SPEC.md sections 16.3 and 30.3.6): `pv eval drift --target local|prod`.

Sends each of the 120 labeled columns (peoplevault.drift.columns) to POST /api/v1/privacy/schema-drift/classify as the
privacy officer and scores the answers. Resumable: every answered column is appended to a checkpoint
(evals/results/.checkpoints/drift-<target>-<model>.jsonl, gitignored). Before each call the run stops if today's
neurons plus one call's worst case could pass the Worker's daily cap (AI_DAILY_NEURONS, 2,000 in production), and also
when the Worker itself answers `budget_exhausted`; run it again on the next UTC day and it continues from the
checkpoint. Only a complete run writes evals/results/drift-<target>-<date>.json, whose header names the model,
`neurons_total`, `days` and `calls`.

Which model produces which number: production `sensitive_recall` comes only from Workers AI
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the local number only from Qwen3-1.7B Q4_0 on llama-server (port 8170);
the deterministic stub produces no reported number.

Neurons are computed here from each answer's token usage at the dated rates of src/shared/ai-rates.json (the table the
Worker meters with), so the eval's total does not depend on the Worker's own bookkeeping.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from peoplevault import config
from peoplevault.drift.columns import CLASSES, SENSITIVE, LabeledColumn, columns
from peoplevault.evals.report import header

RESULTS_DIR = config.REPO_ROOT / "evals" / "results"
CHECKPOINT_DIR = RESULTS_DIR / ".checkpoints"
RATES_FILE = config.REPO_ROOT / "src" / "shared" / "ai-rates.json"
STUB_MODEL = "stub"
MAX_INPUT_TOKENS = 600
MAX_OUTPUT_TOKENS = 48


class DriftClient(Protocol):
    def usage(self) -> dict: ...

    def classify(self, column: str, samples: list[str]) -> dict: ...


class EvalStopped(RuntimeError):
    pass


def rates() -> dict:
    return json.loads(RATES_FILE.read_text())


def neurons(model: str, prompt_tokens: int, completion_tokens: int, table: dict | None = None) -> float:
    r = (table or rates())["models"][model]
    return (prompt_tokens * r["input"] + completion_tokens * r["output"]) / 1_000_000


def worst_case(model: str, table: dict | None = None) -> float:
    return neurons(model, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, table)


def utc_today() -> str:
    return datetime.now(UTC).date().isoformat()


def slug(model: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", model.lower()).strip("-")


def checkpoint_path(target: str, model: str) -> Path:
    return CHECKPOINT_DIR / f"drift-{target}-{slug(model)}.jsonl"


def load_checkpoint(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    for line in path.read_text().splitlines():
        if line.strip():
            rec = json.loads(line)
            out[rec["id"]] = rec
    return out


def score(records: Iterable[dict]) -> dict:
    """sensitive_recall: of the labeled sensitive columns, the share the model put in a sensitive class (an answer
    outside the schema counts as a miss). The same for the rule classes and for the suggestions max_severity(rule,
    model), plus exact class accuracy and the share of non-sensitive columns suggested as sensitive."""
    recs = list(records)
    sens = [r for r in recs if r["label"] in SENSITIVE]
    other = [r for r in recs if r["label"] not in SENSITIVE]

    def recall(field: str) -> float | None:
        return round(sum(1 for r in sens if r.get(field) in SENSITIVE) / len(sens), 4) if sens else None

    def opaque_recall(field: str) -> float | None:
        o = [r for r in sens if r["opaque"]]
        return round(sum(1 for r in o if r.get(field) in SENSITIVE) / len(o), 4) if o else None

    by_label = {
        c: {"columns": sum(1 for r in recs if r["label"] == c), "model_correct": sum(1 for r in recs if r["label"] == c and r.get("modelClass") == c)} for c in CLASSES
    }
    return {
        "columns": len(recs),
        "sensitive_columns": len(sens),
        "sensitive_recall": recall("modelClass"),
        "sensitive_recall_opaque_names": opaque_recall("modelClass"),
        "rule_sensitive_recall": recall("ruleClass"),
        "suggested_sensitive_recall": recall("suggestedClass"),
        "model_class_accuracy": round(sum(1 for r in recs if r.get("modelClass") == r["label"]) / len(recs), 4) if recs else None,
        "suggested_false_sensitive_rate": round(sum(1 for r in other if r.get("suggestedClass") in SENSITIVE) / len(other), 4) if other else None,
        "invalid_outputs": sum(1 for r in recs if r["status"] == "invalid_output"),
        "by_label": by_label,
        "model_confusion": dict(sorted(Counter(f"{r['label']}->{r.get('modelClass')}" for r in recs if r.get("modelClass") != r["label"]).items())),
    }


def run(
    client: DriftClient,
    target: str,
    *,
    today: Callable[[], str] = utc_today,
    cols: list[LabeledColumn] | None = None,
    write: bool = True,
    command: str = "",
) -> dict:
    """Runs (or resumes) the eval. Returns {complete, model, done, remaining, ...}; a complete run also has the scores
    and, unless the model is the stub, the path of the result file it wrote."""
    cols = cols if cols is not None else columns()
    table = rates()
    info = client.usage()
    model = info.get("model")
    if not model:
        raise EvalStopped("the Worker has no triage model (AI binding or AI_GATEWAY_ID missing)")
    if model not in table["models"]:
        raise EvalStopped(f"no dated rate for {model} in {RATES_FILE.name}")
    cap = info.get("cap")
    spent = float(info.get("neurons") or 0.0)
    ckpt = checkpoint_path(target, model)
    done = load_checkpoint(ckpt)
    ckpt.parent.mkdir(parents=True, exist_ok=True)
    stopped: str | None = None
    worst = worst_case(model, table)
    with ckpt.open("a") as out:
        for col in cols:
            if col.id in done:
                continue
            if cap is not None and spent + worst > cap:
                stopped = f"today's neurons ({spent:.2f}) plus one call's worst case ({worst:.2f}) would pass the daily cap of {cap}"
                break
            r = client.classify(col.name, list(col.samples))
            status = r["ai"]["status"]
            if status == "budget_exhausted":
                stopped = "the Worker refused the call: the daily neuron cap is reached"
                break
            if status in ("unavailable", "error"):
                raise EvalStopped(f"the model call failed ({status}); nothing was recorded for {col.id}, run again to retry")
            if r["model"] != model:
                raise EvalStopped(f"the Worker's model changed from {model} to {r['model']} during the run")
            usage = r["ai"].get("usage") or {}
            n = neurons(model, int(usage.get("promptTokens", 0)), int(usage.get("completionTokens", 0)), table)
            spent += n
            rec = {
                "id": col.id, "name": col.name, "label": col.label, "opaque": col.opaque, "ruleClass": r["ruleClass"], "modelClass": r["modelClass"],
                "suggestedClass": r["suggestedClass"], "status": status, "promptTokens": usage.get("promptTokens"), "completionTokens": usage.get("completionTokens"),
                "usageEstimated": bool(usage.get("estimated")), "neurons": round(n, 6), "day": today(),
            }
            out.write(json.dumps(rec) + "\n")
            out.flush()
            done[col.id] = rec
    remaining = [c.id for c in cols if c.id not in done]
    base = {"target": target, "model": model, "done": len(done), "remaining": len(remaining), "neurons_today": round(spent, 4), "cap": cap}
    if remaining:
        return {**base, "complete": False, "stopped": stopped or "not every column was answered", "resume": "run the same command again after 00:00 UTC; it continues from the checkpoint"}
    records = [done[c.id] for c in cols]
    environment = (
        f"production (Workers AI {model} through the AI Gateway)" if target == "prod" else f"local (Miniflare, {model} on port 8170)" if model != STUB_MODEL else "local (Miniflare, stub)"
    )
    result = {
        **header(command or f"uv run --project pipelines pv eval drift --target {target}", environment=environment),
        "kind": "drift",
        "target": target,
        "date": today(),
        "model": model,
        "neurons_total": round(sum(r["neurons"] for r in records), 4),
        "days": len({r["day"] for r in records}),
        "calls": len(records),
        "rates_checked": table["checked"],
        "daily_cap": cap,
        "scores": score(records),
    }
    if model == STUB_MODEL:
        return {**base, "complete": True, "reported": False, "note": "the deterministic stub produces no reported number", "result": result}
    written = None
    if write:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        written = RESULTS_DIR / f"drift-{target}-{result['date']}.json"
        written.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        ckpt.unlink(missing_ok=True)
    return {**base, "complete": True, "reported": True, "written": str(written) if written else None, "result": result}


class HttpDriftClient:
    """The classify and usage routes as the privacy officer, through any eval client (local dev JWT or Access)."""

    def __init__(self, client, principal: str = "privacy-01"):
        self.client = client
        self.principal = principal

    def _json(self, method: str, path: str, body: dict | None = None) -> dict:
        res = self.client.request(self.principal, method, path, body)
        if res.status_code != 200:
            raise EvalStopped(f"{method} {path} answered {res.status_code}: {res.text[:200]}")
        return res.json()

    def usage(self) -> dict:
        return self._json("GET", "/api/v1/privacy/schema-drift/usage")

    def classify(self, column: str, samples: list[str]) -> dict:
        return self._json("POST", "/api/v1/privacy/schema-drift/classify", {"column": column, "samples": samples})
