// Residuals: data that deletion does not remove from active stores (SPEC.md section 14.4). Tracked separately and
// never counted in coverage. Each has a kind, a state (pending, cleared, modeled, error; error is never read as
// cleared) and evidence (observed or modeled).

export type ResidualKind = "iceberg_snapshots" | "iceberg_orphan_files" | "bq_time_travel" | "bq_fail_safe" | "d1_time_travel" | "kv_propagation";

export interface ResidualInput {
  id: string;
  requestId: string | null;
  assetId: string;
  kind: ResidualKind;
  state: "pending" | "cleared" | "modeled" | "error";
  evidence: "observed" | "modeled";
  expectedClearAt: string | null;
  clearedAt?: string | null;
  detail?: Record<string, unknown>;
}

export const D1_TIME_TRAVEL_DAYS = 30;

export async function recordResiduals(db: D1Database, rows: ResidualInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO residuals (id, request_id, asset_id, kind, state, evidence, expected_clear_at, cleared_at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, evidence = excluded.evidence, expected_clear_at = excluded.expected_clear_at, cleared_at = excluded.cleared_at, detail_json = excluded.detail_json`,
      )
      .bind(r.id, r.requestId, r.assetId, r.kind, r.state, r.evidence, r.expectedClearAt, r.clearedAt ?? null, r.detail ? JSON.stringify(r.detail) : null),
  );
  await db.batch(stmts);
  return rows.length;
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}
