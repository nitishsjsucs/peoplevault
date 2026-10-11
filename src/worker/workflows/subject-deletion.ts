// SubjectDeletionWorkflow (SPEC.md sections 14.1 and 30.3.1). Instance id = request id (retries: <requestId>-r<n>).
// Step outputs hold counts, asset ids, booleans, indexes, digests and timestamps only, never identifiers or keys:
// identifiers are loaded from D1 inside each step that needs them, and probe findings are written to D1 inside the
// probe steps. Worker-native assets (R2, KV, D1) are erased and probed here; Python-native assets (warehouse,
// Iceberg) by the executor, bridged by D1 task rows and Workflow events (ADR 0001).
//
// Workers Free (ADR 0007): every step stays under 10 ms of CPU. R2 erasure and the R2 probe advance through
// byte-capped cursor steps (`erase-r2-<n>`, `verify-r2-<n>`; R2_ERASE_STEP_BYTES and R2_PROBE_STEP_BYTES), erasure
// parses only lines that contain the subject's id, and plan-time discovery of R2 and KV is merged into the erase
// steps (applicability comes from what each rewrite removed and scrubbed). The instance output counts the steps.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { asset, ASSETS, PYTHON_ASSETS } from "../assets/registry.ts";
import { loadSubject, type SubjectIdentifiers } from "../assets/subject.ts";
import { createAuditLog } from "../audit/audit-log.ts";
import { auditStreamFor, withAuditStream } from "../audit/audit-stream.ts";
import { buildReceipt, isApplicable } from "../audit/receipts.ts";
import { loadConfig } from "../env.ts";
import { countIdentityRecords, eraseIdentityRecords } from "../erase/d1-identity.ts";
import { eraseObject } from "../erase/jsonl-objects.ts";
import { eraseKvCaches } from "../erase/kv-cache.ts";
import { CURSOR_START, MAX_CURSOR_STEPS, registeredR2Parts, walkParts, type ListingCursor } from "../erase/r2-cursor.ts";
import { ExecutorResult, createTaskStore, type ExecutorResult as ExecutorResultT } from "../executor/task-store.ts";
import { activeHeldRefs, activeHolds } from "../holds/holds.ts";
import { POLICY } from "../policy/compiled.ts";
import { addDays, D1_TIME_TRAVEL_DAYS, recordResiduals, type ResidualInput } from "../residuals/residuals.ts";
import { newCounter, withOpBudget } from "../storage/op-budget.ts";
import { probeD1, type D1Stage } from "../verify/d1-probe.ts";
import { probeKv } from "../verify/kv-probe.ts";
import { PROBE_START, probeR2Step, type ProbeCursor } from "../verify/r2-probe.ts";
import { subjectMatchers } from "../verify/tokens.ts";
import { readResults, recordProbe, toUpsert, unregisteredRow, upsertResults, WORKER_PROBED, type ProbeFindingState, type ResultUpsert } from "./results.ts";

export interface DeletionParams {
  requestId: string;
}

export const STEP_CONFIG = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;

async function updateResult(db: D1Database, requestId: string, assetId: string, patch: Partial<Record<"action_status" | "verify_status" | "verify_matches" | "rows_erased" | "references_scrubbed" | "finding_json", unknown>>): Promise<void> {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const sets = cols.map((c, i) => `${c} = ?${i + 3}`).join(", ");
  await db
    .prepare(`UPDATE deletion_asset_results SET ${sets}, verified_at = ?${cols.length + 3} WHERE request_id = ?1 AND asset_id = ?2`)
    .bind(requestId, assetId, ...cols.map((c) => patch[c as keyof typeof patch] ?? null), new Date().toISOString())
    .run();
}

async function heldEmployeeIds(db: D1Database): Promise<Set<string>> {
  const refs = [...(await activeHeldRefs(db))];
  if (refs.length === 0) return new Set();
  const { results } = await db.prepare(`SELECT employee_id FROM identity_map WHERE subject_ref IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(refs)).all<{ employee_id: string }>();
  return new Set(results.map((r) => r.employee_id));
}

/** Counts each step the instance runs (do, sleep, waitForEvent), for the instance output and the step budget tests.
 * The step object can be an RPC stub, so methods are called on it directly (never through apply or bind). */
export function countingStep(step: WorkflowStep, onStep: () => void): WorkflowStep {
  const call = (name: "do" | "sleep" | "sleepUntil" | "waitForEvent") => (...args: unknown[]) => {
    onStep();
    return (step as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
  };
  return { do: call("do"), sleep: call("sleep"), sleepUntil: call("sleepUntil"), waitForEvent: call("waitForEvent") } as unknown as WorkflowStep;
}

type PartCounts = Record<string, { rows_before: number; rows_erased: number; refs_scrubbed: number; objects_rewritten: number }>;

export class SubjectDeletionWorkflow extends WorkflowEntrypoint<Env, DeletionParams> {
  override async run(event: WorkflowEvent<DeletionParams>, stepIn: WorkflowStep): Promise<unknown> {
    const requestId = event.payload.requestId;
    const instanceId = event.instanceId;
    const cfg = loadConfig(this.env);
    const env = this.env;
    const db = env.DB;
    let steps = 0;
    const step = countingStep(stepIn, () => steps++);

    // Runs `fn` with a counting wrapper over KV, R2 and D1 and returns its output plus the step's counts: calls (`ops`),
    // D1 statements and decoded R2 bytes (SPEC.md section 30.3.1).
    const counted = async <T extends Record<string, unknown>>(fn: (e: Env) => Promise<T>): Promise<T & { ops: number; d1Statements: number; r2Bytes: number }> => {
      const counter = newCounter();
      const out = await fn(withOpBudget(env, counter));
      return { ...out, ops: counter.total(), d1Statements: counter.d1Statements, r2Bytes: counter.r2Bytes };
    };

    const startedAt = await step.do("load-request", STEP_CONFIG, async () => {
      const r = await db.prepare("SELECT status, created_at FROM deletion_requests WHERE id = ?").bind(requestId).first<{ status: string; created_at: string }>();
      if (!r) throw new Error("request not found");
      return r.created_at;
    });

    try {
      const hold = await step.do("check-legal-hold", STEP_CONFIG, () =>
        counted(async (e) => {
          const r = await e.DB.prepare("SELECT subject_ref FROM deletion_requests WHERE id = ?").bind(requestId).first<{ subject_ref: string }>();
          return { held: (await activeHolds(e.DB, r!.subject_ref)).length > 0 };
        }),
      );

      if (hold.held) {
        await step.do("record-held", STEP_CONFIG, () =>
          counted(async (e) => {
            await e.DB.prepare("UPDATE deletion_requests SET status = 'held' WHERE id = ?").bind(requestId).run();
            await upsertResults(
              e.DB,
              requestId,
              ASSETS.map((a) => ({ assetId: a.id, category: a.category, applicability: "held", actionStatus: "skipped_hold", verifyStatus: "not_applicable" })),
            );
            await withAuditStream(createAuditLog(e.DB), auditStreamFor(e)).append({ actor: "workflow", actorKind: "system", action: "deletion_held", requestId, decision: "info", reason: "legal_hold", detail: { assets: ASSETS.length } });
            return { assets: ASSETS.length };
          }),
        );
        return { status: "held", steps };
      }

      await step.do("start-and-suppress", STEP_CONFIG, () =>
        counted(async (e) => {
          const r = await e.DB.prepare("SELECT subject_ref FROM deletion_requests WHERE id = ?").bind(requestId).first<{ subject_ref: string }>();
          await e.DB.batch([
            e.DB.prepare("UPDATE deletion_requests SET status = 'running' WHERE id = ?").bind(requestId),
            e.DB.prepare("INSERT OR IGNORE INTO suppression_list (subject_ref, request_id, created_at) VALUES (?, ?, ?)").bind(r!.subject_ref, requestId, new Date().toISOString()),
          ]);
          return { suppressed: true };
        }),
      );

      // Plan-time discovery keeps only the D1 identity count; R2 and KV applicability come from their erase steps.
      await step.do("discover-worker-assets", STEP_CONFIG, () =>
        counted(async (e) => {
          const s = await loadSubject(e.DB, requestId);
          const ident = await countIdentityRecords(e.DB, s);
          const n = ident.rows + ident.refs;
          const pending = (id: string, rowsBefore: number): ResultUpsert => {
            const a = asset(id);
            return { assetId: id, category: a.category, applicability: rowsBefore > 0 ? "present" : "not_present", rowsBefore, rowsErased: 0, referencesScrubbed: 0, actionStatus: "pending", verifyStatus: "pending" };
          };
          await upsertResults(e.DB, requestId, [
            pending("id.d1.identity_records", n),
            ...["src.r2.exports", "drv.r2.analytics_extracts", "cache.kv.profile_cards", "cache.kv.team_rosters"].map((id) => ({ ...pending(id, 0), finding: id.startsWith("src.") ? { parts: {} } : undefined })),
          ]);
          return { identityRecords: n };
        }),
      );

      // R2 erasure: byte-capped cursor steps over the registered parts (4 export families, then the extracts).
      const parts = registeredR2Parts();
      let eraseCursor: ListingCursor = CURSOR_START;
      for (let n = 1, done = false; !done; n++) {
        if (n > MAX_CURSOR_STEPS) throw new Error("erase cursor did not finish");
        const from = eraseCursor;
        const out = await step.do(`erase-r2-${n}`, STEP_CONFIG, () =>
          counted(async (e) => {
            const s = await loadSubject(e.DB, requestId);
            const held = await heldEmployeeIds(e.DB);
            const perAsset = new Map<string, PartCounts>();
            const walk = await walkParts(e, parts, from, cfg.r2EraseStepBytes, async (ref, key) => {
              const value = ref.subjectColumn === "employee_id" ? s.employeeId : s.analyticsId;
              const r = await eraseObject(e[ref.binding], key, ref.part, ref.subjectColumn, value, requestId, ref.subjectColumn === "employee_id" ? held : new Set());
              const counts = perAsset.get(ref.assetId) ?? perAsset.set(ref.assetId, {}).get(ref.assetId)!;
              const c = (counts[ref.part.name] ??= { rows_before: 0, rows_erased: 0, refs_scrubbed: 0, objects_rewritten: 0 });
              c.rows_before += r.rowsRemoved + r.refsScrubbed;
              c.rows_erased += r.rowsRemoved;
              c.refs_scrubbed += r.refsScrubbed;
              if (r.changed) c.objects_rewritten++;
            });
            // Accumulate into the R2 assets' result rows; an asset is erased once the cursor has passed all its parts.
            const touched = new Set([...perAsset.keys(), ...parts.slice(0, walk.cursor.part).map((p) => p.assetId)]);
            const current = await readResults(e.DB, requestId, [...touched]);
            const rows: ResultUpsert[] = [];
            let rowsErased = 0;
            let refsScrubbed = 0;
            for (const id of touched) {
              const row = current.get(id);
              if (!row) continue;
              const finding = (row.finding_json ? JSON.parse(row.finding_json) : {}) as { parts?: PartCounts };
              const partsOut: PartCounts = { ...(finding.parts ?? {}) };
              let before = row.rows_before ?? 0;
              let erased = row.rows_erased ?? 0;
              let scrubbed = row.references_scrubbed ?? 0;
              for (const [name, c] of Object.entries(perAsset.get(id) ?? {})) {
                const p = (partsOut[name] ??= { rows_before: 0, rows_erased: 0, refs_scrubbed: 0, objects_rewritten: 0 });
                p.rows_before += c.rows_before;
                p.rows_erased += c.rows_erased;
                p.refs_scrubbed += c.refs_scrubbed;
                p.objects_rewritten += c.objects_rewritten;
                before += c.rows_before;
                erased += c.rows_erased;
                scrubbed += c.refs_scrubbed;
                rowsErased += c.rows_erased;
                refsScrubbed += c.refs_scrubbed;
              }
              const finished = walk.done || !parts.slice(walk.cursor.part).some((p) => p.assetId === id);
              rows.push(
                toUpsert(row, {
                  applicability: before > 0 ? "present" : "not_present",
                  rowsBefore: before,
                  rowsErased: erased,
                  referencesScrubbed: scrubbed,
                  actionStatus: finished ? "erased" : "pending",
                  finding: { ...finding, parts: partsOut },
                }),
              );
            }
            await upsertResults(e.DB, requestId, rows);
            return { cursor: walk.cursor, done: walk.done, objects: walk.objects, rowsErased, refsScrubbed };
          }),
        );
        eraseCursor = out.cursor;
        done = out.done;
      }

      // KV: one list pass and bulk reads; applicability from the keys this step deletes.
      await step.do("erase-kv-caches", STEP_CONFIG, () =>
        counted(async (e) => {
          const s = await loadSubject(e.DB, requestId);
          const outs = await eraseKvCaches(e.CACHE, s);
          await upsertResults(
            e.DB,
            requestId,
            outs.map((o) => {
              const a = asset(o.assetId);
              return { assetId: o.assetId, category: a.category, applicability: o.rowsBefore > 0 ? "present" : "not_present", rowsBefore: o.rowsBefore, rowsErased: o.rowsErased, referencesScrubbed: 0, actionStatus: "erased", verifyStatus: "pending" };
            }),
          );
          return { keysDeleted: outs.reduce((n, o) => n + (o.keysDeleted ?? 0), 0) };
        }),
      );

      await step.do("enqueue-executor-erase", STEP_CONFIG, () =>
        counted(async (e) => {
          const s = await loadSubject(e.DB, requestId);
          const heldRefs = [...(await activeHeldRefs(e.DB))].sort();
          await createTaskStore(e.DB).create({
            id: `${instanceId}:erase`,
            phase: "erase",
            eventType: "executor_result_erase",
            workflow: "DELETION",
            instanceId,
            requestId,
            payload: { requestId, subject: s, assets: PYTHON_ASSETS.map((a) => a.id), heldSubjectRefs: heldRefs },
          });
          return { queued: true };
        }),
      );

      const eraseEvent = await step.waitForEvent<{ taskId: string; ok: boolean; result: ExecutorResultT }>("wait-executor-erase", {
        type: "executor_result_erase",
        timeout: cfg.executorWaitTimeout as `${number} ${"second" | "minute" | "hour" | "day"}s`,
      });

      await step.do("record-executor-erase", STEP_CONFIG, () =>
        counted(async (e) => {
          const parsed = ExecutorResult.safeParse(eraseEvent.payload.result);
          const ok = eraseEvent.payload.ok && parsed.success;
          const result = parsed.success ? parsed.data : ExecutorResult.parse({});
          const byId = new Map(result.assets.map((a) => [a.asset_id, a]));
          const rows: ResultUpsert[] = [];
          for (const a of PYTHON_ASSETS) {
            const r = byId.get(a.id);
            if (a.id === "id.wh.identity_xref") {
              // discovery only in the erase phase; erased and verified in the identity phase
              rows.push({ assetId: a.id, category: a.category, applicability: r?.applicability ?? "present", rowsBefore: r?.rows_before ?? null, actionStatus: "pending", verifyStatus: "pending" });
              continue;
            }
            if (!r || !ok) {
              rows.push({ assetId: a.id, category: a.category, applicability: r?.applicability ?? "present", actionStatus: "failed", verifyStatus: "error", verifyMatches: 0 });
              continue;
            }
            rows.push({
              assetId: a.id,
              category: a.category,
              applicability: r.applicability,
              rowsBefore: r.rows_before,
              rowsErased: r.rows_erased,
              referencesScrubbed: r.references_scrubbed,
              actionStatus: r.action_status,
              verifyStatus: r.applicability === "aggregate_recompute" ? "not_applicable" : r.verify_status,
              verifyMatches: r.verify_matches,
              finding: { parts: r.parts ?? {}, findings: result.findings.filter((f) => f.asset_id === a.id) },
            });
          }
          const unregistered = result.findings.filter((x) => x.asset_id === null);
          for (const f of unregistered) rows.push(unregisteredRow({ store: f.store, location: f.location, assetId: null, matches: f.matches }));
          await upsertResults(e.DB, requestId, rows);
          return { ok, pythonAssets: result.assets.length, unregistered: unregistered.length };
        }),
      );

      await step.sleep("kv-propagation", cfg.kvPropagationWait as `${number} ${"second" | "minute" | "hour" | "day"}s`);

      const matchersFor = async (e: Env): Promise<{ s: SubjectIdentifiers; m: ReturnType<typeof subjectMatchers> }> => {
        const s = await loadSubject(e.DB, requestId);
        return { s, m: subjectMatchers(s, { includeFullName: POLICY.verification.matchFullName }) };
      };

      // R2 probe: byte-capped cursor steps over both whole buckets; findings go to D1, outputs carry counts only.
      let probeCursor: ProbeCursor = PROBE_START;
      for (let n = 1, done = false; !done; n++) {
        if (n > MAX_CURSOR_STEPS) throw new Error("probe cursor did not finish");
        const from = probeCursor;
        const out = await step.do(`verify-r2-${n}`, STEP_CONFIG, () =>
          counted(async (e) => {
            const { m } = await matchersFor(e);
            const res = await probeR2Step([{ name: "pv-source-exports", bucket: e.EXPORTS }, { name: "pv-derived", bucket: e.DERIVED }], m, from, cfg.r2ProbeStepBytes);
            const rec = await recordProbe(e.DB, requestId, res.findings, res.errors);
            return { cursor: res.cursor, done: res.done, scanned: res.scanned, findings: res.findings.length, errors: rec.errors };
          }),
        );
        probeCursor = out.cursor;
        done = out.done;
      }
      await step.do("verify-kv", STEP_CONFIG, () =>
        counted(async (e) => {
          const { m } = await matchersFor(e);
          const res = await probeKv(e.CACHE, m);
          const rec = await recordProbe(e.DB, requestId, res.findings, res.errors);
          return { scanned: res.scanned, findings: res.findings.length, errors: rec.errors };
        }),
      );
      await step.do("verify-d1", STEP_CONFIG, () =>
        counted(async (e) => {
          const { m } = await matchersFor(e);
          const res = await probeD1(e.DB, m, "before_identity_erasure");
          const rec = await recordProbe(e.DB, requestId, res.findings, res.errors);
          return { scanned: res.scanned, findings: res.findings.length, errors: rec.errors };
        }),
      );

      await step.do("combine-verdicts", STEP_CONFIG, () =>
        counted(async (e) => {
          const current = await readResults(e.DB, requestId, WORKER_PROBED);
          const rows: ResultUpsert[] = [];
          let notClean = 0;
          for (const id of WORKER_PROBED) {
            const row = current.get(id);
            if (!row) continue;
            const finding = (row.finding_json ? JSON.parse(row.finding_json) : {}) as ProbeFindingState & Record<string, unknown>;
            const found = Object.entries(finding.probe ?? {});
            const status = found.length > 0 ? "residue" : Object.keys(finding.probe_errors ?? {}).length > 0 ? "error" : "clean";
            if (status !== "clean") notClean++;
            const { probe: _p, probe_errors: _e, ...rest } = finding;
            rows.push(
              toUpsert(row, {
                verifyStatus: status,
                verifyMatches: found.reduce((n, [, k]) => n + k, 0),
                finding: { ...rest, findings: found.map(([loc, matches]) => ({ store: loc.slice(0, loc.indexOf(":")), location: loc.slice(loc.indexOf(":") + 1), matches })), ...(status === "error" ? { probe_errors: Object.keys(finding.probe_errors ?? {}).length } : {}) },
              }),
            );
          }
          await upsertResults(e.DB, requestId, rows);
          const unregistered = await e.DB.prepare("SELECT COUNT(*) AS n FROM deletion_asset_results WHERE request_id = ? AND applicability = 'unregistered'").bind(requestId).first<{ n: number }>();
          return { workerNotClean: notClean, unregistered: unregistered?.n ?? 0 };
        }),
      );

      const decision = await step.do("decide-identity-erasure", STEP_CONFIG, () =>
        counted(async (e) => {
          const { results } = await e.DB.prepare("SELECT asset_id, applicability, action_status, verify_status FROM deletion_asset_results WHERE request_id = ?")
            .bind(requestId)
            .all<{ asset_id: string; applicability: string; action_status: string; verify_status: string }>();
          const blocking = results.filter(
            (r) =>
              r.asset_id !== "id.d1.identity_records" &&
              r.asset_id !== "id.wh.identity_xref" &&
              (r.action_status === "failed" || r.verify_status === "error" || (isApplicable(r as never) && r.verify_status !== "clean" && r.verify_status !== "not_applicable")),
          );
          return { proceed: blocking.length === 0, blocking: blocking.length };
        }),
      );

      if (decision.proceed) {
        await step.do("erase-identity-records", STEP_CONFIG, () =>
          counted(async (e) => {
            const { s, m } = await matchersFor(e);
            const heldRefs = [...(await activeHeldRefs(e.DB))].sort();
            await createTaskStore(e.DB).create({
              id: `${instanceId}:identity`,
              phase: "identity",
              eventType: "executor_result_identity",
              workflow: "DELETION",
              instanceId,
              requestId,
              payload: { requestId, subject: s, assets: ["id.wh.identity_xref"], heldSubjectRefs: heldRefs },
            });
            const out = await eraseIdentityRecords(e.DB, s);
            const probe = await probeD1(e.DB, m, "before_redaction");
            const mine = probe.findings.filter((f) => f.assetId === "id.d1.identity_records");
            await updateResult(e.DB, requestId, "id.d1.identity_records", {
              rows_erased: out.rowsErased,
              references_scrubbed: out.referencesScrubbed,
              action_status: "erased",
              verify_status: mine.length > 0 ? "residue" : "clean",
              verify_matches: mine.reduce((n, f) => n + f.matches, 0),
              finding_json: JSON.stringify({ findings: mine.map((f) => ({ store: f.store, location: f.location, matches: f.matches })) }),
            });
            await upsertResults(e.DB, requestId, [...probe.findings.filter((x) => x.assetId === null), ...probe.errors].map(unregisteredRow));
            return { rowsErased: out.rowsErased, refsScrubbed: out.referencesScrubbed, residue: mine.length };
          }),
        );

        const identityEvent = await step.waitForEvent<{ taskId: string; ok: boolean; result: ExecutorResultT }>("wait-executor-identity", {
          type: "executor_result_identity",
          timeout: cfg.executorWaitTimeout as `${number} ${"second" | "minute" | "hour" | "day"}s`,
        });

        await step.do("record-executor-identity", STEP_CONFIG, () =>
          counted(async (e) => {
            const parsed = ExecutorResult.safeParse(identityEvent.payload.result);
            const ok = identityEvent.payload.ok && parsed.success;
            const r = parsed.success ? parsed.data.assets.find((a) => a.asset_id === "id.wh.identity_xref") : undefined;
            const a = asset("id.wh.identity_xref");
            const rows: ResultUpsert[] = [
              {
                assetId: a.id,
                category: a.category,
                applicability: r?.applicability ?? "present",
                rowsBefore: r?.rows_before ?? null,
                rowsErased: r?.rows_erased ?? null,
                referencesScrubbed: r?.references_scrubbed ?? 0,
                actionStatus: ok && r ? r.action_status : "failed",
                verifyStatus: ok && r ? r.verify_status : "error",
                verifyMatches: r?.verify_matches ?? 0,
              },
            ];
            for (const f of (parsed.success ? parsed.data.findings : []).filter((x) => x.asset_id === null)) {
              rows.push(unregisteredRow({ store: f.store, location: f.location, assetId: null, matches: f.matches }));
            }
            await upsertResults(e.DB, requestId, rows);
            return { ok };
          }),
        );

        await step.do("record-residuals", STEP_CONFIG, () =>
          counted(async (e) => {
            const parsed = ExecutorResult.safeParse(eraseEvent.payload.result);
            const now = new Date().toISOString();
            const rows: ResidualInput[] = [];
            for (const r of parsed.success ? parsed.data.residuals : []) {
              rows.push({
                id: `${requestId}:${r.kind}:${r.asset_id}:${r.table}`.slice(0, 120),
                requestId,
                assetId: r.asset_id,
                kind: r.kind,
                state: r.state,
                evidence: r.evidence,
                expectedClearAt: r.expected_clear_at,
                detail: { table: r.table, deleted_at: r.deleted_at, snapshot_id: r.snapshot_id ?? null, retained_snapshots: r.retained_snapshots ?? null, data_files: r.data_files ?? [], rows_at_erase: r.rows_at_erase ?? null },
              });
            }
            rows.push({
              id: `${requestId}:kv_propagation`,
              requestId,
              assetId: "cache.kv.profile_cards",
              kind: "kv_propagation",
              state: "cleared",
              evidence: "modeled",
              expectedClearAt: now,
              clearedAt: now,
              detail: { wait: cfg.kvPropagationWait, env: cfg.env },
            });
            if (cfg.env === "production") {
              rows.push({ id: `${requestId}:d1_time_travel`, requestId, assetId: "id.d1.identity_records", kind: "d1_time_travel", state: "modeled", evidence: "modeled", expectedClearAt: addDays(now, D1_TIME_TRAVEL_DAYS) });
            }
            return { residuals: await recordResiduals(e.DB, rows) };
          }),
        );

        await step.do("redact-request", STEP_CONFIG, () =>
          counted(async (e) => {
            const { m } = await matchersFor(e);
            // tokens may exist only in this request's employee_id and its own task payloads
            const reqRows = await e.DB.prepare("SELECT id, employee_id FROM deletion_requests").all<{ id: string; employee_id: string | null }>();
            const taskRows = await e.DB.prepare("SELECT id, request_id, payload_json, result_json FROM executor_tasks").all<{ id: string; request_id: string | null; payload_json: string | null; result_json: string | null }>();
            let stray = 0;
            for (const r of reqRows.results) if (r.id !== requestId && r.employee_id && m.some((x) => x.test(r.employee_id!))) stray++;
            for (const t of taskRows.results) {
              if (t.result_json && m.some((x) => x.test(t.result_json!))) stray++;
              if (t.request_id !== requestId && t.payload_json && m.some((x) => x.test(t.payload_json!))) stray++;
            }
            const res = await e.DB.batch([
              e.DB.prepare("UPDATE deletion_requests SET employee_id = NULL WHERE id = ?").bind(requestId),
              e.DB.prepare("UPDATE executor_tasks SET payload_json = NULL WHERE request_id = ?").bind(requestId),
            ]);
            const final = await probeD1(e.DB, m, "final" as D1Stage);
            const rows = [...final.findings, ...final.errors].map(unregisteredRow);
            if (stray > 0) rows.push(unregisteredRow({ store: "d1", location: "control_tables", assetId: null, matches: stray }));
            await upsertResults(e.DB, requestId, rows);
            return { requestRedacted: res[0]!.meta.changes, payloadsPurged: res[1]!.meta.changes, residue: rows.length };
          }),
        );
      }

      const final = await step.do("finalize", STEP_CONFIG, () => counted(async (e) => this.finalize(e, requestId, startedAt, decision.proceed ? null : "verification_failed")));
      return { status: final.status, steps };
    } catch (err) {
      await step.do("finalize-error", STEP_CONFIG, () => counted(async (e) => this.finalize(e, requestId, startedAt, err instanceof Error ? err.name : "error")));
      throw err;
    }
  }

  private async finalize(e: Env, requestId: string, startedAt: string, failure: string | null): Promise<{ status: string }> {
    const { results } = await e.DB.prepare("SELECT asset_id, applicability, action_status, verify_status FROM deletion_asset_results WHERE request_id = ?")
      .bind(requestId)
      .all<{ asset_id: string; applicability: string; action_status: string; verify_status: string }>();
    const notClean = results.some(
      (r) => r.action_status === "failed" || r.verify_status === "error" || (isApplicable(r as never) && r.verify_status !== "clean") || r.verify_status === "pending",
    );
    const residual = await e.DB.prepare("SELECT COUNT(*) AS n FROM residuals WHERE request_id = ? AND state IN ('pending', 'modeled', 'error')").bind(requestId).first<{ n: number }>();
    const status = failure || notClean ? "failed" : (residual?.n ?? 0) > 0 ? "completed_with_residuals" : "completed";
    const completedAt = new Date().toISOString();
    const { receipt, hash } = await buildReceipt(e.DB, requestId, status, startedAt, completedAt);
    await e.DB.prepare("UPDATE deletion_requests SET status = ?, completed_at = ?, summary_json = ? WHERE id = ?").bind(status, completedAt, JSON.stringify(receipt), requestId).run();
    await withAuditStream(createAuditLog(e.DB), auditStreamFor(e)).append({
      actor: "workflow",
      actorKind: "system",
      action: "deletion_receipt",
      subjectRef: receipt.subjectRef,
      requestId,
      decision: "info",
      reason: status,
      detail: { receipt_hash: hash, failure: failure ?? null },
    });
    return { status };
  }
}
