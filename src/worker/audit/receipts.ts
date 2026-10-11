// Deletion receipts (SPEC.md section 14.7): stored in deletion_requests.summary_json, hash appended to the audit chain
// as action deletion_receipt. Counts, asset ids, enums and timestamps only.
import type { AssetCategory } from "../../shared/policy-types.ts";
import { POLICY } from "../policy/compiled.ts";
import { canonicalJson, sha256Hex } from "./audit-log.ts";

export interface AssetResultRow {
  asset_id: string;
  category: AssetCategory;
  applicability: "present" | "not_present" | "aggregate_recompute" | "held" | "unregistered";
  rows_before: number | null;
  rows_erased: number | null;
  references_scrubbed: number | null;
  action_status: string;
  verify_status: string;
  verify_matches: number | null;
  finding_json: string | null;
}

export interface CategoryCounts {
  applicable: number;
  clean: number;
  notClean: number;
  notPresent: number;
  held: number;
  aggregateRecompute: number;
}

/** An applicable pair: present, not_present with residue found, or an unregistered residue location. */
export function isApplicable(r: Pick<AssetResultRow, "applicability" | "verify_status">): boolean {
  if (r.applicability === "present" || r.applicability === "unregistered") return true;
  if (r.applicability === "not_present") return r.verify_status === "residue" || r.verify_status === "error";
  return false;
}

export function perCategory(rows: Pick<AssetResultRow, "category" | "applicability" | "verify_status">[]): Record<AssetCategory, CategoryCounts> {
  const out = Object.fromEntries(POLICY.categories.map((c) => [c, { applicable: 0, clean: 0, notClean: 0, notPresent: 0, held: 0, aggregateRecompute: 0 }])) as Record<AssetCategory, CategoryCounts>;
  for (const r of rows) {
    const c = out[r.category];
    if (!c) continue;
    if (r.applicability === "held") c.held++;
    else if (r.applicability === "aggregate_recompute") c.aggregateRecompute++;
    else if (isApplicable(r)) {
      c.applicable++;
      if (r.verify_status === "clean") c.clean++;
      else c.notClean++;
    } else c.notPresent++;
  }
  return out;
}

export async function buildReceipt(db: D1Database, requestId: string, status: string, startedAt: string, completedAt: string) {
  const req = await db.prepare("SELECT kind, subject_ref FROM deletion_requests WHERE id = ?").bind(requestId).first<{ kind: string; subject_ref: string }>();
  const { results: assets } = await db
    .prepare("SELECT asset_id, category, applicability, rows_before, rows_erased, references_scrubbed, action_status, verify_status, verify_matches, finding_json FROM deletion_asset_results WHERE request_id = ? ORDER BY asset_id")
    .bind(requestId)
    .all<AssetResultRow>();
  const { results: residuals } = await db
    .prepare("SELECT id, asset_id, kind, state, evidence, expected_clear_at, cleared_at FROM residuals WHERE request_id = ? ORDER BY id")
    .bind(requestId)
    .all();
  const { results: holds } = await db
    .prepare("SELECT id, matter_id, placed_at, released_at FROM legal_holds WHERE subject_ref = ? ORDER BY placed_at")
    .bind(req?.subject_ref ?? "")
    .all();
  const receipt = {
    requestId,
    kind: req?.kind ?? null,
    subjectRef: req?.subject_ref ?? null,
    status,
    startedAt,
    completedAt,
    policyVersion: POLICY.version,
    policyHash: POLICY.policyHash,
    perCategory: perCategory(assets),
    assets: assets.map((a) => ({
      assetId: a.asset_id,
      category: a.category,
      applicability: a.applicability,
      rowsBefore: a.rows_before,
      rowsErased: a.rows_erased,
      referencesScrubbed: a.references_scrubbed,
      actionStatus: a.action_status,
      verifyStatus: a.verify_status,
      verifyMatches: a.verify_matches,
    })),
    residuals,
    holds,
  };
  return { receipt, hash: await sha256Hex(canonicalJson(receipt)) };
}
