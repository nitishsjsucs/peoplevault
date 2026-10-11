// Independent D1 probe: every TEXT column of every table from sqlite_master, minus the internal tables (_cf_*,
// sqlite_*, d1_migrations) and the stage exclusions. A table that cannot be read is reported as an error, never clean.
//
// Workers Free (SPEC.md section 30.3.1): tokens are matched inside SQLite. One query per table selects only rows in
// which some TEXT column contains some token (`instr(column, ?n) > 0`, case-sensitive like the Worker's matchers),
// and the boundary-aware matchers decide on those candidate rows only. Every match needs a token inside the value
// (exact columns compare equal, the others test `includes` first), so the findings equal a full scan's, and a clean
// deletion sends no row to the Worker however large the audit table grows. Rows read are unchanged (full scans).
// A probe makes 1 + 2T statements for T tables; at most D1_PROBE_TABLES_PER_STEP tables per Workflow step keeps
// every step under 40 statements with the step's own reads and writes, and a longer table list continues in the next
// step from `next` (an index, never a name).
import { POLICY } from "../policy/compiled.ts";
import { countMatches, type TokenMatcher } from "./tokens.ts";
import { d1AssetFor, type Finding, type ProbeResult } from "./findings.ts";

export type D1Stage = "before_identity_erasure" | "before_redaction" | "final";

/** 1 + 2 x 16 = 33 probe statements, leaving 7 for the step's own reads and writes under the 40-statement cap. */
export const D1_PROBE_TABLES_PER_STEP = 16;

export function excludedTables(stage: D1Stage): Set<string> {
  const ex = POLICY.verification.d1StageExclusions;
  return new Set(stage === "final" ? [] : ex[stage]);
}

function internal(name: string): boolean {
  return POLICY.verification.d1InternalPrefixes.some((p) => name.startsWith(p)) || POLICY.verification.d1InternalTables.includes(name);
}

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface D1ProbeOptions {
  /** index of the first table (in name order) to scan */
  from?: number;
  maxTables?: number;
  /** rows to leave out, per table: `column IS NOT value` (the final stage leaves out this request's own task rows) */
  skipRows?: Record<string, { column: string; value: string }>;
}

export interface D1ProbeResult extends ProbeResult {
  /** index of the next table to scan, or null when every table has been scanned */
  next: number | null;
  tables: number;
}

export async function probeD1(db: D1Database, matchers: TokenMatcher[], stage: D1Stage, opts: D1ProbeOptions = {}): Promise<D1ProbeResult> {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  const skip = excludedTables(stage);
  const tables = results.map((r) => r.name).filter((name) => !internal(name) && !skip.has(name));
  const from = opts.from ?? 0;
  const max = opts.maxTables ?? D1_PROBE_TABLES_PER_STEP;
  const findings: Finding[] = [];
  const errors: ProbeResult["errors"] = [];
  const tokens = [...new Set(matchers.map((m) => m.token))];
  let scanned = 0;
  for (const name of tables.slice(from, from + max)) {
    if (!SAFE_IDENT.test(name)) {
      errors.push({ store: "d1", location: name.replace(/[^A-Za-z0-9_]/g, "_"), error: "unsafe_table_name" });
      continue;
    }
    scanned++;
    try {
      const cols = await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string; type: string }>();
      const textCols = cols.results.filter((c) => SAFE_IDENT.test(c.name) && (c.type === "" || /TEXT|CHAR|CLOB/i.test(c.type))).map((c) => c.name);
      if (textCols.length === 0 || tokens.length === 0) continue;
      const any = textCols.flatMap((c) => tokens.map((_, i) => `instr(${c}, ?${i + 1}) > 0`)).join(" OR ");
      const rowSkip = opts.skipRows?.[name];
      const where = rowSkip && SAFE_IDENT.test(rowSkip.column) ? `(${any}) AND ${rowSkip.column} IS NOT ?${tokens.length + 1}` : any;
      const binds = rowSkip ? [...tokens, rowSkip.value] : tokens;
      const rows = await db.prepare(`SELECT ${textCols.join(", ")} FROM ${name} WHERE ${where}`).bind(...binds).all<Record<string, unknown>>();
      let matches = 0;
      for (const row of rows.results) for (const c of textCols) matches += countMatches(c, row[c], matchers);
      if (matches > 0) findings.push({ store: "d1", location: name, assetId: d1AssetFor(name), matches });
    } catch {
      errors.push({ store: "d1", location: name, error: "read_failed" });
    }
  }
  const next = from + max < tables.length ? from + max : null;
  return { findings, errors, scanned, next, tables: tables.length };
}
