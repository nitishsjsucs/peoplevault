// Audit stream (P1, SPEC.md sections 14.7 and 16.1). Disabled mode never touches the binding and health says so;
// pipelines mode sends exactly one schema-valid, identifier-free record per appended event, never blocks or fails the
// request when the stream fails, and logs counts only. The production binding is replaced by a fake: Miniflare's local
// pipeline binding is a no-op, so nothing local is described as Basin Pipelines.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditLog, type AuditRow } from "../../src/worker/audit/audit-log.ts";
import { AUDIT_STREAM_SCHEMA, auditStreamFor, schemaProblems, streamEvent, toStreamRecord, withAuditStream } from "../../src/worker/audit/audit-stream.ts";
import { buildApp } from "../../src/worker/app.ts";
import { BASE, seedWorld, subject, tokenFor, worldApp, type WorldIdentity } from "../fixtures/seed.ts";

class FakeStream {
  records: Record<string, unknown>[] = [];
  calls = 0;
  fail = false;
  async send(records: Record<string, unknown>[]): Promise<void> {
    this.calls++;
    if (this.fail) throw new Error("stream unavailable");
    this.records.push(...records);
  }
}

function streamingEnv(stream: FakeStream): Env {
  return { ...env, AUDIT_STREAM_MODE: "pipelines", AUDIT_STREAM: stream as unknown as Env["AUDIT_STREAM"] } as Env;
}

async function get(app: ReturnType<typeof buildApp>, e: Env, principal: string, path: string): Promise<Response> {
  return app.request(`${BASE}${path}`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor(principal) } }, e);
}

async function lastSeq(): Promise<number> {
  return (await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM audit_events").first<{ n: number }>())!.n;
}

beforeAll(async () => {
  await seedWorld();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audit stream", () => {
  it("the schema file has the 16 fields of the design, detail_json excluded", () => {
    expect(AUDIT_STREAM_SCHEMA.fields.map((f) => f.name)).toEqual([
      "seq", "id", "ts", "actor", "actor_kind", "persona", "purpose", "action", "route", "subject_ref", "request_id", "decision", "reason", "row_count", "prev_hash", "hash",
    ]);
    expect(AUDIT_STREAM_SCHEMA.fields.filter((f) => f.required).map((f) => f.name)).toEqual(["seq", "id", "ts", "actor", "actor_kind", "action", "decision", "reason", "prev_hash", "hash"]);
  });

  it("disabled (local) mode never calls the binding, and health reports disabled_local", async () => {
    const stream = new FakeStream();
    const e = { ...env, AUDIT_STREAM: stream as unknown as Env["AUDIT_STREAM"] } as Env; // mode stays disabled
    const { app } = worldApp();
    const before = await lastSeq();
    expect((await get(app, e, "mgr-002", "/api/v1/purposes/team_management/team")).status).toBe(200);
    expect(await lastSeq()).toBeGreaterThan(before);
    expect(stream.calls).toBe(0);
    expect(auditStreamFor(env).mode).toBe("disabled");
    expect(await (await buildApp().request("/api/health", {}, e)).json()).toMatchObject({ auditStream: "disabled_local" });
  });

  it("pipelines mode: one schema-valid record per appended event, equal to the D1 row without detail_json, no identifiers", async () => {
    const stream = new FakeStream();
    const e = streamingEnv(stream);
    const { app } = worldApp();
    const before = await lastSeq();
    expect((await get(app, e, "mgr-002", "/api/v1/purposes/team_management/team")).status).toBe(200);
    expect((await get(app, e, "hrbp-01", `/api/v1/purposes/employee_relations/employees/${subject("hrbp-01", "in_unit", 0).employee_ref}`)).status).toBe(200);
    expect((await get(app, e, "analyst-01", "/api/v1/purposes/employee_relations/employees")).status).toBe(403);
    const rows = (await env.DB.prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq").bind(before).all<AuditRow>()).results;
    expect(rows.length).toBe(3);
    expect(stream.records.length).toBe(rows.length);
    for (const [i, row] of rows.entries()) {
      const { detail_json: _omit, ...rest } = row;
      expect(stream.records[i]).toEqual(rest);
      expect(Object.keys(stream.records[i]!)).toEqual(AUDIT_STREAM_SCHEMA.fields.map((f) => f.name));
      expect(schemaProblems(stream.records[i]!)).toEqual([]);
    }
    expect(stream.records.map((r) => r.decision)).toEqual(["allow", "allow", "deny"]);
    const everyone = (await env.DB.prepare("SELECT * FROM identity_map").all<WorldIdentity>()).results;
    const flat = JSON.stringify(stream.records);
    for (const p of everyone) for (const t of [p.employee_id, p.work_email, p.full_name, p.employee_ref, p.warehouse_key, p.analytics_id]) expect(flat).not.toContain(t);
    expect(await (await buildApp().request("/api/health", {}, e)).json()).toMatchObject({ auditStream: "pipelines" });
  });

  it("a failing stream never fails the request or the append, and logs a count only", async () => {
    const stream = new FakeStream();
    stream.fail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = worldApp();
    const before = await lastSeq();
    expect((await get(app, streamingEnv(stream), "mgr-002", "/api/v1/purposes/team_management/team")).status).toBe(200);
    expect(await lastSeq()).toBe(before + 1);
    expect(warn).toHaveBeenCalledWith("audit_stream_failed", 1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/er_|sr_|@/);
    expect((await createAuditLog(env.DB).verify()).ok).toBe(true);
  });

  it("with an execution context the send runs in waitUntil", async () => {
    const stream = new FakeStream();
    const { app } = worldApp();
    const ctx = createExecutionContext();
    const req = new Request(`${BASE}/api/v1/purposes/team_management/team`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("mgr-002") } });
    const res = await app.fetch(req, streamingEnv(stream), ctx);
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(stream.records.length).toBe(1);
  });

  it("a record that does not match the schema is counted as dropped, not sent (the stream would drop it silently)", async () => {
    const stream = new FakeStream();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = withAuditStream(createAuditLog(env.DB), auditStreamFor(streamingEnv(stream)));
    const { row } = await log.append({ actor: "workflow", actorKind: "system", action: "deletion_receipt", decision: "info", reason: "completed" });
    expect(stream.records.length).toBe(1);
    expect(await streamEvent(auditStreamFor(streamingEnv(stream)), { ...row, ts: "yesterday" })).toBe("dropped");
    expect(await streamEvent(auditStreamFor(streamingEnv(stream)), { ...row, seq: 1.5 })).toBe("dropped");
    expect(schemaProblems({ ...toStreamRecord(row), extra: "x" })).toEqual(["extra: not in schema"]);
    expect(stream.records.length).toBe(1);
    expect(warn).toHaveBeenCalledWith("audit_stream_dropped", 1);
  });

  it("pipelines mode without the binding is a configuration error", async () => {
    const res = await buildApp().request("/api/health", {}, { ...env, AUDIT_STREAM_MODE: "pipelines" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured" });
  });
});
