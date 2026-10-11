import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const now = "2026-10-01T00:00:00Z";
const insertRequest = (id: string, subjectRef: string, status: string) =>
  env.DB.prepare(
    "INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES (?, 'dsr', ?, NULL, ?, 'privacy-01', ?)",
  )
    .bind(id, subjectRef, status, now)
    .run();

describe("D1 control-plane schema", () => {
  it("creates every table from migrations 0001 to 0004", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of [
      "principals",
      "identity_map",
      "deletion_requests",
      "deletion_asset_results",
      "legal_holds",
      "suppression_list",
      "residuals",
      "retention_runs",
      "executor_tasks",
      "audit_events",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("migration 0005 adds deletion_requests.admitted_at with an index (Workers Free daily admission)", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(deletion_requests)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).toContain("admitted_at");
    const idx = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'deletion_requests_admitted'").first();
    expect(idx).toEqual({ name: "deletion_requests_admitted" });
  });

  it("migration 0006 adds the Workers AI neuron meter ai_usage (day, model, neurons, calls)", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(ai_usage)").all<{ name: string; pk: number }>()).results;
    expect(cols.map((c) => c.name)).toEqual(["day", "model", "neurons", "calls"]);
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["day", "model"]);
  });

  it("allows only one active request per subject (unique partial index)", async () => {
    await insertRequest("r1", "sr_subject_one", "running");
    await expect(insertRequest("r2", "sr_subject_one", "received")).rejects.toThrow(/UNIQUE/);
    await expect(insertRequest("r3", "sr_subject_one", "held")).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare("UPDATE deletion_requests SET status = 'completed' WHERE id = 'r1'").run();
    await insertRequest("r4", "sr_subject_one", "received");
    await insertRequest("r5", "sr_subject_two", "running");
    const { results } = await env.DB.prepare("SELECT id FROM deletion_requests ORDER BY id").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["r1", "r4", "r5"]);
  });

  it("enforces principal kind constraints", async () => {
    const ins = (id: string, kind: string, persona: string | null, role: string | null, email: string | null, client: string | null) =>
      env.DB.prepare(
        "INSERT INTO principals (id, kind, persona, system_role, email, service_client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, kind, persona, role, email, client, now)
        .run();
    await ins("mgr-900", "human", "manager", null, "a@peoplevault.test", null);
    await ins("svc-1", "system", null, "executor", null, "svc-1");
    await expect(ins("bad-1", "human", null, null, "b@peoplevault.test", null)).rejects.toThrow(/CHECK/);
    await expect(ins("bad-2", "system", "manager", "executor", null, "x")).rejects.toThrow(/CHECK/);
    await expect(ins("bad-3", "human", "manager", null, null, null)).rejects.toThrow(/CHECK/);
    await expect(ins("bad-4", "human", "auditor", null, "c@peoplevault.test", null)).rejects.toThrow(/CHECK/);
  });

  it("constrains enums on results, residuals and tasks", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO residuals (id, asset_id, kind, state, evidence) VALUES ('x', 'wh.core', 'bq_time_travel', 'maybe', 'modeled')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        "INSERT INTO executor_tasks (id, workflow, instance_id, phase, event_type, status, created_at, updated_at) VALUES ('t', 'DELETION', 'i', 'other', 'e', 'pending', ?, ?)",
      )
        .bind(now, now)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
