// Request-level idempotency (SPEC.md sections 18.5 and 30.3.4): Workers Free keeps finished instances only 3 days, so a
// re-sent message can start a second instance for a request another instance already handled. An instance for a
// terminal request, a held one, or a request that names another instance ends in load-request and changes no row.
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject } from "../fixtures/seed.ts";

const TABLES = ["deletion_requests", "deletion_asset_results", "suppression_list", "residuals", "executor_tasks", "audit_events", "identity_map", "principals", "legal_holds"];

async function snapshot(): Promise<string> {
  const parts: string[] = [];
  for (const t of TABLES) parts.push(JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results));
  for (const b of [env.EXPORTS, env.DERIVED]) {
    for (const o of (await b.list({ limit: 1000 })).objects) parts.push(`${o.key}:${o.etag}`);
  }
  parts.push(JSON.stringify((await env.CACHE.list()).keys.map((k) => k.name)));
  return parts.join("\n");
}

async function runInstance(instanceId: string, requestId: string): Promise<unknown> {
  await using instance = await introspectWorkflowInstance(env.DELETION, instanceId);
  await instance.modify(async (m) => {
    await m.disableSleeps();
    await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
    await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
  });
  await env.DELETION.create({ id: instanceId, params: { requestId } });
  await instance.waitForStatus("complete");
  return instance.getOutput();
}

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
});

describe("request-level idempotency", () => {
  it("a second instance for a completed request changes no row", async () => {
    const ident = await identityOf(subject("hrbp-02", "in_unit", 7).employee_ref);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES ('rq-once', 'retention', ?, ?, 'received', 'retention-sweep', ?)")
      .bind(ident.subject_ref, ident.employee_id, new Date().toISOString())
      .run();
    const first = (await runInstance("rq-once", "rq-once")) as { status: string };
    expect(first.status).toMatch(/^completed/);
    // the retention request had no instance id: the first instance claimed it
    expect(await env.DB.prepare("SELECT workflow_instance_id FROM deletion_requests WHERE id = 'rq-once'").first()).toEqual({ workflow_instance_id: "rq-once" });
    const before = await snapshot();
    // the same request through another instance id (a re-sent message after the first instance was purged)
    expect(await runInstance("rq-once-dup", "rq-once")).toEqual({ status: "skipped", reason: "terminal", steps: 1 });
    expect(await snapshot()).toBe(before);
  });

  it("an instance for a request that names another instance changes no row", async () => {
    const ident = await identityOf(subject("hrbp-02", "in_unit", 8).employee_ref);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at, workflow_instance_id) VALUES ('rq-owned', 'dsr', ?, ?, 'received', 'privacy-01', ?, 'rq-owned-r1')")
      .bind(ident.subject_ref, ident.employee_id, new Date().toISOString())
      .run();
    const before = await snapshot();
    expect(await runInstance("rq-owned", "rq-owned")).toEqual({ status: "skipped", reason: "other_instance", steps: 1 });
    expect(await snapshot()).toBe(before);
  });

  it("an instance for a held or running request changes no row", async () => {
    for (const status of ["held", "running"] as const) {
      const ident = await identityOf(subject("hrbp-02", "in_unit", status === "held" ? 9 : 10).employee_ref);
      const id = `rq-${status}`;
      await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at, workflow_instance_id) VALUES (?, 'dsr', ?, ?, ?, 'privacy-01', ?, ?)")
        .bind(id, ident.subject_ref, ident.employee_id, status, new Date().toISOString(), id)
        .run();
      const before = await snapshot();
      expect(await runInstance(`${id}-x`, id)).toMatchObject({ status: "skipped", reason: status === "held" ? "held" : "running" });
      expect(await snapshot()).toBe(before);
    }
  });
});
