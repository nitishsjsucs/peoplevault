// SubjectDeletionWorkflow (SPEC.md section 14.1). Instance id = request id (retries: <requestId>-r<n>).
// Step outputs hold counts, asset ids, booleans and timestamps only, never identifiers: identifiers are loaded from
// D1 inside each step that needs them. Worker-native assets (R2, KV, D1) are erased and probed here; Python-native
// assets (warehouse, Iceberg) by the executor, bridged by D1 task rows and Workflow events (ADR 0001).
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AssetCategory } from "../../shared/policy-types.ts";
import { asset, ASSETS, PYTHON_ASSETS } from "../assets/registry.ts";
import { loadSubject, type SubjectIdentifiers } from "../assets/subject.ts";
import { createAuditLog } from "../audit/audit-log.ts";
import { auditStreamFor, withAuditStream } from "../audit/audit-stream.ts";
import { buildReceipt, isApplicable } from "../audit/receipts.ts";
import { loadConfig } from "../env.ts";
import { countIdentityRecords, eraseIdentityRecords } from "../erase/d1-identity.ts";
import { countInObjects, eraseObjects, type EraseOutcome } from "../erase/jsonl-objects.ts";
import { eraseKvCaches, planKvErasure } from "../erase/kv-cache.ts";
import { ExecutorResult, createTaskStore, type ExecutorResult as ExecutorResultT } from "../executor/task-store.ts";
import { activeHeldRefs, activeHolds } from "../holds/holds.ts";
import { POLICY } from "../policy/compiled.ts";
import { addDays, D1_TIME_TRAVEL_DAYS, recordResiduals, type ResidualInput } from "../residuals/residuals.ts";
import { newCounter, withOpBudget } from "../storage/op-budget.ts";
import { probeD1, type D1Stage } from "../verify/d1-probe.ts";
import { categoryForLocation, type Finding, type ProbeResult } from "../verify/findings.ts";
import { probeKv } from "../verify/kv-probe.ts";
import { probeR2 } from "../verify/r2-probe.ts";
import { subjectMatchers } from "../verify/tokens.ts";

export interface DeletionParams {
  requestId: string;
}

export const STEP_CONFIG = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
const EXPORT_FAMILIES = ["hris", "payroll", "leave", "performance"] as const;
const WORKER_ERASED = ["src.r2.exports", "drv.r2.analytics_extracts", "cache.kv.profile_cards", "cache.kv.team_rosters"] as const;

interface ResultUpsert {
  assetId: string;
  category: AssetCategory;
  applicability: "present" | "not_present" | "aggregate_recompute" | "held" | "unregistered";
  rowsBefore?: number | null;
  rowsErased?: number | null;
  referencesScrubbed?: number | null;
  actionStatus: "pending" | "erased" | "recomputed" | "skipped_hold" | "failed";
  verifyStatus: "pending" | "clean" | "residue" | "error" | "not_applicable";
  verifyMatches?: number | null;
  finding?: unknown;
}

async function upsertResult(db: D1Database, requestId: string, r: ResultUpsert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO deletion_asset_results (request_id, asset_id, category, applicability, rows_before, rows_erased, references_scrubbed, action_status, verify_status, verify_matches, finding_json, verified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(request_id, asset_id) DO UPDATE SET category = excluded.category, applicability = excluded.applicability, rows_before = excluded.rows_before,
         rows_erased = excluded.rows_erased, references_scrubbed = excluded.references_scrubbed, action_status = excluded.action_status,
         verify_status = excluded.verify_status, verify_matches = excluded.verify_matches, finding_json = excluded.finding_json, verified_at = excluded.verified_at`,
    )
    .bind(
      requestId,
      r.assetId,
      r.category,
      r.applicability,
      r.rowsBefore ?? null,
      r.rowsErased ?? null,
      r.referencesScrubbed ?? null,
      r.actionStatus,
      r.verifyStatus,
      r.verifyMatches ?? null,
      r.finding === undefined ? null : JSON.stringify(r.finding),
      r.verifyStatus === "pending" ? null : new Date().toISOString(),
    )
    .run();
}

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
  const { results } = await db.prepare(`SELECT employee_id FROM identity_map WHERE subject_ref IN (${refs.map(() => "?").join(", ")})`).bind(...refs).all<{ employee_id: string }>();
  return new Set(results.map((r) => r.employee_id));
}

function unregisteredRow(f: Finding | { store: Finding["store"]; location: string; error: string }): ResultUpsert {
  const isError = "error" in f;
  return {
    assetId: `unregistered:${f.store}:${f.location}`.slice(0, 200),
    category: categoryForLocation(f.store, f.location),
    applicability: "unregistered",
    actionStatus: "failed",
    verifyStatus: isError ? "error" : "residue",
    verifyMatches: isError ? 0 : (f as Finding).matches,
    finding: [{ store: f.store, location: f.location, ...(isError ? { error: (f as { error: string }).error } : { matches: (f as Finding).matches }) }],
  };
}

export class SubjectDeletionWorkflow extends WorkflowEntrypoint<Env, DeletionParams> {
  override async run(event: WorkflowEvent<DeletionParams>, step: WorkflowStep): Promise<unknown> {
    const requestId = event.payload.requestId;
    const instanceId = event.instanceId;
    const cfg = loadConfig(this.env);
    const env = this.env;
    const db = env.DB;

    // Runs `fn` with a counting wrapper over KV, R2 and D1 and returns its output plus the operation count.
    const counted = async <T extends Record<string, unknown>>(fn: (e: Env) => Promise<T>): Promise<T & { ops: number }> => {
      const counter = newCounter();
      const out = await fn(withOpBudget(env, counter));
      return { ...out, ops: counter.total() };
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
            for (const a of ASSETS) {
              await upsertResult(e.DB, requestId, { assetId: a.id, category: a.category, applicability: "held", actionStatus: "skipped_hold", verifyStatus: "not_applicable" });
            }
            await withAuditStream(createAuditLog(e.DB), auditStreamFor(e)).append({ actor: "workflow", actorKind: "system", action: "deletion_held", requestId, decision: "info", reason: "legal_hold", detail: { assets: ASSETS.length } });
            return { assets: ASSETS.length };
          }),
        );
        return { status: "held" };
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

      await step.do("discover-worker-assets", STEP_CONFIG, () =>
        counted(async (e) => {
          const s = await loadSubject(e.DB, requestId);
          const exportsAsset = asset("src.r2.exports");
          const parts: Record<string, { rows_before: number; rows_erased: number; refs_scrubbed: number }> = {};
          let exportsRows = 0;
          for (const p of exportsAsset.parts) {
            const c = await countInObjects(e.EXPORTS, p, "employee_id", s.employeeId);
            parts[p.name] = { rows_before: c.rows + c.refs, rows_erased: 0, refs_scrubbed: 0 };
            exportsRows += c.rows + c.refs;
          }
          const extracts = asset("drv.r2.analytics_extracts");
          const ex = await countInObjects(e.DERIVED, extracts.parts[0]!, "analytics_id", s.analyticsId);
          const ident = await countIdentityRecords(e.DB, s);
          const kv = await planKvErasure(e.CACHE, s);
          const counts: Record<string, number> = {
            "src.r2.exports": exportsRows,
            "drv.r2.analytics_extracts": ex.rows,
            "id.d1.identity_records": ident.rows + ident.refs,
            "cache.kv.profile_cards": kv.profile.length,
            "cache.kv.team_rosters": kv.team.length,
          };
          for (const [id, n] of Object.entries(counts)) {
            const a = asset(id);
            await upsertResult(e.DB, requestId, {
              assetId: id,
              category: a.category,
              applicability: n > 0 ? "present" : "not_present",
              rowsBefore: n,
              rowsErased: 0,
              referencesScrubbed: 0,
              actionStatus: "pending",
              verifyStatus: "pending",
              ...(id === "src.r2.exports" ? { finding: { parts } } : {}),
            });
          }
          return { present: Object.values(counts).filter((n) => n > 0).length };
        }),
      );

      for (const family of EXPORT_FAMILIES) {
        await step.do(`erase-r2-exports-${family}`, STEP_CONFIG, () =>
          counted(async (e) => {
            const s = await loadSubject(e.DB, requestId);
            const a = asset("src.r2.exports");
            const part = a.parts.find((p) => p.name === family)!;
            const held = await heldEmployeeIds(e.DB);
            const out = await eraseObjects(e.EXPORTS, a.id, part, "employee_id", s.employeeId, requestId, held);
            const row = await e.DB.prepare("SELECT rows_erased, references_scrubbed, finding_json FROM deletion_asset_results WHERE request_id = ? AND asset_id = ?")
              .bind(requestId, a.id)
              .first<{ rows_erased: number; references_scrubbed: number; finding_json: string | null }>();
            const finding = row?.finding_json ? (JSON.parse(row.finding_json) as { parts: Record<string, Record<string, number>> }) : { parts: {} };
            finding.parts[family] = { ...(finding.parts[family] ?? { rows_before: 0 }), rows_erased: out.rowsErased, refs_scrubbed: out.referencesScrubbed };
            await updateResult(e.DB, requestId, a.id, {
              rows_erased: (row?.rows_erased ?? 0) + out.rowsErased,
              references_scrubbed: (row?.references_scrubbed ?? 0) + out.referencesScrubbed,
              finding_json: JSON.stringify(finding),
              action_status: family === "performance" ? "erased" : "pending",
            });
            return { rowsErased: out.rowsErased, refsScrubbed: out.referencesScrubbed, objectsRewritten: out.objectsRewritten ?? 0 };
          }),
        );
      }

      await step.do("erase-r2-extracts", STEP_CONFIG, () =>
        counted(async (e) => {
          const s = await loadSubject(e.DB, requestId);
          const a = asset("drv.r2.analytics_extracts");
          const out = await eraseObjects(e.DERIVED, a.id, a.parts[0]!, "analytics_id", s.analyticsId, requestId);
          await updateResult(e.DB, requestId, a.id, { rows_erased: out.rowsErased, references_scrubbed: 0, action_status: "erased" });
          return { rowsErased: out.rowsErased };
        }),
      );

      await step.do("erase-kv-caches", STEP_CONFIG, () =>
        counted(async (e) => {
          const s = await loadSubject(e.DB, requestId);
          const outs: EraseOutcome[] = await eraseKvCaches(e.CACHE, s);
          for (const o of outs) await updateResult(e.DB, requestId, o.assetId, { rows_erased: o.rowsErased, action_status: "erased" });
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
          for (const a of PYTHON_ASSETS) {
            const r = byId.get(a.id);
            if (a.id === "id.wh.identity_xref") {
              // discovery only in the erase phase; erased and verified in the identity phase (step 15)
              await upsertResult(e.DB, requestId, { assetId: a.id, category: a.category, applicability: r?.applicability ?? "present", rowsBefore: r?.rows_before ?? null, actionStatus: "pending", verifyStatus: "pending" });
              continue;
            }
            if (!r || !ok) {
              await upsertResult(e.DB, requestId, { assetId: a.id, category: a.category, applicability: r?.applicability ?? "present", actionStatus: "failed", verifyStatus: "error", verifyMatches: 0 });
              continue;
            }
            await upsertResult(e.DB, requestId, {
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
          for (const f of result.findings.filter((x) => x.asset_id === null)) {
            await upsertResult(e.DB, requestId, unregisteredRow({ store: f.store, location: f.location, assetId: null, matches: f.matches }));
          }
          return { ok, pythonAssets: result.assets.length, unregistered: result.findings.filter((x) => x.asset_id === null).length };
        }),
      );

      await step.sleep("kv-propagation", cfg.kvPropagationWait as `${number} ${"second" | "minute" | "hour" | "day"}s`);

      const matchersFor = async (e: Env): Promise<{ s: SubjectIdentifiers; m: ReturnType<typeof subjectMatchers> }> => {
        const s = await loadSubject(e.DB, requestId);
        return { s, m: subjectMatchers(s, { includeFullName: POLICY.verification.matchFullName }) };
      };

      const r2 = await step.do("verify-r2", STEP_CONFIG, () =>
        counted(async (e) => {
          const { m } = await matchersFor(e);
          const res = await probeR2([{ name: "pv-source-exports", bucket: e.EXPORTS }, { name: "pv-derived", bucket: e.DERIVED }], m);
          return { findings: res.findings, errors: res.errors, scanned: res.scanned };
        }),
      );
      const kv = await step.do("verify-kv", STEP_CONFIG, () =>
        counted(async (e) => {
          const { m } = await matchersFor(e);
          const res = await probeKv(e.CACHE, m);
          return { findings: res.findings, errors: res.errors, scanned: res.scanned };
        }),
      );
      const d1 = await step.do("verify-d1", STEP_CONFIG, () =>
        counted(async (e) => {
          const { m } = await matchersFor(e);
          const res = await probeD1(e.DB, m, "before_identity_erasure");
          return { findings: res.findings, errors: res.errors, scanned: res.scanned };
        }),
      );

      await step.do("combine-verdicts", STEP_CONFIG, () =>
        counted(async (e) => {
          const probes: ProbeResult[] = [r2, kv, d1] as unknown as ProbeResult[];
          const findings = probes.flatMap((p) => p.findings);
          const errors = probes.flatMap((p) => p.errors);
          let notClean = 0;
          for (const id of WORKER_ERASED) {
            const a = asset(id);
            const mine = findings.filter((f) => f.assetId === id);
            const storeErrors = errors.filter((er) => er.store === a.store && mine.length === 0 && (a.store !== "r2" || er.location.startsWith(a.location.split("/")[0]!)));
            const status = mine.length > 0 ? "residue" : storeErrors.length > 0 ? "error" : "clean";
            if (status !== "clean") notClean++;
            const prev = await e.DB.prepare("SELECT finding_json FROM deletion_asset_results WHERE request_id = ? AND asset_id = ?").bind(requestId, id).first<{ finding_json: string | null }>();
            const finding = { ...(prev?.finding_json ? JSON.parse(prev.finding_json) : {}), findings: mine.map((f) => ({ store: f.store, location: f.location, matches: f.matches })) };
            await updateResult(e.DB, requestId, id, { verify_status: status, verify_matches: mine.reduce((n, f) => n + f.matches, 0), finding_json: JSON.stringify(finding) });
          }
          const unregistered = [...findings.filter((f) => f.assetId === null), ...errors.filter((er) => er.store === "d1")];
          for (const f of unregistered) await upsertResult(e.DB, requestId, unregisteredRow(f));
          return { workerNotClean: notClean, unregistered: unregistered.length };
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
            for (const f of [...probe.findings.filter((x) => x.assetId === null), ...probe.errors]) await upsertResult(e.DB, requestId, unregisteredRow(f));
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
            await upsertResult(e.DB, requestId, {
              assetId: a.id,
              category: a.category,
              applicability: r?.applicability ?? "present",
              rowsBefore: r?.rows_before ?? null,
              rowsErased: r?.rows_erased ?? null,
              referencesScrubbed: r?.references_scrubbed ?? 0,
              actionStatus: ok && r ? r.action_status : "failed",
              verifyStatus: ok && r ? r.verify_status : "error",
              verifyMatches: r?.verify_matches ?? 0,
            });
            for (const f of (parsed.success ? parsed.data.findings : []).filter((x) => x.asset_id === null)) {
              await upsertResult(e.DB, requestId, unregisteredRow({ store: f.store, location: f.location, assetId: null, matches: f.matches }));
            }
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
            for (const f of [...final.findings, ...final.errors]) await upsertResult(e.DB, requestId, unregisteredRow(f));
            if (stray > 0) await upsertResult(e.DB, requestId, unregisteredRow({ store: "d1", location: "control_tables", assetId: null, matches: stray }));
            return { requestRedacted: res[0]!.meta.changes, payloadsPurged: res[1]!.meta.changes, residue: final.findings.length + final.errors.length + stray };
          }),
        );
      }

      return await step.do("finalize", STEP_CONFIG, () => counted(async (e) => this.finalize(e, requestId, startedAt, decision.proceed ? null : "verification_failed")));
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
