import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createTaskStore, ExecutorResult } from "../../src/worker/executor/task-store.ts";
import { call, seedWorld, worldApp } from "../fixtures/seed.ts";

beforeAll(seedWorld);

const task = (id: string, phase: "erase" | "identity" | "retention" = "erase") => ({
  id,
  phase,
  eventType: `executor_result_${phase}`,
  workflow: "DELETION" as const,
  instanceId: `inst-${id}`,
  requestId: `req-${id}`,
  payload: { note: "payload" },
});

describe("executor task protocol", () => {
  it("leases are exclusive and expired leases are reclaimed", async () => {
    const store = createTaskStore(env.DB);
    await store.create(task("t1"));
    await store.create(task("t2"));
    await store.create(task("t1")); // INSERT OR IGNORE
    const now = new Date("2026-10-10T10:00:00Z");
    const a = await store.claim("exec-a", ["erase"], 25, 60, now);
    expect(a.map((x) => x.id)).toEqual(["t1", "t2"]);
    expect(await store.claim("exec-b", ["erase"], 25, 60, new Date(now.getTime() + 30_000))).toEqual([]);
    const b = await store.claim("exec-b", ["erase"], 1, 60, new Date(now.getTime() + 61_000));
    expect(b).toHaveLength(1);
    expect(await store.claim("exec-b", ["identity"], 25, 60, new Date(now.getTime() + 61_000))).toEqual([]);
  });

  it("only the lease owner can complete", async () => {
    const store = createTaskStore(env.DB);
    await store.create(task("t3"));
    await store.claim("exec-a", ["erase"], 25, 600);
    const empty = ExecutorResult.parse({});
    await expect(store.complete("t3", "exec-b", true, empty)).rejects.toMatchObject({ code: "not_lease_owner" });
    await expect(store.complete("missing", "exec-a", true, empty)).rejects.toMatchObject({ code: "not_found" });
    const done = await store.complete("t3", "exec-a", true, empty);
    expect(done.id).toBe("t3");
    await expect(store.complete("t3", "exec-a", true, empty)).rejects.toMatchObject({ code: "not_leased" });
    expect(await store.purgePayloads("req-t3")).toBe(1);
    expect((await store.get("t3"))!.payload).toBeNull();
  });

  it("the result schema rejects identifier-like strings", () => {
    const ok = { assets: [{ asset_id: "wh.core", applicability: "present", rows_before: 3, rows_erased: 3, references_scrubbed: 1, action_status: "erased", verify_status: "clean", verify_matches: 0, parts: { "pv_core.dim_employee": { rows_before: 1, rows_erased: 1, refs_scrubbed: 0 } } }], findings: [{ store: "warehouse", location: "pv_core.tmp_backup_1", asset_id: null, matches: 2 }] };
    expect(ExecutorResult.safeParse(ok).success).toBe(true);
    for (const bad of [
      { findings: [{ store: "warehouse", location: "ada.novak@peoplevault.test", asset_id: null, matches: 1 }] },
      { findings: [{ store: "warehouse", location: "pv_core.E10004", asset_id: null, matches: 1 }] },
      { findings: [{ store: "warehouse", location: "Ada Novak", asset_id: null, matches: 1 }] },
      { counts: { er_aaaaaaaaaaaaaaaaaaaaaaaaaa: 1 } },
      { assets: [{ asset_id: "wh.core", extra: "x" }] },
      { unknown_field: 1 },
    ]) {
      expect(ExecutorResult.safeParse(bad).success).toBe(false);
    }
  });

  it("routes are for the executor principal only, and completion validates the result", async () => {
    const { app } = worldApp();
    expect((await call(app, "privacy-01", "POST", "/api/v1/executor/tasks/claim", { phases: ["erase"] })).status).toBe(403);
    await createTaskStore(env.DB).create(task("t4", "identity"));
    const claim = await call(app, "pv-executor-local", "POST", "/api/v1/executor/tasks/claim", { phases: ["identity"] });
    const { tasks } = (await claim.json()) as { tasks: { id: string; payload: unknown }[] };
    expect(tasks.map((x) => x.id)).toEqual(["t4"]);
    const bad = await call(app, "pv-executor-local", "POST", "/api/v1/executor/tasks/t4/complete", { ok: true, result: { findings: [{ store: "warehouse", location: "x@y.test", asset_id: null, matches: 1 }] } });
    expect(bad.status).toBe(400);
    const sup = await call(app, "pv-executor-local", "GET", "/api/v1/executor/suppression");
    expect(((await sup.json()) as { subjectRefs: string[] }).subjectRefs).toHaveLength(3);
  });
});

describe("completion delivers the event to the waiting instance", () => {
  it("claim and complete through the API resume the deletion workflow to completion", async () => {
    const { introspectWorkflowInstance } = await import("cloudflare:test");
    const { executorEraseResult, executorIdentityResult, identityOf, seedObjects, subject } = await import("../fixtures/seed.ts");
    await seedObjects();
    const { app } = worldApp();
    const target = await identityOf(subject("hrbp-02", "in_unit", 4).employee_ref);
    const res = await call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: target.employee_ref, reason: "data subject request" });
    const { requestId } = (await res.json()) as { requestId: string };
    await using instance = await introspectWorkflowInstance(env.DELETION, requestId);
    await instance.modify(async (m) => m.disableSleeps());
    for (const [phase, payload] of [["erase", executorEraseResult()], ["identity", executorIdentityResult()]] as const) {
      let tasks: { id: string }[] = [];
      for (let i = 0; i < 100 && tasks.length === 0; i++) {
        tasks = ((await (await call(app, "pv-executor-local", "POST", "/api/v1/executor/tasks/claim", { phases: [phase] })).json()) as { tasks: { id: string }[] }).tasks;
        if (tasks.length === 0) await new Promise((r) => setTimeout(r, 20));
      }
      expect(tasks.map((t) => t.id)).toEqual([`${requestId}:${phase}`]);
      const done = await call(app, "pv-executor-local", "POST", `/api/v1/executor/tasks/${tasks[0]!.id}/complete`, { ok: payload.ok, result: payload.result });
      expect(done.status).toBe(200);
    }
    await instance.waitForStatus("complete");
    const r = await env.DB.prepare("SELECT status FROM deletion_requests WHERE id = ?").bind(requestId).first<{ status: string }>();
    expect(r!.status).toBe("completed_with_residuals");
  });
});
