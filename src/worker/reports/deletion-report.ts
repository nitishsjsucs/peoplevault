// Deletion coverage report (SPEC.md sections 8.6 and 14.7): coverage = clean_pairs / applicable_pairs, always with
// its denominator; a category with no applicable pairs is n/a, never 100%. Held requests are a separate bucket, and
// residuals are reported by kind, state and evidence, never inside coverage.
import { isApplicable, perCategory, type AssetResultRow } from "../audit/receipts.ts";

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

export async function deletionReport(db: D1Database, from: string | null, to: string | null) {
  const where = "WHERE (?1 IS NULL OR r.created_at >= ?1) AND (?2 IS NULL OR r.created_at <= ?2)";
  const { results: requests } = await db.prepare(`SELECT r.id, r.kind, r.status FROM deletion_requests r ${where} ORDER BY r.created_at`).bind(from, to).all<{ id: string; kind: string; status: string }>();
  const { results: rows } = await db
    .prepare(`SELECT a.*, r.status AS request_status FROM deletion_asset_results a JOIN deletion_requests r ON r.id = a.request_id ${where}`)
    .bind(from, to)
    .all<AssetResultRow & { request_id: string; request_status: string }>();
  const scored = rows.filter((r) => r.request_status !== "held" && r.applicability !== "held");
  const cats = perCategory(scored);
  const applicable = scored.filter(isApplicable);
  const clean = applicable.filter((r) => r.verify_status === "clean").length;
  const byStatus: Record<string, number> = {};
  for (const r of requests) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const { results: residuals } = await db
    .prepare(`SELECT s.kind, s.state, s.evidence, COUNT(*) AS n FROM residuals s JOIN deletion_requests r ON r.id = s.request_id ${where} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)
    .bind(from, to)
    .all<{ kind: string; state: string; evidence: string; n: number }>();
  const failures = rows
    .filter((r) => r.request_status === "failed" && r.finding_json)
    .map((r) => ({ requestId: r.request_id, assetId: r.asset_id, findings: JSON.parse(r.finding_json!) as unknown }));
  return {
    window: { from, to },
    requests: { total: requests.length, byStatus },
    coverage: coverage(clean, applicable.length),
    byCategory: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, { ...coverage(c.clean, c.applicable), notPresent: c.notPresent, aggregateRecompute: c.aggregateRecompute }])),
    held: { requests: byStatus.held ?? 0, assetPairs: rows.filter((r) => r.applicability === "held").length },
    aggregateRecompute: {
      recomputed: rows.filter((r) => r.applicability === "aggregate_recompute" && r.action_status === "recomputed").length,
      notRecomputed: rows.filter((r) => r.applicability === "aggregate_recompute" && r.action_status !== "recomputed").length,
    },
    residuals,
    failures,
  };
}
