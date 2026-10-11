// Daily admission, reconcile and retries (SPEC.md sections 18.5 and 30.3.4), with a small cap standing in for
// production's DAILY_DELETION_STARTS=16: the start past the cap answers 202 deferred without an instance; the next
// cron admits it first; a request admitted 7 hours ago without an instance (a lost message) is re-sent; retries and
// hold releases go through the same admission; the local config is unlimited; the retention sweep admits at most
// min(RETENTION_DAILY_MAX, remaining) new subjects and the cron starts it only when RETENTION_CRON=on.
import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { admit, admittedToday, reconcileReceived, startOrDefer, utcDayStart } from "../../src/worker/admission.ts";
import { loadConfig } from "../../src/worker/env.ts";
import { runScheduledRetention } from "../../src/worker/retention/scheduled.ts";
import { planRetentionSubjects } from "../../src/worker/workflows/retention-sweep.ts";
import { BASE, CSRF, identityOf, seedWorld, tokenFor, worldApp } from "../fixtures/seed.ts";

const CAP = 3;
const capped = (over: Record<string, string> = {}) => ({ ...env, DAILY_DELETION_STARTS: String(CAP), ...over }) as unknown as Env;

async function post(app: ReturnType<typeof worldApp>["app"], e: Env, path: string, body: unknown): Promise<Response> {
  return app.request(`${BASE}${path}`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor("privacy-01"), ...CSRF, "content-type": "application/json" }, body: JSON.stringify(body) }, e);
}

/** A queue that records what is sent instead of delivering it. */
function recordingQueue(): { queue: Queue<{ requestId: string; instanceId?: string }>; sent: { requestId: string; instanceId?: string }[] } {
  const sent: { requestId: string; instanceId?: string }[] = [];
  const queue = {
    send: async (b: { requestId: string; instanceId?: string }) => void sent.push(b),
    sendBatch: async (msgs: { body: { requestId: string; instanceId?: string } }[]) => void sent.push(...msgs.map((m) => m.body)),
  } as unknown as Queue<{ requestId: string; instanceId?: string }>;
  return { queue, sent };
}

let refs: string[] = [];

beforeAll(async () => {
  await seedWorld();
  const { results } = await env.DB.prepare("SELECT employee_ref FROM identity_map WHERE employment_status = 'active' ORDER BY employee_id LIMIT 12").all<{ employee_ref: string }>();
  refs = results.map((r) => r.employee_ref);
});

describe("daily admission (cap 3 standing in for 16)", () => {
  it("starts instances up to the cap, then answers 202 deferred without an instance; the next cron admits it first", async () => {
    await using deletions = await introspectWorkflow(env.DELETION);
    await deletions.modifyAll(async (m) => m.disableSleeps());
    const { app } = worldApp();
    const e = capped();
    const ids: string[] = [];
    for (let i = 0; i < CAP + 1; i++) {
      const res = await post(app, e, "/api/v1/privacy/deletion-requests", { employee_ref: refs[i], reason: "admission test" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { requestId: string; deferred?: boolean };
      ids.push(body.requestId);
      expect(body.deferred ?? false).toBe(i === CAP);
    }
    expect(await admittedToday(env.DB)).toBe(CAP);
    const created = (await deletions.get()).length;
    expect(created).toBe(CAP);
    const deferred = await env.DB.prepare("SELECT status, admitted_at, workflow_instance_id FROM deletion_requests WHERE id = ?").bind(ids[CAP]).first();
    expect(deferred).toEqual({ status: "received", admitted_at: null, workflow_instance_id: null });

    // the started instances move their requests to running (they then wait for the executor)
    for (let t = 0; t < 200; t++) {
      const running = await env.DB.prepare("SELECT COUNT(*) AS n FROM deletion_requests WHERE id IN (?, ?, ?) AND status = 'running'").bind(ids[0], ids[1], ids[2]).first<{ n: number }>();
      if (running!.n === CAP) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // the next UTC day: the cron's reconcile admits the deferred request first and sends it through the queue
    const tomorrow = new Date(Date.now() + 86_400_000);
    const { queue, sent } = recordingQueue();
    const out = await reconcileReceived({ ...e, SWEEP_QUEUE: queue } as Env, CAP, tomorrow);
    expect(out.admitted[0]).toEqual({ requestId: ids[CAP], instanceId: ids[CAP] });
    expect(sent[0]).toEqual({ requestId: ids[CAP], instanceId: ids[CAP] });
    const row = await env.DB.prepare("SELECT admitted_at, workflow_instance_id FROM deletion_requests WHERE id = ?").bind(ids[CAP]).first<{ admitted_at: string; workflow_instance_id: string }>();
    expect(row!.admitted_at >= utcDayStart(tomorrow)).toBe(true);
    expect(row!.workflow_instance_id).toBe(ids[CAP]);
  });

  it("re-sends a request admitted 7 hours ago that never got an instance (a lost queue message), keeping its id", async () => {
    const ident = await identityOf(refs[5]!);
    const admittedAt = new Date(Date.now() - 7 * 3_600_000).toISOString();
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at, admitted_at) VALUES ('rq-lost', 'retention', ?, ?, 'received', 'retention-sweep', ?, ?)")
      .bind(ident.subject_ref, ident.employee_id, admittedAt, admittedAt)
      .run();
    const fresh = new Date(Date.now() - 3_600_000).toISOString();
    const other = await identityOf(refs[6]!);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at, admitted_at) VALUES ('rq-fresh', 'retention', ?, ?, 'received', 'retention-sweep', ?, ?)")
      .bind(other.subject_ref, other.employee_id, fresh, fresh)
      .run();
    const { queue, sent } = recordingQueue();
    const nextDay = new Date(Date.now() + 2 * 86_400_000);
    const out = await reconcileReceived({ ...env, SWEEP_QUEUE: queue } as Env, null, nextDay);
    expect(out.admitted.map((a) => a.requestId)).toContain("rq-lost");
    expect(sent).toContainEqual({ requestId: "rq-lost", instanceId: "rq-lost" });
    // an admission an hour old is not an orphan (yet), measured from the current time
    const now = await reconcileReceived({ ...env, SWEEP_QUEUE: recordingQueue().queue } as Env, null, new Date());
    expect(now.admitted.map((a) => a.requestId)).not.toContain("rq-fresh");
  });

  it("retries and hold releases are admitted like DSRs: over the cap they are deferred and get the next instance id later", async () => {
    const ident = await identityOf(refs[8]!);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at, workflow_instance_id) VALUES ('rq-failed', 'dsr', ?, ?, 'failed', 'privacy-01', ?, 'rq-failed')")
      .bind(ident.subject_ref, ident.employee_id, new Date().toISOString())
      .run();
    const { app } = worldApp();
    // today's cap is already used up by the first test
    const res = await post(app, capped(), "/api/v1/privacy/deletion-requests/rq-failed/retry", {});
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ requestId: "rq-failed", instanceId: null, deferred: true });
    expect(await env.DB.prepare("SELECT status, admitted_at, workflow_instance_id FROM deletion_requests WHERE id = 'rq-failed'").first()).toEqual({ status: "received", admitted_at: null, workflow_instance_id: "rq-failed" });
    const { queue, sent } = recordingQueue();
    await reconcileReceived({ ...env, SWEEP_QUEUE: queue } as Env, CAP, new Date(Date.now() + 3 * 86_400_000));
    expect(sent).toContainEqual({ requestId: "rq-failed", instanceId: "rq-failed-r1" });
  });

  it("admission is atomic per statement: a full day refuses, an unlimited cap always admits", async () => {
    const ident = await identityOf(refs[9]!);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES ('rq-atomic', 'dsr', ?, ?, 'received', 'privacy-01', ?)")
      .bind(ident.subject_ref, ident.employee_id, new Date().toISOString())
      .run();
    expect(await admit(env.DB, "rq-atomic", await admittedToday(env.DB))).toBe(false);
    expect(await admit(env.DB, "rq-atomic", null)).toBe(true);
  });

  it("the local configuration is unlimited: DAILY_DELETION_STARTS is empty", async () => {
    expect(loadConfig(env).dailyDeletionStarts).toBeNull();
    expect(loadConfig(env).retentionDailyMax).toBeNull();
    const ident = await identityOf(refs[10]!);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES ('rq-local', 'dsr', ?, ?, 'received', 'privacy-01', ?)")
      .bind(ident.subject_ref, ident.employee_id, new Date().toISOString())
      .run();
    await using instance = await introspectWorkflowInstance(env.DELETION, "rq-local");
    await instance.modify(async (m) => m.disableSleeps());
    expect(await startOrDefer(env, env.DB, "rq-local", "rq-local", loadConfig(env).dailyDeletionStarts)).toEqual({ deferred: false, instanceId: "rq-local" });
  });
});

describe("cron and retention sweep caps", () => {
  it("RETENTION_CRON=off runs the reconcile but starts no retention sweep", async () => {
    await using runs = await introspectWorkflow(env.RETENTION);
    const out = await runScheduledRetention({ ...env, RETENTION_CRON: "off", SWEEP_QUEUE: recordingQueue().queue } as unknown as Env, new Date(Date.now() + 5 * 86_400_000));
    expect(out.retentionRun).toBeNull();
    expect(await runs.get()).toHaveLength(0);
  });

  it("the sweep admits at most min(RETENTION_DAILY_MAX, remaining cap, max_subjects) new subjects in order, held ones without a cap", () => {
    const eligible = Array.from({ length: 12 }, (_, i) => ({ subject_ref: `sr_${i}`, employee_id: `E${i}` }));
    const held = new Set(["sr_1", "sr_5"]);
    const pick = (caps: { maxSubjects: number | null; retentionDailyMax: number | null; remaining: number | null }) => {
      const p = planRetentionSubjects(eligible, held, caps);
      return [p.newRows.map((r) => r.subject_ref), p.heldRows.map((r) => r.subject_ref)];
    };
    // production: 8 a day within the day's 16 starts
    expect(pick({ maxSubjects: null, retentionDailyMax: 8, remaining: 16 })).toEqual([["sr_0", "sr_2", "sr_3", "sr_4", "sr_6", "sr_7", "sr_8", "sr_9"], ["sr_1", "sr_5"]]);
    expect(pick({ maxSubjects: null, retentionDailyMax: 8, remaining: 3 })[0]).toEqual(["sr_0", "sr_2", "sr_3"]);
    expect(pick({ maxSubjects: null, retentionDailyMax: 8, remaining: 0 })).toEqual([[], ["sr_1", "sr_5"]]);
    expect(pick({ maxSubjects: 2, retentionDailyMax: null, remaining: null })[0]).toEqual(["sr_0", "sr_2"]);
    // local: unlimited, every eligible subject
    expect(pick({ maxSubjects: null, retentionDailyMax: null, remaining: null })[0]).toHaveLength(10);
  });
});
