// Retention evaluation for Worker-native assets (SPEC.md section 8.7). One boundary rule: cutoff = as_of - period,
// and an item is past retention if and only if its basis date is on or before the cutoff (inclusive).
import type { AssetPart } from "../../shared/policy-types.ts";

export function parseDate(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function minusDays(asOf: string, days: number): string {
  return isoDate(new Date(parseDate(asOf).getTime() - days * 86_400_000));
}

export function minusMonths(asOf: string, months: number): string {
  const d = parseDate(asOf);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() - months;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last))));
}

export const minusYears = (asOf: string, years: number) => minusMonths(asOf, 12 * years);

export function isPast(basis: string, cutoff: string): boolean {
  return basis <= cutoff;
}

export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return isoDate(new Date(Date.UTC(y, m, 0)));
}

export function cycleEnd(cycle: string): string {
  const y = Number(cycle.slice(0, 4));
  return cycle.endsWith("H1") ? `${y}-06-30` : `${y}-12-31`;
}

/** The retention basis date of an R2 export object, from its key; null when the key has no recognizable date. */
export function exportBasisDate(key: string): string | null {
  let m = /\/dt=(\d{4}-\d{2}-\d{2})\//.exec(key);
  if (m) return m[1]!;
  m = /\/(?:period|month)=(\d{4}-\d{2})\//.exec(key);
  if (m) return monthEnd(m[1]!);
  m = /\/cycle=(\d{4}H[12])\//.exec(key);
  if (m) return cycleEnd(m[1]!);
  return null;
}

export function cutoffFor(part: AssetPart, asOf: string): string | null {
  const r = part.retention;
  if (!r) return null;
  if (r.days !== undefined) return minusDays(asOf, r.days);
  if (r.months !== undefined) return minusMonths(asOf, r.months);
  return null;
}

export function utcToday(now = new Date()): string {
  return isoDate(now);
}
