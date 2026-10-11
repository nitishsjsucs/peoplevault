// Resolves a verified Access identity to a D1 principal (SPEC.md section 11.2). Persona, org units and the employee
// link come only from D1, never from token claims or request parameters; Access group claims are ignored.
import type { Persona, SystemRole } from "../../shared/policy-types.ts";
import type { VerifiedIdentity } from "./access-verifier.ts";

export interface Principal {
  id: string;
  kind: "human" | "system";
  persona?: Persona;
  systemRole?: SystemRole;
  employeeId?: string;
  orgUnits: string[];
}

export class PrincipalError extends Error {
  override name = "PrincipalError";
  readonly code: "unknown_principal" | "principal_disabled";
  constructor(code: "unknown_principal" | "principal_disabled") {
    super(code);
    this.code = code;
  }
}

interface PrincipalRow {
  id: string;
  kind: "human" | "system";
  persona: Persona | null;
  system_role: SystemRole | null;
  employee_id: string | null;
  org_units: string;
  status: "active" | "disabled";
}

export async function resolvePrincipal(db: D1Database, id: VerifiedIdentity): Promise<Principal> {
  const row =
    id.kind === "user"
      ? await db
          .prepare("SELECT id, kind, persona, system_role, employee_id, org_units, status FROM principals WHERE email = ?")
          .bind(id.email ?? "")
          .first<PrincipalRow>()
      : await db
          .prepare("SELECT id, kind, persona, system_role, employee_id, org_units, status FROM principals WHERE service_client_id = ?")
          .bind(id.commonName ?? "")
          .first<PrincipalRow>();
  if (!row) throw new PrincipalError("unknown_principal");
  if (row.status !== "active") throw new PrincipalError("principal_disabled");
  let orgUnits: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.org_units);
    if (Array.isArray(parsed)) orgUnits = parsed.filter((u): u is string => typeof u === "string");
  } catch {
    orgUnits = [];
  }
  const p: Principal = { id: row.id, kind: row.kind, orgUnits };
  if (row.persona) p.persona = row.persona;
  if (row.system_role) p.systemRole = row.system_role;
  if (row.employee_id) p.employeeId = row.employee_id;
  return p;
}
