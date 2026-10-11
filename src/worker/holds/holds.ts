// Legal holds (SPEC.md section 8.8). Placed and released only by privacy_officer under legal_hold_management.
// While active: deletion stops after check-legal-hold with status held, no suppression entry is written, retention
// skips the subject. Release: if no other active hold covers the subject, every held request is resubmitted as a new
// workflow instance <requestId>-r<n>.
import { startOrDefer } from "../admission.ts";
import { nextInstanceId } from "../requests.ts";

export interface HoldRow {
  id: string;
  matter_id: string;
  subject_ref: string;
  reason: string;
  placed_by: string;
  placed_at: string;
  released_at: string | null;
  released_by: string | null;
}

export async function activeHolds(db: D1Database, subjectRef: string): Promise<HoldRow[]> {
  const { results } = await db.prepare("SELECT * FROM legal_holds WHERE subject_ref = ? AND released_at IS NULL ORDER BY placed_at").bind(subjectRef).all<HoldRow>();
  return results;
}

export async function activeHeldRefs(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT DISTINCT subject_ref FROM legal_holds WHERE released_at IS NULL").all<{ subject_ref: string }>();
  return new Set(results.map((r) => r.subject_ref));
}

export async function placeHold(db: D1Database, h: { matterId: string; subjectRef: string; reason: string; placedBy: string }): Promise<HoldRow> {
  const row: HoldRow = {
    id: `hold-${crypto.randomUUID().slice(0, 8)}`,
    matter_id: h.matterId,
    subject_ref: h.subjectRef,
    reason: h.reason,
    placed_by: h.placedBy,
    placed_at: new Date().toISOString(),
    released_at: null,
    released_by: null,
  };
  await db
    .prepare("INSERT INTO legal_holds (id, matter_id, subject_ref, reason, placed_by, placed_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.matter_id, row.subject_ref, row.reason, row.placed_by, row.placed_at)
    .run();
  return row;
}

export interface ReleaseResult {
  hold: HoldRow;
  resubmitted: string[];
  /** requests over today's admission cap: resubmitted by the daily cron */
  deferred: string[];
}

export async function releaseHold(env: Env, db: D1Database, holdId: string, releasedBy: string, cap: number | null = null): Promise<ReleaseResult | null> {
  const now = new Date().toISOString();
  const hold = await db
    .prepare("UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ? AND released_at IS NULL RETURNING *")
    .bind(now, releasedBy, holdId)
    .first<HoldRow>();
  if (!hold) return null;
  const resubmitted: string[] = [];
  const deferred: string[] = [];
  if ((await activeHolds(db, hold.subject_ref)).length === 0) {
    const { results } = await db
      .prepare("SELECT id, workflow_instance_id FROM deletion_requests WHERE subject_ref = ? AND status = 'held' ORDER BY created_at")
      .bind(hold.subject_ref)
      .all<{ id: string; workflow_instance_id: string | null }>();
    for (const r of results) {
      const instanceId = nextInstanceId(r.id, r.workflow_instance_id);
      await db.prepare("UPDATE deletion_requests SET status = 'received' WHERE id = ? AND status = 'held'").bind(r.id).run();
      const out = await startOrDefer(env, db, r.id, instanceId, cap);
      if (out.deferred) deferred.push(r.id);
      else resubmitted.push(instanceId);
    }
  }
  return { hold, resubmitted, deferred };
}
