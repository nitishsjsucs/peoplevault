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
}

/** Pure transform used by deletion (remove the subject's rows, scrub references) and retention minimization. */
export function transformRows(body: string, format: "jsonl" | "csv", rule: RowRule): TransformResult {
  let rowsRemoved = 0;
  let refsScrubbed = 0;
  if (format === "csv") {
    const lines = body.split("\n");
    const header = splitCsvLine(lines[0] ?? "");
    const kept = [lines[0] ?? ""];
    for (const line of lines.slice(1)) {
      if (!line) continue;
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

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/**
 * Removes every row whose subject column equals `value` from every object of one asset part, and scrubs the part's
 * reference columns, never touching rows of protected (held) subjects. Each object is a compare-and-swap rewrite.
 */
export async function eraseObjects(
  bucket: R2Bucket,
  assetId: string,
  part: AssetPart,
  subjectColumn: string,
  value: string,
  requestId: string,
  protectedValues: ReadonlySet<string> = new Set(),
): Promise<EraseOutcome> {
  const outcome: EraseOutcome = { assetId, part: part.name, rowsBefore: 0, rowsErased: 0, referencesScrubbed: 0, objectsRewritten: 0 };
  const format = part.format ?? "jsonl";
  for (const key of await listKeys(bucket, part.location ?? "")) {
    const res = await rewriteObject(
      bucket,
      key,
      (body) => {
        if (!body.includes(value)) return { body, rowsRemoved: 0, refsScrubbed: 0 };
        return transformRows(body, format, {
          remove: (row) => row[subjectColumn] === value,
          refColumns: part.referenceColumns,
          refValue: value,
          protect: (row) => protectedValues.has(String(row[subjectColumn])),
        });
      },
      { metadata: { pv_rewritten_by: requestId } },
    );
    if (res.changed) outcome.objectsRewritten! += 1;
    outcome.rowsErased += res.rowsRemoved;
    outcome.referencesScrubbed += res.refsScrubbed;
  }
  outcome.rowsBefore = outcome.rowsErased + outcome.referencesScrubbed;
  return outcome;
}

/** Counts rows and references of a value in one part without changing anything (plan-time discovery). */
export async function countInObjects(bucket: R2Bucket, part: AssetPart, subjectColumn: string, value: string): Promise<{ rows: number; refs: number; objects: number }> {
  const format = part.format ?? "jsonl";
  let rows = 0;
  let refs = 0;
  let objects = 0;
  for (const key of await listKeys(bucket, part.location ?? "")) {
    const obj = await bucket.get(key);
    if (!obj) continue;
    const body = await obj.text();
    if (!body.includes(value)) continue;
    const t = transformRows(body, format, { remove: (row) => row[subjectColumn] === value, refColumns: part.referenceColumns, refValue: value });
    if (t.rowsRemoved + t.refsScrubbed > 0) objects++;
    rows += t.rowsRemoved;
    refs += t.refsScrubbed;
  }
  return { rows, refs, objects };
}
