// GET /api/v1/executor/audit-export (SPEC.md sections 18.5 and 30.3.3): executor principal only; rows after the cursor
// in seq order with exactly the 16 fields of infra/lake/audit-events.schema.json, never detail_json; pages of at most
// 500; one audit event per page; health reports the pulled copy.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import schema from "../../infra/lake/audit-events.schema.json";
import { createAuditLog } from "../../src/worker/audit/audit-log.ts";
import { BASE, call, seedWorld, worldApp } from "../fixtures/seed.ts";

const FIELDS = (schema as { fields: { name: string }[] }).fields.map((f) => f.name);

beforeAll(async () => {
  await seedWorld();
  const log = createAuditLog(env.DB);
  for (let i = 0; i < 620; i++) await log.append({ actor: "t", actorKind: "system", action: "export_test", decision: "info", reason: `r${i}`, rowCount: i, detail: { secret_counts: i } });
});

describe("audit export route", () => {
  it("is executor-only", async () => {
    const { app } = worldApp();
    for (const p of ["privacy-01", "hrbp-01", "analyst-01"]) {
      const res = await call(app, p, "GET", "/api/v1/executor/audit-export?after_seq=0&limit=10");
      expect(res.status, p).toBe(403);
    }
  });

  it("pages rows after the cursor in seq order with exactly the 16 schema fields, at most 500 per page", async () => {
    const { app } = worldApp();
    const head = (await env.DB.prepare("SELECT MAX(seq) AS m FROM audit_events").first<{ m: number }>())!.m;
    const first = (await (await call(app, "pv-executor-local", "GET", "/api/v1/executor/audit-export?after_seq=0")).json()) as {
      rows: Record<string, unknown>[];
      headSeq: number;
      nextAfterSeq: number;
      complete: boolean;
    };
    expect(first.rows).toHaveLength(500);
    expect(first.complete).toBe(false);
    expect(first.headSeq).toBeGreaterThanOrEqual(head);
    for (const r of first.rows) expect(Object.keys(r)).toEqual(FIELDS);
    expect(JSON.stringify(first.rows)).not.toContain("detail_json");
    expect(JSON.stringify(first.rows)).not.toContain("secret_counts");
    const seqs = first.rows.map((r) => r.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(first.nextAfterSeq).toBe(seqs[seqs.length - 1]);
    const second = (await (await call(app, "pv-executor-local", "GET", `/api/v1/executor/audit-export?after_seq=${first.nextAfterSeq}&limit=500`)).json()) as { rows: { seq: number; prev_hash: string }[]; complete: boolean };
    expect(second.rows[0]!.seq).toBeGreaterThan(first.nextAfterSeq);
    expect(second.rows[0]!.prev_hash).toBe(first.rows[first.rows.length - 1]!.hash);
    expect(second.complete).toBe(true);
    expect((await call(app, "pv-executor-local", "GET", "/api/v1/executor/audit-export?after_seq=0&limit=501")).status).toBe(400);
    expect((await call(app, "pv-executor-local", "GET", "/api/v1/executor/audit-export?after_seq=-1")).status).toBe(400);
  });

  it("appends one audit event per page", async () => {
    const { app } = worldApp();
    const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'executor_audit_export'").first<{ n: number }>())!.n;
    const before = await count();
    await call(app, "pv-executor-local", "GET", "/api/v1/executor/audit-export?after_seq=0&limit=5");
    expect(await count()).toBe(before + 1);
  });

  it("health reports the pulled audit copy", async () => {
    const { app } = worldApp();
    const body = (await (await app.request(`${BASE}/api/health`, {}, env)).json()) as Record<string, unknown>;
    expect(body.auditCopy).toBe("executor_export");
    expect(body).not.toHaveProperty("auditStream");
  });
});
