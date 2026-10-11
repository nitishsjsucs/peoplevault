// Runs all 100 authorization cases of policy/cases/authz_cases.yaml against the Worker policy decision point through
// the real Hono app (buildApp), with D1 seeded from the fixture world and the FakeWarehouse serving rows produced by
// the real DuckDB purpose views. One `it` per case.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import casesText from "../../policy/cases/authz_cases.yaml?raw";
import { POLICY } from "../../src/worker/policy/compiled.ts";
import type { Purpose, TaggedClass } from "../../src/shared/policy-types.ts";
import { BASE, CSRF, SUBJECTS, seedWorld, subject, tokenFor, worldApp, type SubjectEntry } from "../fixtures/seed.ts";
import { algNoneToken, hs256ConfusionToken, serviceToken, userToken } from "../fixtures/tokens.ts";

interface SubjectSel {
  principal: string;
  selector: string;
  index: number;
}
interface Case {
  id: string;
  category: string;
  layers: string[];
  description: string;
  principal: string;
  token?: string;
  purpose?: string;
  action: string;
  subject?: SubjectSel;
  ref_kind?: "employee_ref" | "analytics_id";
  tamper?: boolean;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  hold_id?: string;
  also?: { principal: string; purpose: string; action: string };
  omit_csrf?: boolean;
  expect: {
    status: number;
    code?: string;
    class_visibility?: Record<string, string>;
    rows?: Record<string, unknown>;
    lookup_finds?: string[];
    pseudonyms_distinct?: boolean;
    audit?: string;
    extract_no_direct_identifiers?: boolean;
  };
}

const CASES = parse(casesText) as Case[];
const REPRESENTATIVE: Record<TaggedClass, string> = {
  direct_identifier: "full_name",
  date_of_birth: "birth_date",
  compensation: "base_salary",
  performance: "rating",
  health_leave: "leave_type",
  protected_attribute: "gender",
};
const RAW_ID = /\bE\d{5}\b/;
const t = () => Math.floor(Date.now() / 1000);

async function emailOf(principal: string): Promise<string> {
  const row = await env.DB.prepare("SELECT email FROM principals WHERE id = ?").bind(principal).first<{ email: string }>();
  return row!.email;
}

async function tokenHeader(c: Case): Promise<Record<string, string>> {
  const tok = c.token ?? "user";
  if (tok === "missing") return {};
  let value: string;
  switch (tok) {
    case "user":
    case "service":
      value = await tokenFor(c.principal);
      break;
    case "expired":
      value = await userToken(await emailOf(c.principal), { exp: t() - 300, iat: t() - 900, nbf: t() - 900 });
      break;
    case "nbf_future":
      value = await userToken(await emailOf(c.principal), { nbf: t() + 900, exp: t() + 1800 });
      break;
    case "wrong_aud":
      value = await userToken(await emailOf(c.principal), { aud: ["another-application"] });
      break;
    case "wrong_iss":
      value = await userToken(await emailOf(c.principal), { iss: "https://attacker.cloudflareaccess.com" });
      break;
    case "other_key":
      value = await userToken(await emailOf(c.principal), { key: "other", kid: "test-primary" });
      break;
    case "unknown_kid":
      value = await userToken(await emailOf(c.principal), { key: "other" });
      break;
    case "alg_none":
      value = algNoneToken(await emailOf(c.principal));
      break;
    case "hs256_confusion":
      value = await hs256ConfusionToken(await emailOf(c.principal));
      break;
    case "unknown_email":
      value = await userToken("nobody.unknown@peoplevault.test");
      break;
    default:
      value = await serviceToken(c.principal);
  }
  return { "Cf-Access-Jwt-Assertion": value };
}

function subjectOf(c: Case): SubjectEntry | undefined {
  return c.subject ? subject(c.subject.principal, c.subject.selector, c.subject.index) : undefined;
}

function refFor(c: Case, s: SubjectEntry): string {
  const kind = c.ref_kind ?? (c.purpose && POLICY.purposes[c.purpose as Purpose] ? POLICY.purposes[c.purpose as Purpose].ref : "employee_ref");
  const ref = s[kind];
  return c.tamper ? ref.slice(0, -1) + (ref.endsWith("a") ? "b" : "a") : ref;
}

function lookupQuery(s: SubjectEntry): string {
  return String(s.truth.full_name).slice(0, 6);
}

function request(c: Case, s: SubjectEntry | undefined): { method: string; path: string; body?: unknown } {
  const purpose = c.purpose ?? "";
  switch (c.action) {
    case "me":
      return { method: "GET", path: "/api/v1/me" };
    case "executor_claim":
      return { method: "POST", path: "/api/v1/executor/tasks/claim", body: { phases: ["erase"] } };
    case "list_employees": {
      const qs = c.query ? "?" + new URLSearchParams(Object.fromEntries(Object.entries(c.query).map(([k, v]) => [k, v === "subject_work_email" ? String(s!.truth.work_email) : v]))).toString() : "";
      return { method: "GET", path: `/api/v1/purposes/${purpose}/employees${qs}` };
    }
    case "read_profile":
      return { method: "GET", path: `/api/v1/purposes/${purpose}/employees/${refFor(c, s!)}` };
    case "identity_lookup":
      return { method: "POST", path: `/api/v1/purposes/${purpose}/identity-lookup`, body: { q: s ? lookupQuery(s) : "zzz-no-match" } };
    case "create_extract":
      return { method: "POST", path: `/api/v1/purposes/${purpose}/extracts`, body: c.body };
    case "create_deletion_request":
      return { method: "POST", path: "/api/v1/privacy/deletion-requests", body: { employee_ref: s!.employee_ref, reason: "data subject request" } };
    case "place_legal_hold":
      return { method: "POST", path: "/api/v1/privacy/legal-holds", body: { matter_id: "LH-2026-003", employee_ref: s!.employee_ref, reason: "preservation notice" } };
    case "release_legal_hold":
      return { method: "POST", path: `/api/v1/privacy/legal-holds/${c.hold_id}/release` };
    default:
      throw new Error(`unknown action ${c.action}`);
  }
}

async function send(app: ReturnType<typeof worldApp>["app"], headers: Record<string, string>, req: { method: string; path: string; body?: unknown }, omitCsrf = false): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (req.method !== "GET") {
    if (!omitCsrf) Object.assign(h, CSRF);
    h["content-type"] = "application/json";
  }
  return app.request(`${BASE}${req.path}`, { method: req.method, headers: h, ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) }, env);
}

async function asPrincipal(app: ReturnType<typeof worldApp>["app"], principal: string, req: { method: string; path: string; body?: unknown }): Promise<Response> {
  return send(app, { "Cf-Access-Jwt-Assertion": await tokenFor(principal) }, req);
}

function classColumns(cls: string): string[] {
  return Object.entries(POLICY.columnClass)
    .filter(([, k]) => k === cls)
    .map(([c]) => c);
}

/** The columns of a class that the case's named query returns (profile, or identity lookup). */
function projectedColumns(queryId: string, cls: TaggedClass): string[] {
  const q = POLICY.queries[queryId];
  expect(q, `query ${queryId}`).toBeDefined();
  return q!.columns.filter((col) => col.class === cls).map((col) => col.name);
}

function checkClassVisibility(row: Record<string, unknown>, cls: TaggedClass, vis: string, s: SubjectEntry, queryId: string): void {
  const cols = classColumns(cls);
  const present = cols.filter((c) => c in row);
  const rep = REPRESENTATIVE[cls];
  if (vis === "deny") {
    expect(present, `${cls} columns must be absent`).toEqual([]);
  } else if (vis === "allow") {
    // every column of the class the query returns is present and equals the truth, not only the representative
    const projected = projectedColumns(queryId, cls);
    expect(projected).toContain(rep);
    expect(present.sort()).toEqual([...projected].sort());
    for (const c of present) {
      expect(s.truth, `truth for ${c}`).toHaveProperty(c);
      expect(row[c], `${c} must equal the true value`).toEqual(s.truth[c]);
    }
  } else if (vis === "mask_nullify") {
    const projected = projectedColumns(queryId, cls);
    expect(projected.length).toBeGreaterThan(0);
    for (const c of projected) {
      expect(row, `${c} must be present (masked, not dropped)`).toHaveProperty(c);
      expect(row[c], `${c} must be nulled`).toBeNull();
    }
  } else if (vis === "mask_date_year") {
    expect(row[rep]).toBe(`${String(s.truth[rep]).slice(0, 4)}-01-01`);
  }
}

async function principalUnits(principal: string): Promise<string[]> {
  const row = await env.DB.prepare("SELECT org_units FROM principals WHERE id = ?").bind(principal).first<{ org_units: string }>();
  return JSON.parse(row!.org_units) as string[];
}

async function lastAudit(): Promise<Record<string, unknown>> {
  return (await env.DB.prepare("SELECT * FROM audit_events ORDER BY seq DESC LIMIT 1").first<Record<string, unknown>>())!;
}

async function runCase(c: Case): Promise<void> {
  const { app } = worldApp();
  const s = subjectOf(c);
  const req = request(c, s);
  const res = await send(app, await tokenHeader(c), req, c.omit_csrf);
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  expect(res.status, `${c.id} status (body ${text.slice(0, 200)})`).toBe(c.expect.status);
  if (c.expect.code) expect(body.code).toBe(c.expect.code);

  if (c.expect.class_visibility) {
    const [cls, vis] = Object.entries(c.expect.class_visibility)[0]!;
    let row: Record<string, unknown> | undefined;
    if (c.action === "identity_lookup") row = (body.rows as Record<string, unknown>[]).find((r) => r.employee_ref === s!.employee_ref);
    else row = body.profile as Record<string, unknown>;
    expect(row, `${c.id} subject row`).toBeDefined();
    checkClassVisibility(row!, cls as TaggedClass, vis, s!, `${c.purpose}.${c.action === "identity_lookup" ? "identity_lookup" : "profile"}`);
  }

  const rows = (body.rows ?? []) as Record<string, unknown>[];
  const r = c.expect.rows ?? {};
  if (r.within_principal_units) {
    const units = await principalUnits(c.principal);
    for (const row of rows) expect(units).toContain(row.org_unit);
  }
  if (r.count_selectors) {
    const n = (r.count_selectors as string[]).reduce((acc, sel) => acc + (SUBJECTS[c.principal]?.[sel]?.length ?? 0), 0);
    expect(rows).toHaveLength(n);
  }
  if (r.equals_selectors) {
    const want = (r.equals_selectors as string[]).flatMap((sel) => (SUBJECTS[c.principal]?.[sel] ?? []).map((x) => x.employee_ref)).sort();
    expect(rows.map((x) => String(x.employee_ref)).sort()).toEqual(want);
  }
  if (r.excludes_selector) {
    const ids = new Set(SUBJECTS["*"]![r.excludes_selector as string]!.map((x) => x.analytics_id));
    expect(ids.size).toBeGreaterThan(0);
    for (const row of rows) expect(ids.has(String(row.analytics_id))).toBe(false);
  }
  if (r.includes_selector) {
    const got = new Set(rows.map((x) => String(x.analytics_id)));
    const want = SUBJECTS["*"]![r.includes_selector as string]!;
    expect(want.length).toBeGreaterThan(0);
    for (const x of want) expect(got.has(x.analytics_id)).toBe(true);
  }
  if (r.pseudonymous_only) {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.analytics_id).toMatch(/^an_/);
      for (const k of ["employee_ref", "employee_id", "work_email", "full_name", "personal_email"]) expect(row).not.toHaveProperty(k);
      for (const v of Object.values(row)) expect(String(v)).not.toMatch(/@|\bE\d{5}\b/);
    }
  }
  if (r.employee_ref_no_raw_ids) {
    const also = c.also!;
    const second = await asPrincipal(app, also.principal, { method: "GET", path: `/api/v1/purposes/${also.purpose}/employees` });
    expect(second.status).toBe(200);
    const all = [...rows, ...(((await second.json()) as { rows: Record<string, unknown>[] }).rows ?? [])];
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      expect(row.employee_ref).toMatch(/^er_[a-z2-7]{26}$/);
      expect(row).not.toHaveProperty("employee_id");
      for (const v of Object.values(row)) expect(String(v)).not.toMatch(RAW_ID);
    }
  }
  for (const sel of c.expect.lookup_finds ?? []) {
    const target = SUBJECTS["*"]![sel]![0]!;
    const found = await asPrincipal(app, c.principal, { method: "POST", path: `/api/v1/purposes/${c.purpose}/identity-lookup`, body: { q: lookupQuery(target) } });
    const got = ((await found.json()) as { rows: { employee_ref: string }[] }).rows.map((x) => x.employee_ref);
    expect(got, `${sel} subject found`).toContain(target.employee_ref);
  }
  if (c.expect.pseudonyms_distinct) {
    const er = (body.profile as Record<string, unknown>).employee_ref as string;
    const wa = await asPrincipal(app, "analyst-01", { method: "GET", path: `/api/v1/purposes/workforce_analytics/employees/${s!.analytics_id}` });
    expect(wa.status).toBe(200);
    const waProfile = ((await wa.json()) as { profile: Record<string, unknown> }).profile;
    const an = waProfile.analytics_id as string;
    expect(new Set([er, an, s!.subject_ref]).size).toBe(3);
    expect([er.slice(0, 3), an.slice(0, 3), s!.subject_ref.slice(0, 3)]).toEqual(["er_", "an_", "sr_"]);
    expect(waProfile).not.toHaveProperty("employee_ref");
    expect(body.profile as Record<string, unknown>).not.toHaveProperty("analytics_id");
  }
  if (c.expect.audit) {
    const ev = await lastAudit();
    expect(ev.actor).toBe(c.principal);
    if (c.expect.audit === "deny_event") expect(ev.decision).toBe("deny");
    if (c.expect.audit === "allow_event_with_row_count") {
      expect(ev.decision).toBe("allow");
      expect(typeof ev.row_count).toBe("number");
    }
    if (c.expect.audit === "subject_ref_only") {
      expect(ev.subject_ref).toBe(s!.subject_ref);
      const flat = JSON.stringify(ev);
      for (const token of [s!.employee_ref, s!.analytics_id, String(s!.truth.full_name), String(s!.truth.work_email)]) expect(flat).not.toContain(token);
      expect(flat).not.toMatch(RAW_ID);
      expect(ev.route).toBe("/api/v1/purposes/:purpose/employees/:ref");
    }
  }
  if (c.expect.extract_no_direct_identifiers) {
    const obj = await env.DERIVED.get(String(body.key));
    const lines = (await obj!.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(0);
    const banned = new Set(classColumns("direct_identifier").concat(["employee_ref", "employee_key"]));
    for (const line of lines) {
      for (const k of Object.keys(line)) expect(banned.has(k), `extract column ${k}`).toBe(false);
      for (const v of Object.values(line)) expect(String(v)).not.toMatch(/@|\bE\d{5}\b/);
    }
  }
}

describe("authorization cases (policy/cases/authz_cases.yaml)", () => {
  beforeAll(seedWorld);

  it("loads exactly 100 cases", () => {
    expect(CASES).toHaveLength(100);
  });

  for (const c of CASES) {
    it(`${c.id}: ${c.description}`, () => runCase(c));
  }
});
