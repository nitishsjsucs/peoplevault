// Privacy officer API (SPEC.md section 13): deletion requests, legal holds, asset inventory and audit.
import { Hono, type Context } from "hono";
import { AuditVerifyQuery, DeletionRequestBody, LegalHoldBody, ReportQuery, RetentionRunBody } from "../../shared/api-schemas.ts";
import type { AppEnv } from "../app.ts";
import { ASSETS } from "../assets/registry.ts";
import { VERIFY_WINDOW_MAX } from "../audit/audit-log.ts";
import { audit, errorJson } from "../context.ts";
import { activeHolds, placeHold, releaseHold, type HoldRow } from "../holds/holds.ts";
import { identityByRef } from "../identity/refs.ts";
import { decide, type Action } from "../policy/pdp.ts";
import { deletionReport, REPORT_FAILURES_MAX } from "../reports/deletion-report.ts";
import { retentionRunAsOf, utcToday } from "../retention/rules.ts";
import { startOrDefer } from "../admission.ts";
import { ActiveRequestExists, getRequest, insertRequest, nextInstanceId, publicRequest, type DeletionRequestRow } from "../requests.ts";

export const privacy = new Hono<AppEnv>();

async function authorize(c: Context<AppEnv>, purpose: string, action: Action, route: string): Promise<Response | null> {
  const d = decide({ principal: c.get("principal"), purpose, action });
  if (d.allow) return null;
  await audit(c, { purpose, action, route, decision: "deny", reason: d.reason });
  return c.json({ error: d.status === 404 ? "not_found" : "forbidden", code: d.reason }, d.status);
}

async function deny(c: Context<AppEnv>, purpose: string, action: Action, route: string, status: 400 | 404 | 409, code: string): Promise<Response> {
  await audit(c, { purpose, action, route, decision: "deny", reason: code });
  return errorJson(c, status, code);
}

// ---- deletion requests ----------------------------------------------------------------------------------------------
const DR = "/api/v1/privacy/deletion-requests";

privacy.post(DR, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "create_deletion_request", DR);
  if (denied) return denied;
  const body = DeletionRequestBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return deny(c, "privacy_compliance", "create_deletion_request", DR, 400, "invalid_body");
  const ident = await identityByRef(c.env.DB, "employee_ref", body.data.employee_ref);
  if (!ident) return deny(c, "privacy_compliance", "create_deletion_request", DR, 404, "not_found");
  const requestId = crypto.randomUUID();
  try {
    await insertRequest(c.env.DB, { id: requestId, kind: "dsr", subjectRef: ident.subjectRef, employeeId: ident.employeeId, requestedBy: c.get("principal").id });
  } catch (e) {
    if (e instanceof ActiveRequestExists) return deny(c, "privacy_compliance", "create_deletion_request", DR, 409, "active_request_exists");
    throw e;
  }
  // Workers Free: at most DAILY_DELETION_STARTS instances start per UTC day; over the cap the request is deferred
  // and the daily cron starts it (SPEC.md section 30.3.4).
  const start = await startOrDefer(c.env, c.env.DB, requestId, requestId, c.get("cfg").dailyDeletionStarts);
  await audit(c, { purpose: "privacy_compliance", action: "create_deletion_request", route: DR, subjectRef: ident.subjectRef, requestId, decision: "allow", reason: start.deferred ? "deferred" : "ok" });
  return c.json(start.deferred ? { requestId, status: "received", deferred: true } : { requestId, status: "received" }, 202);
});

privacy.get(DR, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_deletion_request", DR);
  if (denied) return denied;
  const status = c.req.query("status");
  const { results } = status
    ? await c.env.DB.prepare("SELECT * FROM deletion_requests WHERE status = ? ORDER BY created_at, id LIMIT 1000").bind(status).all<DeletionRequestRow>()
    : await c.env.DB.prepare("SELECT * FROM deletion_requests ORDER BY created_at, id LIMIT 1000").all<DeletionRequestRow>();
  await audit(c, { purpose: "privacy_compliance", action: "read_deletion_request", route: DR, decision: "allow", reason: "ok", rowCount: results.length });
  return c.json({ requests: results.map(publicRequest) });
});

const DR_ONE = "/api/v1/privacy/deletion-requests/:id";
privacy.get(DR_ONE, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_deletion_request", DR_ONE);
  if (denied) return denied;
  const r = await getRequest(c.env.DB, c.req.param("id"));
  if (!r) return deny(c, "privacy_compliance", "read_deletion_request", DR_ONE, 404, "not_found");
  const assets = await c.env.DB.prepare("SELECT * FROM deletion_asset_results WHERE request_id = ? ORDER BY asset_id").bind(r.id).all();
  const residuals = await c.env.DB.prepare("SELECT * FROM residuals WHERE request_id = ? ORDER BY id").bind(r.id).all();
  await audit(c, { purpose: "privacy_compliance", action: "read_deletion_request", route: DR_ONE, subjectRef: r.subject_ref, requestId: r.id, decision: "allow", reason: "ok", rowCount: 1 });
  return c.json({ request: publicRequest(r), assets: assets.results, residuals: residuals.results });
});

const DR_RECEIPT = "/api/v1/privacy/deletion-requests/:id/receipt";
privacy.get(DR_RECEIPT, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_deletion_request", DR_RECEIPT);
  if (denied) return denied;
  const r = await getRequest(c.env.DB, c.req.param("id"));
  if (!r || !r.summary_json) return deny(c, "privacy_compliance", "read_deletion_request", DR_RECEIPT, 404, "not_found");
  const event = await c.env.DB.prepare("SELECT seq, hash FROM audit_events WHERE request_id = ? AND action = 'deletion_receipt' ORDER BY seq DESC LIMIT 1").bind(r.id).first<{ seq: number; hash: string }>();
  await audit(c, { purpose: "privacy_compliance", action: "read_deletion_request", route: DR_RECEIPT, subjectRef: r.subject_ref, requestId: r.id, decision: "allow", reason: "ok", rowCount: 1 });
  return c.json({ receipt: JSON.parse(r.summary_json), audit: event ?? null });
});

const DR_RETRY = "/api/v1/privacy/deletion-requests/:id/retry";
privacy.post(DR_RETRY, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "create_deletion_request", DR_RETRY);
  if (denied) return denied;
  const r = await getRequest(c.env.DB, c.req.param("id"));
  if (!r) return deny(c, "privacy_compliance", "create_deletion_request", DR_RETRY, 404, "not_found");
  if (r.status !== "failed") return deny(c, "privacy_compliance", "create_deletion_request", DR_RETRY, 409, "not_failed");
  const instanceId = nextInstanceId(r.id, r.workflow_instance_id);
  const upd = await c.env.DB.prepare("UPDATE deletion_requests SET status = 'received', completed_at = NULL WHERE id = ? AND status = 'failed'").bind(r.id).run().catch((e: unknown) => e);
  if (upd instanceof Error) return deny(c, "privacy_compliance", "create_deletion_request", DR_RETRY, 409, "active_request_exists");
  const start = await startOrDefer(c.env, c.env.DB, r.id, instanceId, c.get("cfg").dailyDeletionStarts);
  await audit(c, { purpose: "privacy_compliance", action: "create_deletion_request", route: DR_RETRY, subjectRef: r.subject_ref, requestId: r.id, decision: "allow", reason: start.deferred ? "retry_deferred" : "retry" });
  return c.json(start.deferred ? { requestId: r.id, instanceId: null, status: "received", deferred: true } : { requestId: r.id, instanceId, status: "received" }, 202);
});

// ---- legal holds ----------------------------------------------------------------------------------------------------
const LH = "/api/v1/privacy/legal-holds";
const publicHold = (h: HoldRow) => ({ id: h.id, matterId: h.matter_id, subjectRef: h.subject_ref, placedBy: h.placed_by, placedAt: h.placed_at, releasedAt: h.released_at, releasedBy: h.released_by });

privacy.post(LH, async (c) => {
  const denied = await authorize(c, "legal_hold_management", "place_legal_hold", LH);
  if (denied) return denied;
  const body = LegalHoldBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return deny(c, "legal_hold_management", "place_legal_hold", LH, 400, "invalid_body");
  const ident = await identityByRef(c.env.DB, "employee_ref", body.data.employee_ref);
  if (!ident) return deny(c, "legal_hold_management", "place_legal_hold", LH, 404, "not_found");
  const hold = await placeHold(c.env.DB, { matterId: body.data.matter_id, subjectRef: ident.subjectRef, reason: body.data.reason, placedBy: c.get("principal").id });
  await audit(c, { purpose: "legal_hold_management", action: "place_legal_hold", route: LH, subjectRef: ident.subjectRef, decision: "allow", reason: "ok", detail: { matter: body.data.matter_id } });
  return c.json({ hold: publicHold(hold) }, 201);
});

const LH_RELEASE = "/api/v1/privacy/legal-holds/:id/release";
privacy.post(LH_RELEASE, async (c) => {
  const denied = await authorize(c, "legal_hold_management", "release_legal_hold", LH_RELEASE);
  if (denied) return denied;
  const res = await releaseHold(c.env, c.env.DB, c.req.param("id"), c.get("principal").id, c.get("cfg").dailyDeletionStarts);
  if (!res) return deny(c, "legal_hold_management", "release_legal_hold", LH_RELEASE, 404, "not_found");
  const remaining = (await activeHolds(c.env.DB, res.hold.subject_ref)).length;
  await audit(c, { purpose: "legal_hold_management", action: "release_legal_hold", route: LH_RELEASE, subjectRef: res.hold.subject_ref, decision: "allow", reason: "ok", detail: { resubmitted: res.resubmitted.length, deferred: res.deferred.length, remaining_holds: remaining } });
  return c.json({ hold: publicHold(res.hold), resubmitted: res.resubmitted, deferred: res.deferred, remainingHolds: remaining });
});

privacy.get(LH, async (c) => {
  const denied = await authorize(c, "legal_hold_management", "read_legal_holds", LH);
  if (denied) return denied;
  const { results } = await c.env.DB.prepare("SELECT * FROM legal_holds ORDER BY placed_at, id").all<HoldRow>();
  await audit(c, { purpose: "legal_hold_management", action: "read_legal_holds", route: LH, decision: "allow", reason: "ok", rowCount: results.length });
  return c.json({ holds: results.map(publicHold) });
});

// ---- asset inventory ------------------------------------------------------------------------------------------------
const ASSETS_ROUTE = "/api/v1/privacy/assets";
async function countR2(bucket: R2Bucket, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    n += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}
async function countKv(kv: KVNamespace, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    n += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}

privacy.get(ASSETS_ROUTE, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_assets", ASSETS_ROUTE);
  if (denied) return denied;
  const live: Record<string, number | null> = {
    "src.r2.exports": await countR2(c.env.EXPORTS, "exports/"),
    "drv.r2.analytics_extracts": await countR2(c.env.DERIVED, "extracts/workforce_analytics/"),
    "cache.kv.profile_cards": await countKv(c.env.CACHE, "profile:"),
    "cache.kv.team_rosters": await countKv(c.env.CACHE, "team:"),
    "id.d1.identity_records": (await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM identity_map) AS n").first<{ n: number }>())?.n ?? 0,
  };
  await audit(c, { purpose: "privacy_compliance", action: "read_assets", route: ASSETS_ROUTE, decision: "allow", reason: "ok", rowCount: ASSETS.length });
  return c.json({ assets: ASSETS.map((a) => ({ ...a, liveCount: live[a.id] ?? null })) });
});

const KEYS_ROUTE = "/api/v1/privacy/assets/r2/:bucket/keys";
privacy.get(KEYS_ROUTE, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_assets", KEYS_ROUTE);
  if (denied) return denied;
  const bucketName = c.req.param("bucket");
  const bucket = bucketName === "pv-source-exports" ? c.env.EXPORTS : bucketName === "pv-derived" ? c.env.DERIVED : null;
  if (!bucket) return deny(c, "privacy_compliance", "read_assets", KEYS_ROUTE, 404, "unknown_bucket");
  const cursor = c.req.query("cursor");
  const page = await bucket.list({ prefix: c.req.query("prefix") ?? "", limit: 1000, ...(cursor ? { cursor } : {}) });
  await audit(c, { purpose: "privacy_compliance", action: "read_assets", route: KEYS_ROUTE, decision: "allow", reason: "ok", rowCount: page.objects.length });
  return c.json({ keys: page.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() })), cursor: page.truncated ? page.cursor : null });
});

// ---- coverage report ------------------------------------------------------------------------------------------------
const REPORT = "/api/v1/privacy/reports/deletion";
privacy.get(REPORT, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_report", REPORT);
  if (denied) return denied;
  const q = ReportQuery.safeParse({ from: c.req.query("from") ?? null, to: c.req.query("to") ?? null, limit: c.req.query("limit") ?? String(REPORT_FAILURES_MAX), cursor: c.req.query("cursor") ?? null });
  if (!q.success) return deny(c, "privacy_compliance", "read_report", REPORT, 400, "invalid_query");
  const report = await deletionReport(c.env.DB, q.data.from, q.data.to, { limit: q.data.limit, cursor: q.data.cursor });
  await audit(c, { purpose: "privacy_compliance", action: "read_report", route: REPORT, decision: "allow", reason: "ok", rowCount: report.requests.total });
  return c.json(report);
});

// ---- retention ------------------------------------------------------------------------------------------------------
const RET_RUN = "/api/v1/privacy/retention/run";
privacy.post(RET_RUN, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "run_retention", RET_RUN);
  if (denied) return denied;
  const body = RetentionRunBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!body.success) return deny(c, "privacy_compliance", "run_retention", RET_RUN, 400, "invalid_body");
  const chosen = retentionRunAsOf(body.data.as_of, c.get("cfg"), utcToday());
  if ("error" in chosen) return deny(c, "privacy_compliance", "run_retention", RET_RUN, 400, chosen.error);
  const { asOf } = chosen;
  const max = body.data.max_subjects;
  const runId = max !== undefined ? `retention-${asOf}-max${max}` : `retention-${asOf}`;
  try {
    await c.env.RETENTION.create({ id: runId, params: { asOf, ...(max !== undefined ? { maxSubjects: max } : {}) } });
  } catch (e) {
    if (/already[ _]exists?/i.test(String(e))) return deny(c, "privacy_compliance", "run_retention", RET_RUN, 409, "run_exists");
    throw e;
  }
  await audit(c, { purpose: "privacy_compliance", action: "run_retention", route: RET_RUN, decision: "allow", reason: "ok", detail: { as_of: asOf, max_subjects: max ?? null } });
  return c.json({ runId, asOf }, 202);
});

const RET_RUNS = "/api/v1/privacy/retention/runs";
privacy.get(RET_RUNS, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "run_retention", RET_RUNS);
  if (denied) return denied;
  const { results } = await c.env.DB.prepare("SELECT * FROM retention_runs ORDER BY started_at DESC LIMIT 100").all<{ summary_json: string | null }>();
  await audit(c, { purpose: "privacy_compliance", action: "run_retention", route: RET_RUNS, decision: "allow", reason: "ok", rowCount: results.length });
  return c.json({ runs: results.map((r) => ({ ...r, summary: r.summary_json ? JSON.parse(r.summary_json) : null })) });
});

// ---- audit ----------------------------------------------------------------------------------------------------------
const AUDIT_ROUTE = "/api/v1/privacy/audit";
privacy.get(AUDIT_ROUTE, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_audit", AUDIT_ROUTE);
  if (denied) return denied;
  const after = Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0;
  const { results } = await c.env.DB.prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq LIMIT 200").bind(after).all<{ seq: number }>();
  await audit(c, { purpose: "privacy_compliance", action: "read_audit", route: AUDIT_ROUTE, decision: "allow", reason: "ok", rowCount: results.length });
  return c.json({ events: results, cursor: results.length === 200 ? results[results.length - 1]!.seq : null });
});

// Windowed chain verification (SPEC.md section 30.3.2): at most 100 events per request, anchored on the hash of row
// `after_seq`; clients follow `nextAfterSeq` until `complete` and check that each window's `anchorHash` equals the
// previous window's `lastHash`.
const AUDIT_VERIFY = "/api/v1/privacy/audit/verify";
privacy.get(AUDIT_VERIFY, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_audit", AUDIT_VERIFY);
  if (denied) return denied;
  const q = AuditVerifyQuery.safeParse({ after_seq: c.req.query("after_seq") ?? "0", limit: c.req.query("limit") ?? String(VERIFY_WINDOW_MAX) });
  if (!q.success) return deny(c, "privacy_compliance", "read_audit", AUDIT_VERIFY, 400, "invalid_query");
  const w = await c.get("audit").verifyWindow(q.data.after_seq, q.data.limit);
  await audit(c, { purpose: "privacy_compliance", action: "read_audit", route: AUDIT_VERIFY, decision: "allow", reason: "ok", detail: { ok: w.ok, checked: w.checked, complete: w.complete } });
  return c.json(w);
});
