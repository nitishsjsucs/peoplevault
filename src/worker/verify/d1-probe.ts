// Independent D1 probe: every TEXT column of every table from sqlite_master, minus the internal tables (_cf_*,
// sqlite_*, d1_migrations) and the stage exclusions. A table that cannot be read is reported as an error, never clean.
import { POLICY } from "../policy/compiled.ts";
import { countMatches, type TokenMatcher } from "./tokens.ts";
import { d1AssetFor, type Finding, type ProbeResult } from "./findings.ts";

export type D1Stage = "before_identity_erasure" | "before_redaction" | "final";

export function excludedTables(stage: D1Stage): Set<string> {
  const ex = POLICY.verification.d1StageExclusions;
  return new Set(stage === "final" ? [] : ex[stage]);
}

function internal(name: string): boolean {
  return POLICY.verification.d1InternalPrefixes.some((p) => name.startsWith(p)) || POLICY.verification.d1InternalTables.includes(name);
}

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function probeD1(db: D1Database, matchers: TokenMatcher[], stage: D1Stage): Promise<ProbeResult> {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  const skip = excludedTables(stage);
  const findings: Finding[] = [];
  const errors: ProbeResult["errors"] = [];
  let scanned = 0;
  for (const { name } of results) {
    if (internal(name) || skip.has(name)) continue;
    if (!SAFE_IDENT.test(name)) {
      errors.push({ store: "d1", location: name.replace(/[^A-Za-z0-9_]/g, "_"), error: "unsafe_table_name" });
      continue;
    }
    scanned++;
    try {
      const cols = await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string; type: string }>();
      const textCols = cols.results.filter((c) => SAFE_IDENT.test(c.name) && (c.type === "" || /TEXT|CHAR|CLOB/i.test(c.type))).map((c) => c.name);
      if (textCols.length === 0) continue;
      const rows = await db.prepare(`SELECT ${textCols.join(", ")} FROM ${name}`).all<Record<string, unknown>>();
      let matches = 0;
      for (const row of rows.results) for (const c of textCols) matches += countMatches(c, row[c], matchers);
      if (matches > 0) findings.push({ store: "d1", location: name, assetId: d1AssetFor(name), matches });
    } catch {
      errors.push({ store: "d1", location: name, error: "read_failed" });
    }
  }
  return { findings, errors, scanned };
}
