"""HTTP client for the Worker executor API (SPEC.md sections 13 and 14.2)."""

from __future__ import annotations

from dataclasses import dataclass

import httpx


@dataclass
class Task:
    id: str
    phase: str
    event_type: str
    workflow: str
    instance_id: str
    request_id: str | None
    run_id: str | None
    payload: dict | None


class WorkerApi:
    def __init__(self, base_url: str, auth, timeout: float = 30.0, transport: httpx.BaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self.auth = auth
        self.client = httpx.Client(timeout=timeout, transport=transport)

    def _headers(self) -> dict[str, str]:
        return {**self.auth.headers(), "X-PV-Requested-With": "peoplevault", "content-type": "application/json"}

    def claim(self, phases: list[str], max_tasks: int = 25, lease_seconds: int = 600) -> list[Task]:
        r = self.client.post(f"{self.base_url}/api/v1/executor/tasks/claim", headers=self._headers(), json={"phases": phases, "max": max_tasks, "lease_seconds": lease_seconds})
        r.raise_for_status()
        return [
            Task(t["id"], t["phase"], t["eventType"], t["workflow"], t["instanceId"], t.get("requestId"), t.get("runId"), t.get("payload"))
            for t in r.json()["tasks"]
        ]

    def complete(self, task_id: str, ok: bool, result: dict) -> None:
        r = self.client.post(f"{self.base_url}/api/v1/executor/tasks/{task_id}/complete", headers=self._headers(), json={"ok": ok, "result": result})
        r.raise_for_status()

    def suppression(self) -> set[str]:
        r = self.client.get(f"{self.base_url}/api/v1/executor/suppression", headers=self._headers())
        r.raise_for_status()
        return set(r.json()["subjectRefs"])

    def pending_residuals(self) -> list[dict]:
        r = self.client.get(f"{self.base_url}/api/v1/executor/residuals", headers=self._headers(), params={"state": "pending"})
        r.raise_for_status()
        return r.json()["residuals"]

    def post_residuals(self, updates: list[dict]) -> int:
        if not updates:
            return 0
        r = self.client.post(f"{self.base_url}/api/v1/executor/residuals", headers=self._headers(), json=updates)
        r.raise_for_status()
        return r.json()["updated"]
