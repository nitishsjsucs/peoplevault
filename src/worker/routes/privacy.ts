// Privacy officer API (SPEC.md section 13): deletion requests, legal holds, asset inventory and audit.
import { Hono, type Context } from "hono";
import { DeletionRequestBody, LegalHoldBody } from "../../shared/api-schemas.ts";
import type { AppEnv } from "../app.ts";
import { ASSETS } from "../assets/registry.ts";
import { audit, errorJson } from "../context.ts";
import { activeHolds, placeHold, releaseHold, type HoldRow } from "../holds/holds.ts";
import { identityByRef } from "../identity/refs.ts";
import { decide, type Action } from "../policy/pdp.ts";
import { ActiveRequestExists, getRequest, insertRequest, nextInstanceId, publicRequest, startDeletionInstance, type DeletionRequestRow } from "../requests.ts";

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
  await startDeletionInstance(c.env, c.env.DB, requestId, requestId);
  await audit(c, { purpose: "privacy_compliance", action: "create_deletion_request", route: DR, subjectRef: ident.subjectRef, requestId, decision: "allow", reason: "ok" });
  return c.json({ requestId, status: "received" }, 202);
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
  await startDeletionInstance(c.env, c.env.DB, r.id, instanceId);
  await audit(c, { purpose: "privacy_compliance", action: "create_deletion_request", route: DR_RETRY, subjectRef: r.subject_ref, requestId: r.id, decision: "allow", reason: "retry" });
  return c.json({ requestId: r.id, instanceId, status: "received" }, 202);
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
  const res = await releaseHold(c.env, c.env.DB, c.req.param("id"), c.get("principal").id);
  if (!res) return deny(c, "legal_hold_management", "release_legal_hold", LH_RELEASE, 404, "not_found");
  const remaining = (await activeHolds(c.env.DB, res.hold.subject_ref)).length;
  await audit(c, { purpose: "legal_hold_management", action: "release_legal_hold", route: LH_RELEASE, subjectRef: res.hold.subject_ref, decision: "allow", reason: "ok", detail: { resubmitted: res.resubmitted.length, remaining_holds: remaining } });
  return c.json({ hold: publicHold(res.hold), resubmitted: res.resubmitted, remainingHolds: remaining });
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

const AUDIT_VERIFY = "/api/v1/privacy/audit/verify";
privacy.get(AUDIT_VERIFY, async (c) => {
  const denied = await authorize(c, "privacy_compliance", "read_audit", AUDIT_VERIFY);
  if (denied) return denied;
  const result = await c.get("audit").verify();
  await audit(c, { purpose: "privacy_compliance", action: "read_audit", route: AUDIT_VERIFY, decision: "allow", reason: "ok", detail: { ok: result.ok, length: result.length } });
  return c.json(result);
});
