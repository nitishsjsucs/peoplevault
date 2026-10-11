// Cursor steps (SPEC.md sections 18.5 and 30.3.1): a listing that changes between two probe steps restarts the probe of
// that bucket, so nothing is skipped; an erase restart removes 0 further rows; more than 3 changes fail closed; step
// outputs never carry a key or a token, even for an object whose key holds the subject's employee id.
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { eraseObject } from "../../src/worker/erase/jsonl-objects.ts";
import { CURSOR_START, ListingChanged, registeredR2Parts, walkParts } from "../../src/worker/erase/r2-cursor.ts";
import { PROBE_START, ProbeListingChanged, probeR2Step } from "../../src/worker/verify/r2-probe.ts";
import { subjectMatchers } from "../../src/worker/verify/tokens.ts";
import { executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject, type WorldIdentity } from "../fixtures/seed.ts";

const matchersOf = (i: WorldIdentity) =>
  subjectMatchers({ employeeId: i.employee_id, workEmail: i.work_email, fullName: i.full_name, employeeRef: i.employee_ref, warehouseKey: i.warehouse_key, analyticsId: i.analytics_id }, { includeFullName: true });

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
});

describe("probe cursor", () => {
  it("an object added between two probe steps changes the digest and rescans the bucket, so it is found", async () => {
    const ident = await identityOf(subject("hrbp-02", "in_unit", 4).employee_ref);
    for (let i = 0; i < 4; i++) await env.DERIVED.put(`zz/pad-${i}.txt`, "x".repeat(1000));
    const buckets = [{ name: "pv-derived", bucket: env.DERIVED }];
    const first = await probeR2Step(buckets, matchersOf(ident), PROBE_START, 1500);
    expect(first.done).toBe(false);
    expect(first.cursor.pos).toBeGreaterThan(0);
    // added before the cursor position: without the digest check it would be skipped
    await env.DERIVED.put("aa/late-copy.txt", `copy of ${ident.work_email}\n`);
    let cursor = first.cursor;
    const found = [...first.findings];
    let restarted = false;
    for (let i = 0; i < 20; i++) {
      const r = await probeR2Step(buckets, matchersOf(ident), cursor, 1500);
      if (r.cursor.restarts > 0) restarted = true;
      found.push(...r.findings);
      cursor = r.cursor;
      if (r.done) break;
    }
    expect(restarted).toBe(true);
    expect(found.map((f) => f.location)).toContain("pv-derived/aa/late-copy.txt");
    await env.DERIVED.delete("aa/late-copy.txt");
    for (let i = 0; i < 4; i++) await env.DERIVED.delete(`zz/pad-${i}.txt`);
  });

  it("a listing that keeps changing fails closed after 3 restarts", async () => {
    const ident = await identityOf(subject("hrbp-02", "in_unit", 4).employee_ref);
    for (let i = 0; i < 3; i++) await env.DERIVED.put(`zz/pad-${i}.txt`, "x".repeat(1000));
    const buckets = [{ name: "pv-derived", bucket: env.DERIVED }];
    let cursor = (await probeR2Step(buckets, matchersOf(ident), PROBE_START, 1)).cursor;
    let error: unknown = null;
    for (let i = 0; i < 5 && !error; i++) {
      await env.DERIVED.put(`zz/churn-${i}.txt`, "y");
      try {
        cursor = (await probeR2Step(buckets, matchersOf(ident), cursor, 1)).cursor;
      } catch (e) {
        error = e;
      }
    }
    expect(error).toBeInstanceOf(ProbeListingChanged);
    for (let i = 0; i < 5; i++) await env.DERIVED.delete(`zz/churn-${i}.txt`);
    for (let i = 0; i < 3; i++) await env.DERIVED.delete(`zz/pad-${i}.txt`);
  });
});

describe("erase cursor", () => {
  it("a restart after a listing change removes 0 further rows from objects already erased", async () => {
    const ident = await identityOf(subject("hrbp-02", "in_unit", 5).employee_ref);
    const parts = registeredR2Parts();
    const visit = (counts: { removed: number }) => async (ref: (typeof parts)[number], key: string) => {
      const value = ref.subjectColumn === "employee_id" ? ident.employee_id : ident.analytics_id;
      counts.removed += (await eraseObject(env[ref.binding], key, ref.part, ref.subjectColumn, value, "req-cursor")).rowsRemoved;
    };
    const row = `${JSON.stringify({ employee_id: ident.employee_id, full_name: ident.full_name })}\n`;
    await env.EXPORTS.put("exports/hris/employees/dt=2026-09-29/employees.jsonl", row);
    const first = { removed: 0 };
    const w1 = await walkParts(env, parts, CURSOR_START, 1, visit(first));
    expect([w1.done, w1.objects, w1.cursor.part, w1.cursor.pos, first.removed]).toEqual([false, 1, 0, 1, 1]);
    // a new HRIS object appears: the part restarts at 0 and the first object yields nothing more
    await env.EXPORTS.put("exports/hris/employees/dt=2026-09-30/employees.jsonl", row);
    const second = { removed: 0 };
    let cursor = w1.cursor;
    let restarts = 0;
    for (;;) {
      const w = await walkParts(env, parts, cursor, 1, visit(second));
      restarts = Math.max(restarts, w.cursor.restarts);
      cursor = w.cursor;
      if (w.done) break;
    }
    expect(restarts).toBe(1);
    // the late object's row plus the subject's rows in the other families; nothing twice
    for (const d of ["2026-09-29", "2026-09-30"]) expect(await (await env.EXPORTS.get(`exports/hris/employees/dt=${d}/employees.jsonl`))!.text()).toBe("");
    for (const o of (await env.EXPORTS.list({ prefix: "exports/" })).objects) expect(await (await env.EXPORTS.get(o.key))!.text()).not.toContain(ident.employee_id);
    expect(second.removed).toBeGreaterThanOrEqual(2);
    for (const d of ["2026-09-29", "2026-09-30"]) await env.EXPORTS.delete(`exports/hris/employees/dt=${d}/employees.jsonl`);
  });

  it("throws ListingChanged after 3 restarts", async () => {
    const parts = registeredR2Parts();
    let cursor = (await walkParts(env, parts, CURSOR_START, 1, async () => {})).cursor;
    let error: unknown = null;
    for (let i = 0; i < 5 && !error; i++) {
      // the first walk finished the single HRIS object and stopped in the payroll part: change that listing
      await env.EXPORTS.put(`exports/payroll/compensation/period=2020-0${i + 1}/compensation.csv`, "employee_id\n");
      try {
        cursor = (await walkParts(env, parts, cursor, 1, async () => {})).cursor;
      } catch (e) {
        error = e;
      }
    }
    expect(error).toBeInstanceOf(ListingChanged);
    for (let i = 0; i < 5; i++) await env.EXPORTS.delete(`exports/payroll/compensation/period=2020-0${i + 1}/compensation.csv`);
  });
});

describe("step outputs of the cursor steps", () => {
  it("carry indexes, digests and counts only: no key and no token, even for a key named after the subject", async () => {
    const s = subject("hrbp-02", "in_unit", 6);
    const ident = await identityOf(s.employee_ref);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES ('req-keys', 'dsr', ?, ?, 'received', 'privacy-01', ?)")
      .bind(ident.subject_ref, ident.employee_id, new Date().toISOString())
      .run();
    await env.EXPORTS.put(`exports/adhoc/${ident.employee_id}.jsonl`, `${JSON.stringify({ employee_id: ident.employee_id })}\n`);
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-keys");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    });
    await env.DELETION.create({ id: "req-keys", params: { requestId: "req-keys" } });
    await instance.waitForStatus("complete");
    const outputs: string[] = [];
    for (const prefix of ["erase-r2", "verify-r2"]) {
      for (let n = 1; ; n++) {
        const out = (await instance.waitForStepResult({ name: `${prefix}-${n}` })) as { done: boolean; cursor: Record<string, unknown> };
        outputs.push(JSON.stringify(out));
        expect(Object.keys(out.cursor).sort()).toEqual(prefix === "erase-r2" ? ["digest", "part", "pos", "restarts"] : ["bucket", "digest", "pos", "restarts"]);
        if (out.done) break;
      }
    }
    outputs.push(JSON.stringify(await instance.waitForStepResult({ name: "verify-kv" })), JSON.stringify(await instance.getOutput()));
    const all = outputs.join("\n");
    expect(all).not.toMatch(/exports\/|extracts\/|\.jsonl|\.csv/);
    for (const t of [ident.employee_id, ident.work_email, ident.full_name, ident.employee_ref, ident.analytics_id]) expect(all).not.toContain(t);
    // the residue was found and recorded in D1 with a redacted location
    const row = await env.DB.prepare("SELECT asset_id FROM deletion_asset_results WHERE request_id = 'req-keys' AND applicability = 'unregistered'").first<{ asset_id: string }>();
    expect(row!.asset_id).toBe("unregistered:r2:pv-source-exports/exports/adhoc/[redacted].jsonl");
    await env.EXPORTS.delete(`exports/adhoc/${ident.employee_id}.jsonl`);
  });
});
