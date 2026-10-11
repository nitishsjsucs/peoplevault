// The privacy console (src/web) reads these fields from these routes. This test calls each route the way the console
// does locally (the CF_Authorization cookie from /dev/login, the CSRF header on POST) and checks every field the
// console's types in src/web/api.ts declare is present, so a route change that would break a page fails here.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, CSRF, identityOf, seedWorld, subject, worldApp } from "../fixtures/seed.ts";

beforeAll(seedWorld);

async function signIn(app: ReturnType<typeof worldApp>["app"], principalId: string): Promise<string> {
  const res = await app.request(`${BASE}/dev/login?principal=${principalId}`, {}, env);
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/^CF_Authorization=[^;]+;.*HttpOnly/i);
  return cookie.split(";")[0]!;
}

async function get(app: ReturnType<typeof worldApp>["app"], cookie: string, path: string): Promise<Record<string, unknown>> {
  const res = await app.request(`${BASE}${path}`, { headers: { Cookie: cookie, Accept: "application/json" } }, env);
  expect(res.status, path).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function post(app: ReturnType<typeof worldApp>["app"], cookie: string, path: string, body: unknown, status: number): Promise<Record<string, unknown>> {
  const res = await app.request(`${BASE}${path}`, { method: "POST", headers: { Cookie: cookie, ...CSRF, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
  expect(res.status, path).toBe(status);
  return (await res.json()) as Record<string, unknown>;
}

const keys = (o: unknown) => Object.keys(o as object).sort();
const has = (o: unknown, fields: string[]) => expect(keys(o)).toEqual(expect.arrayContaining(fields));

describe("console contract: the routes the console calls and the fields it reads", () => {
  it("dev principals and me", async () => {
    const { app } = worldApp();
    const principals = (await (await app.request(`${BASE}/dev/principals`, {}, env)).json()) as { principals: unknown[] };
    has(principals.principals[0], ["id", "kind", "persona", "status"]);
    const cookie = await signIn(app, "privacy-01");
    expect(await get(app, cookie, "/api/v1/me")).toEqual({ principalId: "privacy-01", persona: "privacy_officer", purposes: ["privacy_compliance", "legal_hold_management"] });
  });

  it("employee browser: list and profile", async () => {
    const { app } = worldApp();
    const cookie = await signIn(app, "hrbp-01");
    const list = await get(app, cookie, "/api/v1/purposes/employee_relations/employees");
    has(list, ["rows", "columns", "nextCursor"]);
    const s = subject("hrbp-01", "in_unit", 1);
    const profile = await get(app, cookie, `/api/v1/purposes/employee_relations/employees/${s.employee_ref}`);
    has(profile, ["profile", "columns"]);
    expect((profile.columns as Record<string, string>).leave_reason).toBe("mask_nullify");
  });

  it("requests, request detail, holds, report and audit", async () => {
    const { app } = worldApp();
    const cookie = await signIn(app, "privacy-01");
    const s = subject("*", "active", 9);
    const { work_email } = await identityOf(s.employee_ref);
    const lookup = (await post(app, cookie, "/api/v1/purposes/privacy_compliance/identity-lookup", { q: work_email.split("@")[0]! }, 200)) as { rows: unknown[] };
    has(lookup.rows[0], ["employee_ref", "full_name", "work_email", "org_unit", "employment_status"]);
    const created = await post(app, cookie, "/api/v1/privacy/deletion-requests", { employee_ref: s.employee_ref, reason: "console contract" }, 202);
    has(created, ["requestId", "status"]);
    const list = (await get(app, cookie, "/api/v1/privacy/deletion-requests")) as { requests: unknown[] };
    has(list.requests[0], ["id", "kind", "subjectRef", "status", "requestedBy", "workflowInstanceId", "createdAt", "completedAt", "admittedAt", "summary"]);
    const detail = await get(app, cookie, `/api/v1/privacy/deletion-requests/${String(created.requestId)}`);
    has(detail, ["request", "assets", "residuals"]);

    const held = subject("*", "active", 10);
    const hold = (await post(app, cookie, "/api/v1/privacy/legal-holds", { matter_id: "LH-2026-777", employee_ref: held.employee_ref, reason: "console contract" }, 201)) as { hold: unknown };
    has(hold.hold, ["id", "matterId", "subjectRef", "placedBy", "placedAt", "releasedAt", "releasedBy"]);
    const holds = (await get(app, cookie, "/api/v1/privacy/legal-holds")) as { holds: unknown[] };
    expect(holds.holds.length).toBeGreaterThan(0);
    const released = await post(app, cookie, `/api/v1/privacy/legal-holds/${(hold.hold as { id: string }).id}/release`, {}, 200);
    has(released, ["hold", "resubmitted", "deferred", "remainingHolds"]);

    const report = await get(app, cookie, "/api/v1/privacy/reports/deletion?from=2026-01-01T00%3A00%3A00.000Z&to=2099-12-31T23%3A59%3A59.999Z");
    has(report, ["window", "requests", "coverage", "byCategory", "held", "aggregateRecompute", "residuals", "failures", "failuresCursor"]);
    has(report.coverage, ["value", "display", "applicablePairs", "cleanPairs"]);

    const audit = (await get(app, cookie, "/api/v1/privacy/audit")) as { events: unknown[]; cursor: unknown };
    has(audit, ["events", "cursor"]);
    has(audit.events[0], ["seq", "ts", "actor", "actor_kind", "persona", "purpose", "action", "route", "subject_ref", "request_id", "decision", "reason", "row_count", "hash"]);
    const w = await get(app, cookie, "/api/v1/privacy/audit/verify?after_seq=0&limit=50");
    has(w, ["ok", "afterSeq", "anchorHash", "from", "to", "lastHash", "nextAfterSeq", "complete", "checked"]);
    expect(w.ok).toBe(true);
  });

  it("a POST without the console's CSRF header is refused", async () => {
    const { app } = worldApp();
    const cookie = await signIn(app, "privacy-01");
    const res = await app.request(`${BASE}/api/v1/purposes/privacy_compliance/identity-lookup`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ q: "aaa" }) }, env);
    expect(res.status).toBe(403);
  });
});
