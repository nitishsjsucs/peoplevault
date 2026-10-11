// R2 object erasure with reference scrubbing for source exports (JSONL and CSV) and analytics extracts, through the
// etag compare-and-swap rewrite (SPEC.md sections 8.5 and 9.1).
import type { AssetPart } from "../../shared/policy-types.ts";
import { rewriteObject, type TransformResult } from "../storage/r2-rewrite.ts";

export const REDACTED = "REDACTED";

export interface EraseOutcome {
  assetId: string;
  part?: string;
  rowsBefore: number;
  rowsErased: number;
  referencesScrubbed: number;
  objectsRewritten?: number;
  keysDeleted?: number;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface RowRule {
  /** Removes the row when it returns true. */
  remove: (row: Record<string, unknown>) => boolean;
  /** Reference columns whose value equals `refValue` become REDACTED. */
  refColumns: string[];
  refValue: string | null;
  /** Rows of protected (held) subjects are never modified by reference scrubbing (SPEC.md 8.8). */
  protect?: (row: Record<string, unknown>) => boolean;
  /**
   * Line prefilter (SPEC.md section 30.3.1): a line that contains none of `needles` verbatim is never parsed; it is
   * kept (`unmatched: "keep"`, deletion: a row of the subject, or a reference to it, always contains the subject's id)
   * or removed (`unmatched: "remove"`, retention minimization: a row of a held subject always contains that subject's
   * id). Only candidate lines are JSON-parsed or split, so CPU follows the subject's rows instead of the object size.
   * The output is byte-identical to the transform without the prefilter (test/worker/erase.prefilter.test.ts).
   */
  prefilter?: { needles: readonly string[]; unmatched: "keep" | "remove" };
}

/** Pure transform used by deletion (remove the subject's rows, scrub references) and retention minimization. */
export function transformRows(body: string, format: "jsonl" | "csv", rule: RowRule): TransformResult {
  let rowsRemoved = 0;
  let refsScrubbed = 0;
  const pf = rule.prefilter;
  const candidate = (line: string) => !pf || pf.needles.some((n) => line.includes(n));
  if (format === "csv") {
    const lines = body.split("\n");
    const header = splitCsvLine(lines[0] ?? "");
    const kept = [lines[0] ?? ""];
    for (const line of lines.slice(1)) {
      if (!line) continue;
      if (!candidate(line)) {
        if (pf!.unmatched === "keep") kept.push(line);
        else rowsRemoved++;
        continue;
      }
      const cells = splitCsvLine(line);
      const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
      if (rule.remove(row)) {
        rowsRemoved++;
        continue;
      }
      let changed = false;
      for (const col of rule.protect?.(row) ? [] : rule.refColumns) {
        if (rule.refValue !== null && row[col] === rule.refValue) {
          row[col] = REDACTED;
          refsScrubbed++;
          changed = true;
        }
      }
      kept.push(changed ? header.map((h) => csvCell(String(row[h] ?? ""))).join(",") : line);
    }
    return { body: kept.join("\n") + "\n", rowsRemoved, refsScrubbed };
  }
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    if (!candidate(line)) {
      if (pf!.unmatched === "keep") out.push(line);
      else rowsRemoved++;
      continue;
    }
    const row = JSON.parse(line) as Record<string, unknown>;
    if (rule.remove(row)) {
      rowsRemoved++;
      continue;
    }
    let changed = false;
    for (const col of rule.protect?.(row) ? [] : rule.refColumns) {
      if (rule.refValue !== null && row[col] === rule.refValue) {
        row[col] = REDACTED;
        refsScrubbed++;
        changed = true;
      }
    }
    out.push(changed ? JSON.stringify(row) : line);
  }
  return { body: out.length ? out.join("\n") + "\n" : "", rowsRemoved, refsScrubbed };
}

/** The deletion rule for one subject: remove its rows, scrub references to it, never touch held subjects' rows. */
export function deletionRule(part: AssetPart, subjectColumn: string, value: string, protectedValues: ReadonlySet<string> = new Set()): RowRule {
  return {
    remove: (row) => row[subjectColumn] === value,
    refColumns: part.referenceColumns,
    refValue: value,
    protect: (row) => protectedValues.has(String(row[subjectColumn])),
    prefilter: { needles: [value], unmatched: "keep" },
  };
}

/** Removes the subject's rows from one object and scrubs references (one compare-and-swap rewrite). */
export async function eraseObject(
  bucket: R2Bucket,
  key: string,
  part: AssetPart,
  subjectColumn: string,
  value: string,
  requestId: string,
  protectedValues: ReadonlySet<string> = new Set(),
): Promise<{ changed: boolean; rowsRemoved: number; refsScrubbed: number }> {
  const format = part.format ?? "jsonl";
  const rule = deletionRule(part, subjectColumn, value, protectedValues);
  const res = await rewriteObject(bucket, key, (body) => (body.includes(value) ? transformRows(body, format, rule) : { body, rowsRemoved: 0, refsScrubbed: 0 }), {
    metadata: { pv_rewritten_by: requestId },
  });
  return { changed: res.changed, rowsRemoved: res.rowsRemoved, refsScrubbed: res.refsScrubbed };
}
