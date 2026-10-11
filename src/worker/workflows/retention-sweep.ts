// RetentionSweepWorkflow (SPEC.md section 14.5). Instance id retention-<as_of> or retention-<as_of>-max<N>.
// Objects past retention are deleted, or minimized to held subjects' rows when they contain any, through the same
// etag compare-and-swap rewrite as deletion, so a concurrent deletion and a minimization never overwrite each other.
// Workers Free (SPEC.md section 30.3.1): export expiry advances through byte-capped steps `expire-r2-<n>` with the
// same line prefilter as erasure (only lines that contain a held subject's id are parsed). Expiry deletes objects,
// so its cursor is the last basis date handled in the current part (a date, never a key), not a listing digest.
// Terminated employees past 3 years become subject deletion requests through the Queue (held ones are recorded held).
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { asset } from "../assets/registry.ts";
import { createAuditLog } from "../audit/audit-log.ts";
import { loadConfig } from "../env.ts";
import { transformRows } from "../erase/jsonl-objects.ts";
import { ExecutorResult, createTaskStore, type ExecutorResult as ExecutorResultT } from "../executor/task-store.ts";
import { activeHeldRefs } from "../holds/holds.ts";
import { POLICY } from "../policy/compiled.ts";
import { remainingToday } from "../admission.ts";
import { MAX_CURSOR_STEPS, listSorted, registeredR2Parts } from "../erase/r2-cursor.ts";
import { rewriteObject } from "../storage/r2-rewrite.ts";
import { newCounter, withOpBudget } from "../storage/op-budget.ts";
import { cutoffFor, exportBasisDate, isPast, minusDays, minusYears, monthEnd } from "../retention/rules.ts";
import { STEP_CONFIG } from "./subject-deletion.ts";

export interface RetentionParams {
  asOf: string;
  maxSubjects?: number;
}

/** Queue message: the request to start, and the instance id when it is not the request id (a deferred retry). */
export interface SweepMessage {
  requestId: string;
  instanceId?: string;
}

async function heldIdentity(db: D1Database): Promise<{ ids: Set<string>; analytics: Set<string> }> {
  const refs = [...(await activeHeldRefs(db))];
  if (refs.length === 0) return { ids: new Set(), analytics: new Set() };
  const { results } = await db.prepare(`SELECT employee_id, analytics_id FROM identity_map WHERE subject_ref IN (${refs.map(() => "?").join(", ")})`).bind(...refs).all<{ employee_id: string; analytics_id: string }>();
  return { ids: new Set(results.map((r) => r.employee_id)), analytics: new Set(results.map((r) => r.analytics_id)) };
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<{ key: string; meta: Record<string, string> }[]> {
  const out: { key: string; meta: Record<string, string> }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    out.push(...page.objects.map((o) => ({ key: o.key, meta: o.customMetadata ?? {} })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Deletes an object past retention, or minimizes it to rows of held subjects (both etag-conditional). */
export async function expireObject(bucket: R2Bucket, key: string, format: "jsonl" | "csv", subjectColumn: string, held: Set<string>, runId: string) {
  return rewriteObject(
    bucket,
    key,
    (body) => {
      const t = transformRows(body, format, {
        remove: (row) => !held.has(String(row[subjectColumn])),
        refColumns: [],
        refValue: null,
        prefilter: { needles: [...held], unmatched: "remove" },
      });
      const keptRows = body.split("\n").filter((l) => l.trim()).length - (format === "csv" ? 1 : 0) - t.rowsRemoved;
      return keptRows > 0 ? t : { body: null, rowsRemoved: t.rowsRemoved, refsScrubbed: 0 };
    },
    { metadata: { pv_minimized_by: runId } },
  );
}

/**
 * Which eligible subjects (already in employee id order) this sweep turns into requests: held ones always (recorded
 * `held`), and at most min(max_subjects, RETENTION_DAILY_MAX, today's remaining admissions) others, in order.
 */
export function planRetentionSubjects<T extends { subject_ref: string }>(
  eligible: T[],
  held: ReadonlySet<string>,
  caps: { maxSubjects: number | null; retentionDailyMax: number | null; remaining: number | null },
): { newRows: T[]; heldRows: T[] } {
  const limit = Math.min(caps.maxSubjects ?? Infinity, caps.retentionDailyMax ?? Infinity, caps.remaining ?? Infinity);
  const heldRows = eligible.filter((r) => held.has(r.subject_ref));
  const others = eligible.filter((r) => !held.has(r.subject_ref));
  return { newRows: Number.isFinite(limit) ? others.slice(0, Math.max(0, limit)) : others, heldRows };
}

/** Export expiry cursor: the part index and the last basis date handled in it. */
export interface ExpiryCursor {
  part: number;
  after: string | null;
}

/** One expiry step over the export parts: whole basis-date groups of past-retention objects until the byte cap. */
async function expireStep(e: Env, asOf: string, from: ExpiryCursor, capBytes: number, held: Set<string>, runId: string) {
  const parts = registeredR2Parts().filter((p) => p.binding === "EXPORTS");
  let c = { ...from };
  let bytes = 0;
  let objects = 0;
  let deleted = 0;
  let minimized = 0;
  let rowsRemoved = 0;
  while (c.part < parts.length) {
    const ref = parts[c.part]!;
    const cutoff = cutoffFor(ref.part, asOf);
    const due = cutoff
      ? (await listSorted(e.EXPORTS, ref.part.location ?? ""))
          .map((o) => ({ ...o, basis: exportBasisDate(o.key) }))
          .filter((o): o is typeof o & { basis: string } => !!o.basis && isPast(o.basis, cutoff) && (c.after === null || o.basis > c.after))
          .sort((a, b) => (a.basis === b.basis ? (a.key < b.key ? -1 : 1) : a.basis < b.basis ? -1 : 1))
      : [];
    for (const basis of [...new Set(due.map((o) => o.basis))]) {
      const group = due.filter((o) => o.basis === basis);
      const size = group.reduce((n, o) => n + o.size, 0);
      if (objects > 0 && bytes + size > capBytes) return { cursor: c, done: false, deleted, minimized, rowsRemoved, objects };
      for (const o of group) {
        const r = await expireObject(e.EXPORTS, o.key, ref.part.format ?? "jsonl", "employee_id", held, runId);
        if (r.deleted) deleted++;
        else if (r.changed) minimized++;
        rowsRemoved += r.rowsRemoved;
      }
      bytes += size;
      objects += group.length;
      c = { ...c, after: basis };
    }
    c = { part: c.part + 1, after: null };
  }
  return { cursor: c, done: true, deleted, minimized, rowsRemoved, objects };
}

export class RetentionSweepWorkflow extends WorkflowEntrypoint<Env, RetentionParams> {
  override async run(event: WorkflowEvent<RetentionParams>, step: WorkflowStep): Promise<unknown> {
    const { asOf, maxSubjects } = event.payload;
    const runId = event.instanceId;
    const cfg = loadConfig(this.env);
    const env = this.env;
    const counted = async <T extends Record<string, unknown>>(fn: (e: Env) => Promise<T>): Promise<T & { ops: number }> => {
      const counter = newCounter();
      const out = await fn(withOpBudget(env, counter));
      return { ...out, ops: counter.total() };
    };
    const startedAt = new Date().toISOString();

    const holds = await step.do("load-holds", STEP_CONFIG, () =>
      counted(async (e) => {
        await e.DB.prepare("INSERT OR IGNORE INTO retention_runs (id, as_of, started_at, status) VALUES (?, ?, ?, 'running')").bind(runId, asOf, startedAt).run();
        return { heldSubjects: (await activeHeldRefs(e.DB)).size };
      }),
    );

    const exportsOut = { deleted: 0, minimized: 0, rowsRemoved: 0 };
    let expiry: ExpiryCursor = { part: 0, after: null };
    for (let n = 1, done = false; !done; n++) {
      if (n > MAX_CURSOR_STEPS) throw new Error("expiry cursor did not finish");
      const from = expiry;
      const out = await step.do(`expire-r2-${n}`, STEP_CONFIG, () =>
        counted(async (e) => {
          const held = await heldIdentity(e.DB);
          return await expireStep(e, asOf, from, cfg.r2EraseStepBytes, held.ids, runId);
        }),
      );
      exportsOut.deleted += out.deleted;
      exportsOut.minimized += out.minimized;
      exportsOut.rowsRemoved += out.rowsRemoved;
      expiry = out.cursor;
      done = out.done;
    }

    const extractsOut = await step.do("expire-r2-extracts", STEP_CONFIG, () =>
      counted(async (e) => {
        const held = await heldIdentity(e.DB);
        const part = asset("drv.r2.analytics_extracts").parts[0]!;
        const cutoff = minusDays(asOf, part.retention?.days ?? 90);
        let deleted = 0;
        let minimized = 0;
        for (const { key, meta } of await listKeys(e.DERIVED, part.location ?? "")) {
          const month = meta.month ?? /month=(\d{4}-\d{2})/.exec(key)?.[1];
          if (!month || !isPast(monthEnd(month), cutoff)) continue;
          const r = await expireObject(e.DERIVED, key, "jsonl", "analytics_id", held.analytics, runId);
          if (r.deleted) deleted++;
          else if (r.changed) minimized++;
        }
        return { deleted, minimized };
      }),
    );

    await step.do("enqueue-executor-retention", STEP_CONFIG, () =>
      counted(async (e) => {
        const cutoffs: Record<string, string> = {};
        for (const part of asset("wh.raw").parts) {
          const c = cutoffFor(part, asOf);
          if (c) cutoffs[part.name] = c;
        }
        const lakePart = asset("hist.lake.employee_monthly").parts[0]!;
        await createTaskStore(e.DB).create({
          id: `${runId}:rows`,
          phase: "retention",
          eventType: "executor_result_retention",
          workflow: "RETENTION",
          instanceId: runId,
          runId,
          payload: { runId, asOf, rawCutoffs: cutoffs, lakeCutoff: cutoffFor(lakePart, asOf), heldSubjectRefs: [...(await activeHeldRefs(e.DB))].sort() },
        });
        return { queued: true };
      }),
    );

    const rowsEvent = await step.waitForEvent<{ taskId: string; ok: boolean; result: ExecutorResultT }>("wait-executor-retention", {
      type: "executor_result_retention",
      timeout: cfg.executorWaitTimeout as `${number} ${"second" | "minute" | "hour" | "day"}s`,
    });

    // Terminated subjects past retention become retention requests (SPEC.md sections 14.5 and 30.3.4): in employee id
    // order, at most max_subjects (when set), RETENTION_DAILY_MAX and today's remaining admission cap of new ones; held
    // subjects are recorded `held` without a cap. One INSERT OR IGNORE for all of them (an ignored row is a subject
    // with another active request, counted already_active), so the step's D1 statements stay constant.
    const subjects = await step.do("enqueue-retention-subjects", STEP_CONFIG, () =>
      counted(async (e) => {
        const cutoff = minusYears(asOf, POLICY.retention.terminated_subject_years);
        const { results } = await e.DB.prepare(
          "SELECT employee_id, subject_ref FROM identity_map WHERE employment_status = 'terminated' AND termination_date IS NOT NULL AND termination_date <= ? ORDER BY employee_id",
        )
          .bind(cutoff)
          .all<{ employee_id: string; subject_ref: string }>();
        const held = await activeHeldRefs(e.DB);
        const now = new Date();
        const remaining = await remainingToday(e.DB, cfg.dailyDeletionStarts, now);
        const { newRows, heldRows } = planRetentionSubjects(results, held, { maxSubjects: maxSubjects ?? null, retentionDailyMax: cfg.retentionDailyMax, remaining });
        const rows = [
          ...newRows.map((r) => ({ id: `${runId}-${r.subject_ref.slice(3, 15)}`, subject_ref: r.subject_ref, employee_id: r.employee_id, status: "received", admitted_at: now.toISOString() })),
          ...heldRows.map((r) => ({ id: `${runId}-${r.subject_ref.slice(3, 15)}`, subject_ref: r.subject_ref, employee_id: r.employee_id, status: "held", admitted_at: null })),
        ];
        let mine = new Set<string>();
        if (rows.length > 0) {
          await e.DB.prepare(
            `INSERT OR IGNORE INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at, admitted_at)
             SELECT json_extract(value, '$.id'), 'retention', json_extract(value, '$.subject_ref'), json_extract(value, '$.employee_id'), json_extract(value, '$.status'),
                    'retention-sweep', ?2, json_extract(value, '$.admitted_at')
             FROM json_each(?1)`,
          )
            .bind(JSON.stringify(rows), now.toISOString())
            .run();
          // rows of this run: inserted now or by an earlier attempt of this step; the others hit the one-active index
          const { results: present } = await e.DB.prepare("SELECT id FROM deletion_requests WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))")
            .bind(JSON.stringify(rows))
            .all<{ id: string }>();
          mine = new Set(present.map((r) => r.id));
        }
        const queued = rows.filter((r) => r.status === "received" && mine.has(r.id));
        const heldRecorded = rows.filter((r) => r.status === "held" && mine.has(r.id)).length;
        const messages: { body: SweepMessage }[] = queued.map((r) => ({ body: { requestId: r.id } }));
        for (let i = 0; i < messages.length; i += 100) await e.SWEEP_QUEUE.sendBatch(messages.slice(i, i + 100));
        return {
          eligible: results.length,
          queued: queued.length,
          held: heldRecorded,
          alreadyActive: rows.length - queued.length - heldRecorded,
          capped: results.length - heldRows.length - newRows.length,
        };
      }),
    );

    return await step.do("record-run", STEP_CONFIG, () =>
      counted(async (e) => {
        const parsed = ExecutorResult.safeParse(rowsEvent.payload.result);
        const summary = {
          asOf,
          maxSubjects: maxSubjects ?? null,
          heldSubjects: holds.heldSubjects,
          exportObjectsDeleted: exportsOut.deleted,
          exportObjectsMinimized: exportsOut.minimized,
          extractsDeleted: extractsOut.deleted,
          extractsMinimized: extractsOut.minimized,
          executorOk: rowsEvent.payload.ok && parsed.success,
          executorCounts: parsed.success ? parsed.data.counts : {},
          retentionRequests: subjects.queued,
          retentionHeld: subjects.held,
          alreadyActive: subjects.alreadyActive,
        };
        const status = summary.executorOk ? "completed" : "failed";
        await e.DB.prepare("UPDATE retention_runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?").bind(new Date().toISOString(), status, JSON.stringify(summary), runId).run();
        await createAuditLog(e.DB).append({
          actor: "retention-sweep",
          actorKind: "system",
          action: "retention_run",
          decision: "info",
          reason: status,
          detail: { export_deleted: summary.exportObjectsDeleted, export_minimized: summary.exportObjectsMinimized, extracts_deleted: summary.extractsDeleted, requests: summary.retentionRequests, held: summary.retentionHeld },
        });
        return { status, ...summary };
      }),
    );
  }
}
