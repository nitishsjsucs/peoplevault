import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { nextInstanceId } from "../../src/worker/requests.ts";
import { call, seedWorld, subject, worldApp } from "../fixtures/seed.ts";

beforeAll(seedWorld);

describe("privacy routes", () => {
  it("a DSR creates a workflow instance named after the request; a second DSR for the subject is 409", async () => {
    await using introspector = await introspectWorkflow(env.DELETION);
    const { app } = worldApp();
    const s = subject("*", "active", 6);
    const res = await call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: s.employee_ref, reason: "data subject request" });
    expect(res.status).toBe(202);
    const { requestId } = (await res.json()) as { requestId: string };
    const instances = await introspector.get();
    expect(instances).toHaveLength(1);
    const row = await env.DB.prepare("SELECT workflow_instance_id, subject_ref, kind FROM deletion_requests WHERE id = ?").bind(requestId).first<{ workflow_instance_id: string; subject_ref: string; kind: string }>();
    expect(row).toEqual({ workflow_instance_id: requestId, subject_ref: s.subject_ref, kind: "dsr" });
    const again = await call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: s.employee_ref, reason: "data subject request" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("active_request_exists");
    const unknown = await call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: `er_${"q".repeat(26)}`, reason: "data subject request" });
    expect(unknown.status).toBe(404);
  });

  it("a retention run with a future as_of is refused and audited", async () => {
    const { app } = worldApp();
    const res = await call(app, "privacy-01", "POST", "/api/v1/privacy/retention/run", { as_of: "2099-12-31" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("as_of_in_future");
    const last = await env.DB.prepare("SELECT action, decision, reason FROM audit_events ORDER BY seq DESC LIMIT 1").first();
    expect(last).toEqual({ action: "run_retention", decision: "deny", reason: "as_of_in_future" });
  });

  it("retry instance naming", () => {
    expect(nextInstanceId("abc", "abc")).toBe("abc-r1");
    expect(nextInstanceId("abc", "abc-r1")).toBe("abc-r2");
    expect(nextInstanceId("abc", null)).toBe("abc-r1");
  });

  it("releasing the last hold resubmits held requests as <id>-r1", async () => {
    await using introspector = await introspectWorkflow(env.DELETION);
    const { app } = worldApp();
    const held = subject("*", "held", 0);
    await env.DB.prepare(
      "INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, workflow_instance_id, created_at) VALUES ('req-held-1', 'dsr', ?, 'E10008', 'held', 'privacy-01', 'req-held-1', '2026-10-01T00:00:00Z')",
    )
      .bind(held.subject_ref)
      .run();
    const second = await call(app, "privacy-01", "POST", "/api/v1/privacy/legal-holds", { matter_id: "LH-2026-009", employee_ref: held.employee_ref, reason: "second matter" });
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { hold: { id: string } }).hold.id;
    const r1 = await call(app, "privacy-01", "POST", "/api/v1/privacy/legal-holds/hold-w01/release");
    expect(((await r1.json()) as { resubmitted: string[]; remainingHolds: number })).toMatchObject({ resubmitted: [], remainingHolds: 1 });
    const r2 = await call(app, "privacy-01", "POST", `/api/v1/privacy/legal-holds/${secondId}/release`);
    expect(((await r2.json()) as { resubmitted: string[] }).resubmitted).toEqual(["req-held-1-r1"]);
    const row = await env.DB.prepare("SELECT status, workflow_instance_id FROM deletion_requests WHERE id = 'req-held-1'").first();
    expect(row).toEqual({ status: "received", workflow_instance_id: "req-held-1-r1" });
    expect((await introspector.get()).length).toBe(1);
    expect((await call(app, "privacy-01", "POST", "/api/v1/privacy/legal-holds/hold-w01/release")).status).toBe(404);
  });

  it("lists holds and requests without employee ids; verifies the audit chain", async () => {
    const { app } = worldApp();
    const holds = (await (await call(app, "privacy-01", "GET", "/api/v1/privacy/legal-holds")).json()) as { holds: Record<string, unknown>[] };
    expect(holds.holds.length).toBeGreaterThan(0);
    const reqs = await (await call(app, "privacy-01", "GET", "/api/v1/privacy/deletion-requests")).text();
    expect(reqs).not.toMatch(/\bE\d{5}\b/);
    const verify = (await (await call(app, "privacy-01", "GET", "/api/v1/privacy/audit/verify")).json()) as { ok: boolean };
    expect(verify.ok).toBe(true);
    const assets = (await (await call(app, "privacy-01", "GET", "/api/v1/privacy/assets")).json()) as { assets: unknown[] };
    expect(assets.assets).toHaveLength(13);
    expect((await call(app, "hrbp-01", "GET", "/api/v1/privacy/assets")).status).toBe(403);
  });
});
