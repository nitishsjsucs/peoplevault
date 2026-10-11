// Sample values of one column of a quarantined export (SPEC.md section 16.3): at most 5 distinct non-empty values from
// the first 256 KiB of the object (a ranged R2 read, so a large export costs the same CPU as a small one). The values
// go to the triage model only: they are never stored, logged, audited or returned.
import { MAX_SAMPLES } from "./prompt.ts";

export const SAMPLE_READ_BYTES = 262_144;

/** Quarantine ids are export keys with "/" written as "__" (the loader's report file names, pipelines/.data/quarantine). */
const QUARANTINE_ID = /^exports__[a-z_]+__[a-z_]+__[a-z_]+=[0-9A-Za-z-]+__[a-z_]+\.(jsonl|csv)$/;

export function keyFromQuarantineId(id: string): string | null {
  return QUARANTINE_ID.test(id) ? id.split("__").join("/") : null;
}

function csvFields(line: string): string[] {
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

/** Whole lines only: a ranged read can end inside a line, which is dropped unless the object ended there. */
function wholeLines(text: string, complete: boolean): string[] {
  const lines = text.split("\n");
  if (!complete) lines.pop();
  return lines.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
}

/** Up to 5 distinct sample values, or null when the column is not in the object. */
export function sampleValues(key: string, text: string, complete: boolean, column: string): string[] | null {
  const lines = wholeLines(text, complete);
  const out = new Set<string>();
  let seen = false;
  if (key.endsWith(".csv")) {
    const [header, ...rows] = lines;
    if (!header) return null;
    const idx = csvFields(header).indexOf(column);
    if (idx < 0) return null;
    seen = true;
    for (const row of rows) {
      const v = csvFields(row)[idx]?.trim();
      if (v) out.add(v);
      if (out.size >= MAX_SAMPLES) break;
    }
  } else {
    for (const line of lines) {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object" || !(column in rec)) continue;
      seen = true;
      const v = (rec as Record<string, unknown>)[column];
      if (v !== null && v !== undefined && String(v).trim() !== "") out.add(typeof v === "object" ? JSON.stringify(v) : String(v));
      if (out.size >= MAX_SAMPLES) break;
    }
  }
  return seen ? [...out] : null;
}

export async function readSamples(bucket: R2Bucket, key: string, column: string): Promise<string[] | null | "missing_object"> {
  const obj = await bucket.get(key, { range: { offset: 0, length: SAMPLE_READ_BYTES } });
  if (!obj) return "missing_object";
  const text = await obj.text();
  return sampleValues(key, text, obj.size <= SAMPLE_READ_BYTES, column);
}
