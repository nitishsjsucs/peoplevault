import { describe, expect, it } from "vitest";
import type { Principal } from "../../src/worker/auth/principals.ts";
import { POLICY } from "../../src/worker/policy/compiled.ts";
import { columnsFor, decide, filterColumns, type Action } from "../../src/worker/policy/pdp.ts";
import { PERSONAS, PURPOSES } from "../../src/shared/policy-types.ts";

const human = (persona: Principal["persona"], extra: Partial<Principal> = {}): Principal => ({
  id: "p-1",
  kind: "human",
  persona,
  employeeId: "E10002",
  orgUnits: persona === "hr_partner" ? ["ENG-PRODUCT", "SALES-NA"] : [],
  ...extra,
});
const executor: Principal = { id: "pv-executor-local", kind: "system", systemRole: "executor", orgUnits: [] };

describe("personas and purposes", () => {
  it("has exactly 4 personas and 5 purposes, each purpose bound to its own BigQuery identity", () => {
    expect(Object.keys(POLICY.personas)).toEqual([...PERSONAS]);
    expect(PERSONAS).toHaveLength(4);
    expect(Object.keys(POLICY.purposes)).toEqual([...PURPOSES]);
    expect(new Set(Object.values(POLICY.purposes).map((p) => p.bqIdentity)).size).toBe(5);
  });

  it("maps persona to purpose exactly as the policy says", () => {
    const mapping = Object.fromEntries(PERSONAS.map((p) => [p, PURPOSES.filter((pu) => decide({ principal: human(p), purpose: pu, action: pu === "privacy_compliance" ? "read_report" : pu === "legal_hold_management" ? "place_legal_hold" : "list_employees" }).allow)]));
    expect(mapping).toEqual({
      hr_partner: ["employee_relations"],
      manager: ["team_management"],
      people_analyst: ["workforce_analytics"],
      privacy_officer: ["privacy_compliance", "legal_hold_management"],
    });
  });

  it("denies unknown purposes with 404 and unheld purposes with 403", () => {
    expect(decide({ principal: human("manager"), purpose: "marketing", action: "list_employees" })).toEqual({ allow: false, status: 404, reason: "unknown_purpose" });
    expect(decide({ principal: human("manager"), purpose: "employee_relations", action: "list_employees" })).toEqual({ allow: false, status: 403, reason: "purpose_not_permitted" });
    expect(decide({ principal: human("privacy_officer"), purpose: "privacy_compliance", action: "read_profile" })).toEqual({ allow: false, status: 403, reason: "action_not_permitted" });
  });

  it("system principals cannot call data routes; humans cannot call executor routes", () => {
    for (const action of ["list_employees", "read_profile", "identity_lookup", "create_deletion_request"] as Action[]) {
      expect(decide({ principal: executor, purpose: "employee_relations", action })).toMatchObject({ allow: false, status: 403, reason: "human_only" });
    }
    for (const persona of PERSONAS) {
      for (const action of ["executor_claim", "executor_complete", "executor_suppression"] as Action[]) {
        expect(decide({ principal: human(persona), action })).toMatchObject({ allow: false, status: 403, reason: "system_only" });
      }
    }
    expect(decide({ principal: executor, action: "executor_claim" })).toMatchObject({ allow: true });
  });

  it("derives row scope from the principal only", () => {
    const hr = decide({ principal: human("hr_partner"), purpose: "employee_relations", action: "read_profile" });
    expect(hr).toMatchObject({ allow: true, rowScope: { kind: "org_units", orgUnits: ["ENG-PRODUCT", "SALES-NA"] }, bqIdentity: "peoplevault-er-reader" });
    const mgr = decide({ principal: human("manager"), purpose: "team_management", action: "read_profile" });
    expect(mgr).toMatchObject({ allow: true, rowScope: { kind: "direct_reports", managerEmployeeId: "E10002" } });
    const wa = decide({ principal: human("people_analyst"), purpose: "workforce_analytics", action: "read_dataset" });
    expect(wa).toMatchObject({ allow: true, rowScope: { kind: "all" } });
  });
});

describe("column filtering", () => {
  it("drops deny and unlisted columns and masks again in the Worker", () => {
    const q = POLICY.queries["team_management.profile"]!;
    const cols = columnsFor(q);
    expect(cols.base_salary).toBe("mask_nullify");
    expect(cols.gender).toBeUndefined();
    const rows = filterColumns([{ employee_ref: "er_x", base_salary: 123000, gender: "female", birth_date: "1990-04-05", full_name: "A B" }], cols);
    expect(rows).toEqual([{ employee_ref: "er_x", base_salary: null, full_name: "A B" }]);
    const er = filterColumns([{ birth_date: "1990-04-05", leave_type: "medical" }], columnsFor(POLICY.queries["employee_relations.profile"]!));
    expect(er).toEqual([{ birth_date: "1990-01-01", leave_type: null }]);
  });

  it("no compiled query exposes a deny column", () => {
    for (const q of Object.values(POLICY.queries)) for (const c of q.columns) expect(c.visibility).not.toBe("deny");
  });
});
