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
