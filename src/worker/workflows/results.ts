// deletion_asset_results writes for the deletion Workflow. Workers Free allows 50 D1 queries per invocation (SPEC.md
// section 30.3.1), so several rows are written with ONE statement: an upsert that reads its rows from a JSON array
// through json_each. Probe findings are persisted here inside the probe steps (never returned in step outputs, which
// carry counts only), keyed by location so a rescan after a cursor restart overwrites instead of adding.
import type { AssetCategory } from "../../shared/policy-types.ts";
import { asset } from "../assets/registry.ts";
import { categoryForLocation, type Finding, type ProbeError } from "../verify/findings.ts";

export interface ResultUpsert {
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

/** Inserts or replaces result rows with a single statement (json_each over the rows). */
export async function upsertResults(db: D1Database, requestId: string, rows: ResultUpsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const json = JSON.stringify(
    rows.map((r) => ({
      asset_id: r.assetId,
      category: r.category,
      applicability: r.applicability,
      rows_before: r.rowsBefore ?? null,
      rows_erased: r.rowsErased ?? null,
      references_scrubbed: r.referencesScrubbed ?? null,
      action_status: r.actionStatus,
      verify_status: r.verifyStatus,
      verify_matches: r.verifyMatches ?? null,
      finding_json: r.finding === undefined ? null : JSON.stringify(r.finding),
      verified_at: r.verifyStatus === "pending" ? null : now,
    })),
  );
  const res = await db
    .prepare(
      `INSERT INTO deletion_asset_results (request_id, asset_id, category, applicability, rows_before, rows_erased, references_scrubbed, action_status, verify_status, verify_matches, finding_json, verified_at)
       SELECT ?1, json_extract(value, '$.asset_id'), json_extract(value, '$.category'), json_extract(value, '$.applicability'), json_extract(value, '$.rows_before'),
              json_extract(value, '$.rows_erased'), json_extract(value, '$.references_scrubbed'), json_extract(value, '$.action_status'), json_extract(value, '$.verify_status'),
              json_extract(value, '$.verify_matches'), json_extract(value, '$.finding_json'), json_extract(value, '$.verified_at')
       FROM json_each(?2) WHERE true
       ON CONFLICT(request_id, asset_id) DO UPDATE SET category = excluded.category, applicability = excluded.applicability, rows_before = excluded.rows_before,
         rows_erased = excluded.rows_erased, references_scrubbed = excluded.references_scrubbed, action_status = excluded.action_status,
         verify_status = excluded.verify_status, verify_matches = excluded.verify_matches, finding_json = excluded.finding_json, verified_at = excluded.verified_at`,
    )
    .bind(requestId, json)
    .run();
  return res.meta.changes;
}

export interface ResultRow {
  asset_id: string;
  category: AssetCategory;
  applicability: ResultUpsert["applicability"];
  rows_before: number | null;
  rows_erased: number | null;
  references_scrubbed: number | null;
  action_status: ResultUpsert["actionStatus"];
  verify_status: ResultUpsert["verifyStatus"];
  verify_matches: number | null;
  finding_json: string | null;
}

export async function readResults(db: D1Database, requestId: string, assetIds: readonly string[]): Promise<Map<string, ResultRow>> {
  if (assetIds.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT asset_id, category, applicability, rows_before, rows_erased, references_scrubbed, action_status, verify_status, verify_matches, finding_json FROM deletion_asset_results WHERE request_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))`)
    .bind(requestId, JSON.stringify(assetIds))
    .all<ResultRow>();
  return new Map(results.map((r) => [r.asset_id, r]));
}

export function toUpsert(r: ResultRow, patch: Partial<ResultUpsert> = {}): ResultUpsert {
  return {
    assetId: r.asset_id,
    category: r.category,
    applicability: r.applicability,
    rowsBefore: r.rows_before,
    rowsErased: r.rows_erased,
    referencesScrubbed: r.references_scrubbed,
    actionStatus: r.action_status,
    verifyStatus: r.verify_status,
    verifyMatches: r.verify_matches,
    finding: r.finding_json ? (JSON.parse(r.finding_json) as unknown) : undefined,
    ...patch,
  };
}

export function unregisteredRow(f: Finding | ProbeError): ResultUpsert {
  const isError = "error" in f;
  return {
    assetId: `unregistered:${f.store}:${f.location}`.slice(0, 200),
    category: categoryForLocation(f.store, f.location),
    applicability: "unregistered",
    actionStatus: "failed",
    verifyStatus: isError ? "error" : "residue",
    verifyMatches: isError ? 0 : (f as Finding).matches,
    finding: [{ store: f.store, location: f.location, ...(isError ? { error: (f as ProbeError).error } : { matches: (f as Finding).matches }) }],
  };
}

/** Worker-probed registered assets whose verdict combine-verdicts derives from the persisted probe findings. */
export const WORKER_PROBED = ["src.r2.exports", "drv.r2.analytics_extracts", "cache.kv.profile_cards", "cache.kv.team_rosters"] as const;

export interface ProbeFindingState {
  /** location -> matches, per registered asset (overwritten on a rescan of the same location) */
  probe?: Record<string, number>;
  /** store-level read errors that could hide the asset's residue (location -> 1) */
  probe_errors?: Record<string, number>;
}

/** Registered assets a probe error could hide residue in: the R2 assets of the same bucket, both KV assets. */
function assetsAtRisk(e: ProbeError): string[] {
  if (e.store === "kv") return ["cache.kv.profile_cards", "cache.kv.team_rosters"];
  if (e.store === "r2") return WORKER_PROBED.filter((id) => asset(id).store === "r2" && e.location.startsWith(`${asset(id).location.split("/")[0]}/`));
  return [];
}

/**
 * Persists one probe step's findings and errors: registered findings and at-risk errors go into the asset's
 * finding_json (by location), unregistered findings and D1 errors become unregistered rows. At most 2 statements.
 */
export async function recordProbe(db: D1Database, requestId: string, findings: Finding[], errors: ProbeError[]): Promise<{ registered: number; unregistered: number; errors: number }> {
  const unregistered: ResultUpsert[] = [];
  const byAsset = new Map<string, { probe: Record<string, number>; probe_errors: Record<string, number> }>();
  const slot = (id: string) => byAsset.get(id) ?? byAsset.set(id, { probe: {}, probe_errors: {} }).get(id)!;
  for (const f of findings) {
    if (f.assetId && (WORKER_PROBED as readonly string[]).includes(f.assetId)) slot(f.assetId).probe[`${f.store}:${f.location}`] = f.matches;
    else if (f.assetId === null) unregistered.push(unregisteredRow(f));
  }
  for (const e of errors) {
    const ids = assetsAtRisk(e);
    if (ids.length === 0) unregistered.push(unregisteredRow(e));
    for (const id of ids) slot(id).probe_errors[`${e.store}:${e.location}`] = 1;
  }
  const rows: ResultUpsert[] = [...unregistered];
  if (byAsset.size > 0) {
    const current = await readResults(db, requestId, [...byAsset.keys()]);
    for (const [id, add] of byAsset) {
      const a = asset(id);
      const row = current.get(id);
      const prev = (row?.finding_json ? JSON.parse(row.finding_json) : {}) as ProbeFindingState & Record<string, unknown>;
      const finding = { ...prev, probe: { ...(prev.probe ?? {}), ...add.probe }, probe_errors: { ...(prev.probe_errors ?? {}), ...add.probe_errors } };
      rows.push(
        row
          ? toUpsert(row, { finding })
          : { assetId: id, category: a.category, applicability: "not_present", actionStatus: "pending", verifyStatus: "pending", finding },
      );
    }
  }
  await upsertResults(db, requestId, rows);
  return { registered: findings.length - unregistered.filter((u) => u.verifyStatus === "residue").length, unregistered: unregistered.length, errors: errors.length };
}
