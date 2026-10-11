"""Executor loop: claim up to 25 tasks, process them in phase batches, complete each task (SPEC.md section 14.2).
Locally it runs as a thread of `pv serve` (sharing the DuckDB connection) or as `pv executor run --once|--drain`."""

from __future__ import annotations

import logging
import threading

from peoplevault.executor.handlers import ExecContext, failure_result, handle_erase_batch, handle_identity_batch

log = logging.getLogger("peoplevault.executor")
PHASES = ["erase", "identity", "retention"]


def process(api, ctx: ExecContext, tasks) -> int:
    by_phase: dict[str, list] = {}
    for t in tasks:
        by_phase.setdefault(t.phase, []).append(t)
    done = 0
    for phase in ("erase", "identity", "retention"):
        batch = by_phase.get(phase, [])
        if not batch:
            continue
        try:
            if phase == "erase":
                results = handle_erase_batch(batch, ctx)
            elif phase == "identity":
                results = handle_identity_batch(batch, ctx)
            else:
                from peoplevault.executor.retention import handle_retention

                results = {t.id: handle_retention(t, ctx) for t in batch}
        except Exception as exc:  # noqa: BLE001  (fail closed: every task of the batch reports ok: false)
            fr = failure_result(exc)
            results = {t.id: (False, fr) for t in batch}
        for t in batch:
            ok, result = results[t.id]
            try:
                api.complete(t.id, ok, result)
            except Exception as exc:  # noqa: BLE001  (a rejected result still completes the task as failed)
                log.warning("complete rejected for a task: %s", type(exc).__name__)
                api.complete(t.id, False, failure_result(exc))
            done += 1
    return done


def run_loop(api, ctx: ExecContext, stop: threading.Event | None = None, *, poll: float = 0.5, once: bool = False, drain: bool = False, lease_seconds: int = 600) -> int:
    total = 0
    stop = stop or threading.Event()
    while not stop.is_set():
        try:
            tasks = api.claim(PHASES, 25, lease_seconds)
        except Exception as exc:  # noqa: BLE001  (the Worker may not be up yet)
            log.warning("claim failed: %s", type(exc).__name__)
            tasks = []
            if once or drain:
                raise
        if tasks:
            total += process(api, ctx, tasks)
            if once:
                return total
            continue
        if once or drain:
            return total
        stop.wait(poll)
    return total


def start_thread(api, ctx: ExecContext, stop: threading.Event) -> threading.Thread:
    t = threading.Thread(target=run_loop, args=(api, ctx, stop), name="pv-executor", daemon=True)
    t.start()
    return t


__all__ = ["process", "run_loop", "start_thread"]
