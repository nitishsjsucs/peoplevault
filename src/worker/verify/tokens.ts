// Identifier tokens and boundary-aware matchers (SPEC.md section 14.3). Must not import from erase/ or workflows/
// (test/node/verify.isolation.test.ts). Patterns are RE2-compatible (no lookbehind), identical to
// pipelines/src/peoplevault/verify/tokens.py, so BigQuery, DuckDB, Python and JavaScript agree.
import { POLICY } from "../policy/compiled.ts";

export type TokenKind = "employee_id" | "work_email" | "full_name" | "employee_ref" | "warehouse_key" | "analytics_id";

export interface SubjectTokens {
  employeeId: string;
  workEmail: string;
  fullName: string;
  employeeRef: string;
  warehouseKey: string;
  analyticsId: string;
}

export interface TokenMatcher {
  kind: TokenKind;
  token: string;
  test(value: string): boolean;
}

export const EXACT_COLUMNS: ReadonlySet<string> = new Set(POLICY.verification.exactColumns);

const RE2_SPECIAL = /[\\.^$|?*+()[\]{}/]/g;
export const re2Escape = (s: string) => s.replace(RE2_SPECIAL, (c) => `\\${c}`);

export function patternFor(kind: TokenKind, token: string): string {
  const esc = re2Escape(token);
  switch (kind) {
    case "work_email":
      return `(?:^|[^A-Za-z0-9._%+-])${esc}(?:$|[^A-Za-z0-9-])`;
    case "full_name":
      return `(?:^|[^A-Za-z])${esc}(?:$|[^A-Za-z])`;
    case "employee_id":
      return `(?:^|[^A-Za-z0-9])${esc}(?:$|[^0-9])`;
    default:
      return `(?:^|[^a-z0-9_])${esc}(?:$|[^a-z0-9])`;
  }
}

export function subjectMatchers(s: SubjectTokens, opts: { includeFullName: boolean }): TokenMatcher[] {
  const pairs: [TokenKind, string][] = [
    ["employee_id", s.employeeId],
    ["work_email", s.workEmail],
    ["employee_ref", s.employeeRef],
    ["warehouse_key", s.warehouseKey],
    ["analytics_id", s.analyticsId],
  ];
  if (opts.includeFullName) pairs.push(["full_name", s.fullName]);
  return pairs
    .filter(([, token]) => token.length > 0)
    .map(([kind, token]) => {
      const re = new RegExp(patternFor(kind, token));
      return { kind, token, test: (value: string) => value.includes(token) && re.test(value) };
    });
}

/** Number of matches in one value: exact equality on identifier columns, boundary-aware search elsewhere. */
export function countMatches(column: string | null, value: unknown, matchers: TokenMatcher[]): number {
  if (value === null || value === undefined) return 0;
  const text = typeof value === "string" ? value : String(value);
  if (column !== null && EXACT_COLUMNS.has(column)) return matchers.some((m) => text === m.token) ? 1 : 0;
  return matchers.some((m) => m.test(text)) ? 1 : 0;
}

export function anyTokenIncluded(text: string, matchers: TokenMatcher[]): boolean {
  return matchers.some((m) => text.includes(m.token));
}

/** Replaces token occurrences in a location (an R2 key, a KV key, a table name) so findings never carry values. */
export function redactLocation(location: string, matchers: TokenMatcher[]): string {
  let out = location;
  for (const m of matchers) out = out.split(m.token).join("[redacted]");
  return out;
}
