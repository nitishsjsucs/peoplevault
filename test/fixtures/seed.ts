// Loads the committed D1 seed for the fixture world (principals, identity_map, legal_holds, suppression_list).
import { env } from "cloudflare:workers";
import seedSql from "../../data/fixtures/d1_seed.sql?raw";
import subjects from "../../data/fixtures/authz_subjects.json";
import { buildApp } from "../../src/worker/app.ts";
import { createFakeWarehouse, type FakeOptions, type FakeWarehouse } from "./fake-warehouse.ts";
import { serviceToken, userToken } from "./tokens.ts";

export async function seedWorld(): Promise<void> {
  const already = await env.DB.prepare("SELECT COUNT(*) AS n FROM principals").first<{ n: number }>();
  if ((already?.n ?? 0) > 0) return;
  const statements = seedSql
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .split(/;\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

export interface SubjectEntry {
  employee_ref: string;
  analytics_id: string;
  subject_ref: string;
  truth: Record<string, unknown>;
}

export const SUBJECTS = (subjects as unknown as { principals: Record<string, Record<string, SubjectEntry[]>> }).principals;

export function subject(principal: string, selector: string, index = 0): SubjectEntry {
  const s = SUBJECTS[principal]?.[selector]?.[index];
  if (!s) throw new Error(`no subject ${principal}/${selector}/${index}`);
  return s;
}

export async function tokenFor(principalId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT email, service_client_id FROM principals WHERE id = ?").bind(principalId).first<{ email: string | null; service_client_id: string | null }>();
  if (!row) throw new Error(`unknown principal ${principalId}`);
  return row.email ? userToken(row.email) : serviceToken(row.service_client_id!);
}

export function worldApp(opts: FakeOptions = {}): { app: ReturnType<typeof buildApp>; wh: FakeWarehouse } {
  const wh = createFakeWarehouse(opts);
  return { app: buildApp({ warehouseFactory: () => wh }), wh };
}

export const BASE = "http://127.0.0.1:8793";
export const CSRF = { "X-PV-Requested-With": "peoplevault" };

export async function call(app: ReturnType<typeof buildApp>, principalId: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": await tokenFor(principalId), ...extraHeaders };
  if (method !== "GET") Object.assign(headers, CSRF, { "content-type": "application/json" });
  return app.request(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
}

export interface WorldIdentity {
  employee_id: string;
  work_email: string;
  full_name: string;
  employee_ref: string;
  warehouse_key: string;
  analytics_id: string;
  subject_ref: string;
  manager_employee_id: string | null;
}

export async function identityOf(employeeRef: string): Promise<WorldIdentity> {
  const row = await env.DB.prepare("SELECT * FROM identity_map WHERE employee_ref = ?").bind(employeeRef).first<WorldIdentity>();
  if (!row) throw new Error("identity not found");
  return row;
}

/** Small R2 and KV fixtures for workflow tests: one object per export family and one extract, built from D1. */
export async function seedObjects(): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM identity_map ORDER BY employee_id").all<WorldIdentity>();
  const hris = results
    .map((r) => JSON.stringify({ employee_id: r.employee_id, full_name: r.full_name, work_email: r.work_email, personal_email: "x@example.test", phone: "+1-555-0150", birth_date: "1990-01-02", gender: "female", ethnicity: "group_a", hire_date: "2020-01-01", termination_date: null, employment_status: "active", job_title: "Engineer", job_level: "IC2", org_unit: "ENG-PRODUCT", location: "Austin", manager_employee_id: r.manager_employee_id, is_restricted: false, export_date: "2026-09-28" }))
    .join("\n");
  await env.EXPORTS.put("exports/hris/employees/dt=2026-09-28/employees.jsonl", hris + "\n");
  const payroll = ["employee_id,pay_period_end,base_salary,bonus_target_pct,currency", ...results.map((r) => `${r.employee_id},2026-09-30,100000.0,10.0,USD`)].join("\n");
  await env.EXPORTS.put("exports/payroll/compensation/period=2026-09/compensation.csv", payroll + "\n");
  const leave = results.slice(0, 10).map((r, i) => JSON.stringify({ leave_id: `LV-90000${i}`, employee_id: r.employee_id, start_date: "2026-09-08", end_date: "2026-09-10", leave_type: "medical", leave_category: "statutory", leave_reason: "Treatment for a short-term illness", accommodation_note: "", status: "approved" }));
  await env.EXPORTS.put("exports/leave/requests/month=2026-09/requests.jsonl", leave.join("\n") + "\n");
  const perf = results.map((r, i) => JSON.stringify({ review_id: `RV-90000${i}`, employee_id: r.employee_id, cycle: "2026H1", rating: 3, review_text: "Met expectations with steady delivery across the cycle.", reviewer_employee_id: r.manager_employee_id }));
  await env.EXPORTS.put("exports/performance/reviews/cycle=2026H1/reviews.jsonl", perf.join("\n") + "\n");
  const extract = results.map((r) => JSON.stringify({ analytics_id: r.analytics_id, org_unit: "ENG-PRODUCT", job_level: "IC2", salary_band: "80k_120k", rating_band: "mid", tenure_years: 3, age_band: "25_34", gender: "female", terminated_in_month: false }));
  await env.DERIVED.put("extracts/workforce_analytics/attrition/month=2026-09/attrition.jsonl", extract.join("\n") + "\n", { customMetadata: { purpose: "workforce_analytics", subject_key: "analytics_id", created_by: "analyst-01", month: "2026-09" } });
}

/** A plausible executor result for every Python asset (what pv executor would report for a clean erase). */
export function executorEraseResult(opts: { ok?: boolean; findings?: { store: "warehouse" | "iceberg"; location: string; asset_id: string | null; matches: number }[] } = {}) {
  const asset = (id: string, applicability = "present") => ({
    asset_id: id,
    applicability,
    rows_before: applicability === "aggregate_recompute" ? 0 : 3,
    rows_erased: applicability === "aggregate_recompute" ? 0 : 3,
    references_scrubbed: 0,
    action_status: applicability === "aggregate_recompute" ? "recomputed" : "erased",
    verify_status: applicability === "aggregate_recompute" ? "not_applicable" : "clean",
    verify_matches: 0,
  });
  return {
    taskId: "x",
    ok: opts.ok ?? true,
    result: {
      assets: [
        asset("wh.raw"),
        asset("wh.core"),
        asset("hist.dbt.dim_employee_history"),
        asset("hist.lake.employee_monthly"),
        asset("id.wh.identity_xref"),
        asset("drv.marts.attrition_features"),
        asset("drv.marts.team_roster"),
        asset("drv.marts.headcount_monthly", "aggregate_recompute"),
      ],
      findings: opts.findings ?? [],
      residuals: [
        { kind: "iceberg_snapshots", asset_id: "hist.lake.employee_monthly", table: "hr_history.employee_monthly", state: "pending", evidence: "observed", deleted_at: "2026-10-10T00:00:00Z", expected_clear_at: null, snapshot_id: 12345, retained_snapshots: 8 },
        { kind: "bq_time_travel", asset_id: "wh.core", table: "peoplevault_core.dim_employee", state: "modeled", evidence: "modeled", deleted_at: "2026-10-10T00:00:00Z", expected_clear_at: "2026-10-12T00:00:00Z" },
      ],
      counts: {},
    },
  };
}

export function executorIdentityResult(ok = true) {
  return {
    taskId: "y",
    ok,
    result: { assets: [{ asset_id: "id.wh.identity_xref", applicability: "present", rows_before: 1, rows_erased: 1, references_scrubbed: 0, action_status: "erased", verify_status: "clean", verify_matches: 0 }], findings: [], residuals: [], counts: {} },
  };
}
