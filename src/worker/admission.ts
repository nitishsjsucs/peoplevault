// Daily admission, reconcile and instance starts (SPEC.md section 30.3.4). Workers Free allows 3,000 Workflow steps per
// day per account, shared by four repos, so production starts at most DAILY_DELETION_STARTS deletion instances per
// UTC day (16; a completed deletion takes 30 steps). Every start goes through admit(): DSRs, retries, hold releases,
// retention requests and re-sent requests alike. A request over the cap stays `received` with admitted_at NULL
// (deferred); the daily cron re-admits deferred requests, and requests admitted more than 6 hours ago that are still
// `received` (their instance was never created, for example a message lost after Free's fixed 24-hour queue
// retention), oldest first, before the retention sweep. Locally the cap is unlimited.
import { INSTANCE_RETENTION, nextInstanceId } from "./requests.ts";

export const ORPHAN_AFTER_MS = 6 * 3_600_000;

export function utcDayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export function utcDayEnd(now: Date): string {
  return utcDayStart(new Date(Date.parse(utcDayStart(now)) + 86_400_000));
}

/** Requests admitted on the current UTC day. */
export async function admittedToday(db: D1Database, now = new Date()): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM deletion_requests WHERE admitted_at >= ? AND admitted_at < ?").bind(utcDayStart(now), utcDayEnd(now)).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Admissions left today; null when unlimited. */
export async function remainingToday(db: D1Database, cap: number | null, now = new Date()): Promise<number | null> {
  return cap === null ? null : Math.max(0, cap - (await admittedToday(db, now)));
}

/** Admits one request atomically (one statement): sets admitted_at when today's admissions are under the cap. */
export async function admit(db: D1Database, requestId: string, cap: number | null, now = new Date(), instanceId?: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE deletion_requests SET admitted_at = ?2, workflow_instance_id = COALESCE(?5, workflow_instance_id)
       WHERE id = ?1 AND status = 'received' AND (?3 IS NULL OR (SELECT COUNT(*) FROM deletion_requests WHERE admitted_at >= ?4 AND admitted_at < ?6) < ?3)`,
    )
    .bind(requestId, now.toISOString(), cap, utcDayStart(now), instanceId ?? null, utcDayEnd(now))
    .run();
  return res.meta.changes === 1;
}

export interface StartOutcome {
  deferred: boolean;
  instanceId: string | null;
}

/**
 * Starts a deletion instance for a request in `received` when it is admitted today, else defers it (admitted_at NULL).
 * The workflow_instance_id is written before the instance is created, so the instance's load-request finds itself.
 */
export async function startOrDefer(env: Env, db: D1Database, requestId: string, instanceId: string, cap: number | null, now = new Date()): Promise<StartOutcome> {
  if (await admit(db, requestId, cap, now, instanceId)) {
    await env.DELETION.create({ id: instanceId, params: { requestId }, retention: INSTANCE_RETENTION });
    return { deferred: false, instanceId };
  }
  await db.prepare("UPDATE deletion_requests SET admitted_at = NULL WHERE id = ?").bind(requestId).run();
  return { deferred: true, instanceId: null };
}

export interface ReconcileOutcome {
  admitted: { requestId: string; instanceId: string }[];
  /** true when deferred or orphaned requests remain for a later day */
  more: boolean;
}

/**
 * The cron's first task: admits deferred requests and orphaned ones (admitted more than 6 hours ago, still `received`)
 * oldest first up to today's remaining cap, and sends them through the queue, whose consumer creates the instances
 * (createBatch acks ids that already exist). A deferred request with an earlier instance gets the next instance id
 * (`<id>-r<n>`); an orphan keeps its id.
 */
export async function reconcileReceived(env: Env, cap: number | null, now = new Date()): Promise<ReconcileOutcome> {
  const db = env.DB;
  const remaining = await remainingToday(db, cap, now);
  const limit = remaining === null ? 1000 : remaining;
  const { results } = await db
    .prepare(
      `SELECT id, workflow_instance_id, admitted_at FROM deletion_requests
       WHERE status = 'received' AND (admitted_at IS NULL OR admitted_at < ?1)
       ORDER BY COALESCE(admitted_at, created_at), created_at, id LIMIT ?2`,
    )
    .bind(new Date(now.getTime() - ORPHAN_AFTER_MS).toISOString(), limit + 1)
    .all<{ id: string; workflow_instance_id: string | null; admitted_at: string | null }>();
  const picked = results.slice(0, limit);
  const plan = picked.map((r) => ({
    requestId: r.id,
    instanceId: r.admitted_at === null ? (r.workflow_instance_id ? nextInstanceId(r.id, r.workflow_instance_id) : r.id) : (r.workflow_instance_id ?? r.id),
  }));
  const admitted: ReconcileOutcome["admitted"] = [];
  if (plan.length > 0) {
    const res = await db.batch(
      plan.map((p) =>
        db
          .prepare(
            `UPDATE deletion_requests SET admitted_at = ?2, workflow_instance_id = ?3
             WHERE id = ?1 AND status = 'received' AND (?4 IS NULL OR (SELECT COUNT(*) FROM deletion_requests WHERE admitted_at >= ?5 AND admitted_at < ?6) < ?4)`,
          )
          .bind(p.requestId, now.toISOString(), p.instanceId, cap, utcDayStart(now), utcDayEnd(now)),
      ),
    );
    res.forEach((r, i) => {
      if (r.meta.changes === 1) admitted.push(plan[i]!);
    });
    for (let i = 0; i < admitted.length; i += 100) await env.SWEEP_QUEUE.sendBatch(admitted.slice(i, i + 100).map((a) => ({ body: a })));
  }
  return { admitted, more: results.length > admitted.length };
}
