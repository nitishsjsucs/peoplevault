// D1 executor_tasks (SPEC.md section 14.2): create, claim with a lease, complete by the lease owner, purge payloads.
import { z } from "zod";

export type Phase = "erase" | "identity" | "retention";
export type WorkflowBinding = "DELETION" | "RETENTION";

export interface ExecutorTask {
  id: string;
  phase: Phase;
  eventType: string;
  workflow: WorkflowBinding;
  instanceId: string;
  requestId: string | null;
  runId: string | null;
  payload: unknown;
}

interface TaskRow {
  id: string;
  request_id: string | null;
  run_id: string | null;
  workflow: WorkflowBinding;
  instance_id: string;
  phase: Phase;
  event_type: string;
  payload_json: string | null;
  status: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  result_json: string | null;
}

const IDENTIFIER_LIKE = [/@/, /\s/, /\bE\d{5}\b/i, /(wk|er|an|sr)_[a-z2-7]{26}/];
/** Strings in executor results: asset ids, table and file locations, enums, snapshot ids and timestamps only. */
const SafeString = z
  .string()
  .max(300)
  .refine((s) => IDENTIFIER_LIKE.every((re) => !re.test(s)), "identifier-like value");
const Count = z.number().int().min(0);

const PartResult = z.object({ rows_before: Count, rows_erased: Count, refs_scrubbed: Count, verify_matches: Count.optional() }).strict();
const AssetResult = z
  .object({
    asset_id: SafeString,
    applicability: z.enum(["present", "not_present", "aggregate_recompute", "held", "unregistered"]),
    rows_before: Count,
    rows_erased: Count,
    references_scrubbed: Count,
    action_status: z.enum(["erased", "recomputed", "skipped_hold", "failed"]),
    verify_status: z.enum(["clean", "residue", "error", "not_applicable"]),
    verify_matches: Count,
    parts: z.record(SafeString, PartResult).optional(),
    recomputed: z.boolean().optional(),
  })
  .strict();
const Finding = z.object({ store: z.enum(["warehouse", "iceberg"]), location: SafeString, asset_id: SafeString.nullable(), matches: Count }).strict();
const ResidualMeta = z
  .object({
    kind: z.enum(["iceberg_snapshots", "iceberg_orphan_files", "bq_time_travel", "bq_fail_safe"]),
    asset_id: SafeString,
    table: SafeString,
    state: z.enum(["pending", "cleared", "modeled", "error"]),
    evidence: z.enum(["observed", "modeled"]),
    deleted_at: SafeString,
    expected_clear_at: SafeString.nullable(),
    snapshot_id: z.union([Count, SafeString]).nullable().optional(),
    retained_snapshots: Count.optional(),
    data_files: z.array(SafeString).max(200).optional(),
    rows_at_erase: Count.optional(),
  })
  .strict();

export const ExecutorResult = z
  .object({
    assets: z.array(AssetResult).max(50).default([]),
    findings: z.array(Finding).max(200).default([]),
    residuals: z.array(ResidualMeta).max(50).default([]),
    counts: z.record(SafeString, Count).default({}),
    error: SafeString.nullable().optional(),
  })
  .strict();
export type ExecutorResult = z.infer<typeof ExecutorResult>;

function toTask(r: TaskRow): ExecutorTask {
  return {
    id: r.id,
    phase: r.phase,
    eventType: r.event_type,
    workflow: r.workflow,
    instanceId: r.instance_id,
    requestId: r.request_id,
    runId: r.run_id,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
  };
}

export class TaskError extends Error {
  override name = "TaskError";
  readonly code: "not_found" | "not_lease_owner" | "not_leased";
  constructor(code: "not_found" | "not_lease_owner" | "not_leased") {
    super(code);
    this.code = code;
  }
}

export interface TaskStore {
  create(t: { id: string; phase: Phase; eventType: string; workflow: WorkflowBinding; instanceId: string; requestId?: string; runId?: string; payload: unknown }): Promise<void>;
  claim(executorId: string, phases: Phase[], max: number, leaseSeconds: number, now?: Date): Promise<ExecutorTask[]>;
  complete(id: string, executorId: string, ok: boolean, result: ExecutorResult, now?: Date): Promise<ExecutorTask>;
  purgePayloads(requestId: string): Promise<number>;
  get(id: string): Promise<(ExecutorTask & { status: string; result: ExecutorResult | null }) | null>;
}

export function createTaskStore(db: D1Database): TaskStore {
  return {
    async create(t) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT OR IGNORE INTO executor_tasks (id, request_id, run_id, workflow, instance_id, phase, event_type, payload_json, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .bind(t.id, t.requestId ?? null, t.runId ?? null, t.workflow, t.instanceId, t.phase, t.eventType, JSON.stringify(t.payload), now, now)
        .run();
    },

    async claim(executorId, phases, max, leaseSeconds, now = new Date()) {
      const nowIso = now.toISOString();
      const until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
      const inList = phases.map((_, i) => `?${5 + i}`).join(", ");
      const { results } = await db
        .prepare(
          `UPDATE executor_tasks SET status = 'leased', lease_owner = ?1, lease_expires_at = ?2, attempts = attempts + 1, updated_at = ?3
           WHERE id IN (SELECT id FROM executor_tasks WHERE phase IN (${inList})
                        AND (status = 'pending' OR (status = 'leased' AND lease_expires_at < ?3)) ORDER BY created_at LIMIT ?4)
           RETURNING *`,
        )
        .bind(executorId, until, nowIso, max, ...phases)
        .all<TaskRow>();
      return results.sort((a, b) => a.id.localeCompare(b.id)).map(toTask);
    },

    async complete(id, executorId, ok, result, now = new Date()) {
      const row = await db
        .prepare(
          `UPDATE executor_tasks SET status = ?1, result_json = ?2, updated_at = ?3, lease_expires_at = NULL
           WHERE id = ?4 AND lease_owner = ?5 AND status = 'leased' RETURNING *`,
        )
        .bind(ok ? "done" : "failed", JSON.stringify(result), now.toISOString(), id, executorId)
        .first<TaskRow>();
      if (row) return toTask(row);
      const existing = await db.prepare("SELECT status, lease_owner FROM executor_tasks WHERE id = ?").bind(id).first<{ status: string; lease_owner: string | null }>();
      if (!existing) throw new TaskError("not_found");
      if (existing.lease_owner !== executorId) throw new TaskError("not_lease_owner");
      throw new TaskError("not_leased");
    },

    async purgePayloads(requestId) {
      const res = await db.prepare("UPDATE executor_tasks SET payload_json = NULL WHERE request_id = ?").bind(requestId).run();
      return res.meta.changes;
    },

    async get(id) {
      const row = await db.prepare("SELECT * FROM executor_tasks WHERE id = ?").bind(id).first<TaskRow>();
      if (!row) return null;
      return { ...toTask(row), status: row.status, result: row.result_json ? (JSON.parse(row.result_json) as ExecutorResult) : null };
    },
  };
}
