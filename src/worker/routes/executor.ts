// Executor API (SPEC.md sections 13 and 14.2). System principal only. Results are validated so that they carry
// only asset ids, counts, enums, snapshot ids and timestamps: identifiers cannot leak into D1 or Workflow events.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AuditExportQuery, ClaimBody } from "../../shared/api-schemas.ts";
import type { AppEnv } from "../app.ts";
import { audit, errorJson } from "../context.ts";
import { AUDIT_EXPORT_PAGE_MAX, exportColumns, type AuditExportRecord } from "../audit/audit-export.ts";
import { ExecutorResult, TaskError, createTaskStore } from "../executor/task-store.ts";
import { decide, type Action } from "../policy/pdp.ts";

export const executor = new Hono<AppEnv>();

async function authorize(c: Context<AppEnv>, action: Action, route: string): Promise<Response | null> {
  const d = decide({ principal: c.get("principal"), action });
  if (d.allow) return null;
  await audit(c, { action, route, decision: "deny", reason: d.reason });
  return c.json({ error: "forbidden", code: d.reason }, 403);
}

const CLAIM = "/api/v1/executor/tasks/claim";
executor.post(CLAIM, async (c) => {
  const denied = await authorize(c, "executor_claim", CLAIM);
  if (denied) return denied;
  const body = ClaimBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!body.success) return errorJson(c, 400, "invalid_body");
  const tasks = await createTaskStore(c.env.DB).claim(c.get("principal").id, body.data.phases, body.data.max, body.data.lease_seconds);
  if (tasks.length > 0) await audit(c, { action: "executor_claim", route: CLAIM, decision: "allow", reason: "ok", rowCount: tasks.length });
  return c.json({ tasks });
});

const CompleteBody = z.object({ ok: z.boolean(), result: ExecutorResult }).strict();
const COMPLETE = "/api/v1/executor/tasks/:id/complete";
executor.post(COMPLETE, async (c) => {
  const denied = await authorize(c, "executor_complete", COMPLETE);
  if (denied) return denied;
  const body = CompleteBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    await audit(c, { action: "executor_complete", route: COMPLETE, decision: "deny", reason: "invalid_result" });
    return errorJson(c, 400, "invalid_result");
  }
  const id = c.req.param("id");
  let task;
  try {
    task = await createTaskStore(c.env.DB).complete(id, c.get("principal").id, body.data.ok, body.data.result);
  } catch (e) {
    if (e instanceof TaskError) return errorJson(c, e.code === "not_found" ? 404 : 409, e.code);
    throw e;
  }
  const instance = await c.env[task.workflow].get(task.instanceId);
  await instance.sendEvent({ type: task.eventType, payload: { taskId: task.id, ok: body.data.ok, result: body.data.result } });
  await audit(c, { action: "executor_complete", route: COMPLETE, requestId: task.requestId, decision: "allow", reason: body.data.ok ? "ok" : "executor_failed" });
  return c.json({ ok: true });
});

const SUPPRESSION = "/api/v1/executor/suppression";
executor.get(SUPPRESSION, async (c) => {
  const denied = await authorize(c, "executor_suppression", SUPPRESSION);
  if (denied) return denied;
  const { results } = await c.env.DB.prepare("SELECT subject_ref FROM suppression_list ORDER BY subject_ref").all<{ subject_ref: string }>();
  return c.json({ subjectRefs: results.map((r) => r.subject_ref) });
});

const RESIDUALS = "/api/v1/executor/residuals";
const ResidualUpdate = z
  .array(z.object({ id: z.string().regex(/^[a-z0-9:_.-]{1,120}$/), state: z.enum(["pending", "cleared", "modeled", "error"]), evidence: z.enum(["observed", "modeled"]), clearedAt: z.string().datetime().optional() }).strict())
  .max(500);
executor.post(RESIDUALS, async (c) => {
  const denied = await authorize(c, "executor_complete", RESIDUALS);
  if (denied) return denied;
  const body = ResidualUpdate.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return errorJson(c, 400, "invalid_body");
  let changed = 0;
  for (const u of body.data) {
    const res = await c.env.DB.prepare("UPDATE residuals SET state = ?, evidence = ?, cleared_at = ? WHERE id = ?").bind(u.state, u.evidence, u.clearedAt ?? null, u.id).run();
    changed += res.meta.changes;
  }
  await audit(c, { action: "executor_complete", route: RESIDUALS, decision: "allow", reason: "residuals_updated", rowCount: changed });
  return c.json({ updated: changed });
});

executor.get(RESIDUALS, async (c) => {
  const denied = await authorize(c, "executor_claim", RESIDUALS);
  if (denied) return denied;
  const state = c.req.query("state") ?? "pending";
  const { results } = await c.env.DB.prepare("SELECT id, request_id, asset_id, kind, state, evidence, expected_clear_at, cleared_at, detail_json FROM residuals WHERE state = ? ORDER BY id").bind(state).all();
  return c.json({ residuals: results });
});

// Audit copy (SPEC.md section 30.3.3): rows after `after_seq` in seq order, exactly the 16 fields of the Iceberg
// schema, at most 500 per page, plus the chain head. One D1 batch and one audit event per page.
const AUDIT_EXPORT = "/api/v1/executor/audit-export";
executor.get(AUDIT_EXPORT, async (c) => {
  const denied = await authorize(c, "executor_audit_export", AUDIT_EXPORT);
  if (denied) return denied;
  const q = AuditExportQuery.safeParse({ after_seq: c.req.query("after_seq") ?? "0", limit: c.req.query("limit") ?? String(AUDIT_EXPORT_PAGE_MAX) });
  if (!q.success) return errorJson(c, 400, "invalid_query");
  const [page, head] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${exportColumns()} FROM audit_events WHERE seq > ? ORDER BY seq LIMIT ?`).bind(q.data.after_seq, q.data.limit),
    c.env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM audit_events"),
  ]);
  const rows = page!.results as AuditExportRecord[];
  const headSeq = (head!.results[0] as { head: number }).head;
  await audit(c, { action: "executor_audit_export", route: AUDIT_EXPORT, decision: "allow", reason: "ok", rowCount: rows.length });
  return c.json({ rows, headSeq, nextAfterSeq: rows.length ? rows[rows.length - 1]!.seq : q.data.after_seq, complete: rows.length < q.data.limit });
});
