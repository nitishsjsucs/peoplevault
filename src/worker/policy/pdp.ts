// Policy decision point (SPEC.md section 11.3): pure and synchronous over the compiled policy. Deny by default.
import type { Persona, Purpose, QueryDef, Visibility } from "../../shared/policy-types.ts";
import { isPurpose } from "../../shared/policy-types.ts";
import type { Principal } from "../auth/principals.ts";
import { POLICY } from "./compiled.ts";

export type Action =
  | "list_employees"
  | "read_profile"
  | "read_dataset"
  | "create_extract"
  | "identity_lookup"
  | "create_deletion_request"
  | "read_deletion_request"
  | "place_legal_hold"
  | "release_legal_hold"
  | "read_legal_holds"
  | "read_assets"
  | "read_report"
  | "read_audit"
  | "run_retention"
  | "triage_schema_drift"
  | "executor_claim"
  | "executor_complete"
  | "executor_suppression"
  | "executor_audit_export";

export const SYSTEM_ACTIONS: ReadonlySet<Action> = new Set(["executor_claim", "executor_complete", "executor_suppression", "executor_audit_export"]);

export type RowScope =
  | { kind: "org_units"; orgUnits: string[] }
  | { kind: "direct_reports"; managerEmployeeId: string }
  | { kind: "all" }
  | { kind: "identity_lookup" }
  | { kind: "none" };

export interface DecisionInput {
  principal: Principal;
  purpose?: string;
  action: Action;
}

export type DenyReason = "purpose_not_permitted" | "action_not_permitted" | "unknown_purpose" | "system_only" | "human_only";

export type Decision =
  | { allow: true; reason: "ok"; purpose?: Purpose; persona?: Persona; queryIdPrefix?: string; bqIdentity?: string; rowScope: RowScope }
  | { allow: false; status: 403 | 404; reason: DenyReason };

function rowScopeFor(principal: Principal, purpose: Purpose): RowScope {
  const scope = POLICY.purposes[purpose].rowScope;
  switch (scope) {
    case "org_units":
      return { kind: "org_units", orgUnits: [...principal.orgUnits] };
    case "direct_reports":
      return principal.employeeId ? { kind: "direct_reports", managerEmployeeId: principal.employeeId } : { kind: "none" };
    case "all":
      return { kind: "all" };
    case "identity_lookup":
      return { kind: "identity_lookup" };
  }
}

export function decide(input: DecisionInput): Decision {
  const { principal, action } = input;
  const systemAction = SYSTEM_ACTIONS.has(action);
  if (principal.kind === "system") {
    if (!systemAction) return { allow: false, status: 403, reason: "human_only" };
    const role = principal.systemRole;
    if (!role || !POLICY.systemRoles[role]?.actions.includes(action)) return { allow: false, status: 403, reason: "action_not_permitted" };
    return { allow: true, reason: "ok", rowScope: { kind: "none" } };
  }
  if (systemAction) return { allow: false, status: 403, reason: "system_only" };
  const persona = principal.persona;
  if (!persona) return { allow: false, status: 403, reason: "action_not_permitted" };
  if (input.purpose === undefined) return { allow: false, status: 404, reason: "unknown_purpose" };
  if (!isPurpose(input.purpose)) return { allow: false, status: 404, reason: "unknown_purpose" };
  const purpose = input.purpose;
  const grants = POLICY.personas[persona].grants[purpose];
  if (!grants) return { allow: false, status: 403, reason: "purpose_not_permitted" };
  if (!grants.includes(action)) return { allow: false, status: 403, reason: "action_not_permitted" };
  const p = POLICY.purposes[purpose];
  const rowScope = rowScopeFor(principal, purpose);
  // a direct_reports purpose without an employee link has no rows of its own: deny instead of allowing scope "none"
  if (rowScope.kind === "none") return { allow: false, status: 403, reason: "action_not_permitted" };
  return { allow: true, reason: "ok", purpose, persona, queryIdPrefix: purpose, bqIdentity: p.bqIdentity, rowScope };
}

/** Visibility of every output column of a named query (deny columns are never part of a query's output). */
export function columnsFor(q: QueryDef): Record<string, Visibility> {
  return Object.fromEntries(q.columns.map((c) => [c.name, c.visibility]));
}

function maskDateYear(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(s);
  return m ? `${m[1]}-01-01` : null;
}

/**
 * Keeps only the listed columns and enforces their visibility again in the Worker: columns that are not listed
 * (or are `deny`) are dropped even if the warehouse returned them, `mask_nullify` becomes null and
 * `mask_date_year` becomes January 1 of the same year.
 */
export function filterColumns(rows: Record<string, unknown>[], columns: Record<string, Visibility>): Record<string, unknown>[] {
  const entries = Object.entries(columns).filter(([, v]) => v !== "deny");
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [name, vis] of entries) {
      if (!(name in row)) continue;
      const v = row[name];
      out[name] = vis === "mask_nullify" ? null : vis === "mask_date_year" ? maskDateYear(v) : v;
    }
    return out;
  });
}
