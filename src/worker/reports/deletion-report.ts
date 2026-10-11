// Deletion coverage report (SPEC.md sections 8.6, 14.7 and 30.3.2): coverage = clean_pairs / applicable_pairs, always
// with its denominator; a category with no applicable pairs is n/a, never 100%. Held requests are a separate bucket,
// and residuals are reported by kind, state and evidence, never inside coverage.
//
// Workers Free: the totals are computed in SQLite with GROUP BY (the definitions of receipts.ts isApplicable and
// perCategory, written as SQL), so the Worker handles a few dozen aggregate rows instead of every result row, and the
// failures are paged, at most 100 per response (`limit`, `cursor`).
import type { AssetCategory } from "../../shared/policy-types.ts";
import { POLICY } from "../policy/compiled.ts";

export interface CoverageValue {
  value: number | null;
  display: string;
  applicablePairs: number;
  cleanPairs: number;
}

export function coverage(clean: number, applicable: number): CoverageValue {
  return applicable === 0
    ? { value: null, display: "n/a", applicablePairs: 0, cleanPairs: 0 }
    : { value: clean / applicable, display: `${((100 * clean) / applicable).toFixed(1)}%`, applicablePairs: applicable, cleanPairs: clean };
}

/** An applicable pair (receipts.ts isApplicable): present, unregistered, or not_present with residue or an error. */
const APPLICABLE = "(a.applicability IN ('present', 'unregistered') OR (a.applicability = 'not_present' AND a.verify_status IN ('residue', 'error')))";
const WINDOW = "(?1 IS NULL OR r.created_at >= ?1) AND (?2 IS NULL OR r.created_at <= ?2)";
export const REPORT_FAILURES_MAX = 100;

export interface ReportPage {
  limit: number;
  cursor: string | null;
}

function encodeCursor(requestId: string, assetId: string): string {
  return btoa(JSON.stringify([requestId, assetId])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string | null): [string, string] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string") ? (v as [string, string]) : null;
  } catch {
    return null;
  }
}

export async function deletionReport(db: D1Database, from: string | null, to: string | null, page: ReportPage = { limit: REPORT_FAILURES_MAX, cursor: null }) {
  const limit = Math.max(1, Math.min(REPORT_FAILURES_MAX, page.limit));
  const after = decodeCursor(page.cursor);
  const [statusRows, catRows, totals, residuals, failureRows] = await db.batch([
    db.prepare(`SELECT r.status AS status, COUNT(*) AS n FROM deletion_requests r WHERE ${WINDOW} GROUP BY r.status ORDER BY r.status`).bind(from, to),
    db
      .prepare(
        `SELECT a.category AS category,
                SUM(CASE WHEN a.applicability = 'aggregate_recompute' THEN 0 WHEN ${APPLICABLE} THEN 1 ELSE 0 END) AS applicable,
                SUM(CASE WHEN a.applicability <> 'aggregate_recompute' AND ${APPLICABLE} AND a.verify_status = 'clean' THEN 1 ELSE 0 END) AS clean,
                SUM(CASE WHEN a.applicability = 'aggregate_recompute' THEN 1 ELSE 0 END) AS aggregate,
                SUM(CASE WHEN a.applicability <> 'aggregate_recompute' AND NOT ${APPLICABLE} THEN 1 ELSE 0 END) AS not_present
         FROM deletion_asset_results a JOIN deletion_requests r ON r.id = a.request_id
         WHERE ${WINDOW} AND r.status <> 'held' AND a.applicability <> 'held'
         GROUP BY a.category`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT SUM(CASE WHEN a.applicability = 'held' THEN 1 ELSE 0 END) AS held_pairs,
                SUM(CASE WHEN a.applicability = 'aggregate_recompute' AND a.action_status = 'recomputed' THEN 1 ELSE 0 END) AS recomputed,
                SUM(CASE WHEN a.applicability = 'aggregate_recompute' AND a.action_status <> 'recomputed' THEN 1 ELSE 0 END) AS not_recomputed
         FROM deletion_asset_results a JOIN deletion_requests r ON r.id = a.request_id WHERE ${WINDOW}`,
      )
      .bind(from, to),
    db
      .prepare(`SELECT s.kind, s.state, s.evidence, COUNT(*) AS n FROM residuals s JOIN deletion_requests r ON r.id = s.request_id WHERE ${WINDOW} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)
      .bind(from, to),
    db
      .prepare(
        `SELECT a.request_id AS request_id, a.asset_id AS asset_id, a.finding_json AS finding_json
         FROM deletion_asset_results a JOIN deletion_requests r ON r.id = a.request_id
         WHERE ${WINDOW} AND r.status = 'failed' AND a.finding_json IS NOT NULL AND (?3 IS NULL OR a.request_id > ?3 OR (a.request_id = ?3 AND a.asset_id > ?4))
         ORDER BY a.request_id, a.asset_id LIMIT ?5`,
      )
      .bind(from, to, after?.[0] ?? null, after?.[1] ?? null, limit + 1),
  ]);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of statusRows!.results as { status: string; n: number }[]) {
    byStatus[r.status] = r.n;
    total += r.n;
  }
  const cats = new Map((catRows!.results as { category: AssetCategory; applicable: number; clean: number; aggregate: number; not_present: number }[]).map((r) => [r.category, r]));
  let applicable = 0;
  let clean = 0;
  const byCategory = Object.fromEntries(
    POLICY.categories.map((c) => {
      const r = cats.get(c);
      applicable += r?.applicable ?? 0;
      clean += r?.clean ?? 0;
      return [c, { ...coverage(r?.clean ?? 0, r?.applicable ?? 0), notPresent: r?.not_present ?? 0, aggregateRecompute: r?.aggregate ?? 0 }];
    }),
  );
  const t = (totals!.results[0] ?? {}) as { held_pairs: number | null; recomputed: number | null; not_recomputed: number | null };
  const failures = (failureRows!.results as { request_id: string; asset_id: string; finding_json: string }[]).slice(0, limit);
  const more = failureRows!.results.length > limit;
  const lastFailure = failures[failures.length - 1];
  return {
    window: { from, to },
    requests: { total, byStatus },
    coverage: coverage(clean, applicable),
    byCategory,
    held: { requests: byStatus.held ?? 0, assetPairs: t.held_pairs ?? 0 },
    aggregateRecompute: { recomputed: t.recomputed ?? 0, notRecomputed: t.not_recomputed ?? 0 },
    residuals: residuals!.results as { kind: string; state: string; evidence: string; n: number }[],
    failures: failures.map((r) => ({ requestId: r.request_id, assetId: r.asset_id, findings: JSON.parse(r.finding_json) as unknown })),
    failuresCursor: more && lastFailure ? encodeCursor(lastFailure.request_id, lastFailure.asset_id) : null,
  };
}
