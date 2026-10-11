import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, seedWorld, subject, worldApp } from "../fixtures/seed.ts";

beforeAll(seedWorld);

const suppress = (subjectRef: string) =>
  env.DB.prepare("INSERT OR IGNORE INTO suppression_list (subject_ref, request_id, created_at) VALUES (?, 'req-test', '2026-10-01T00:00:00Z')").bind(subjectRef).run();

async function kvMentions(token: string): Promise<boolean> {
  const { keys } = await env.CACHE.list();
  for (const k of keys) {
    if (k.name.includes(token)) return true;
    if (((await env.CACHE.get(k.name)) ?? "").includes(token)) return true;
  }
  return false;
}

describe("suppression-aware data path (SPEC.md 14.6)", () => {
  it("a suppressed subject's profile is 404 and never cached; rosters and analyst datasets omit it", async () => {
    const { app } = worldApp();
    const s = subject("mgr-001", "direct_report", 1);
    // warm the manager's roster first so the cached value lists the subject
    await call(app, "mgr-001", "GET", "/api/v1/purposes/team_management/team");
    await suppress(s.subject_ref);
    for (const [principal, purpose, ref] of [
      ["mgr-001", "team_management", s.employee_ref],
      ["hrbp-01", "employee_relations", s.employee_ref],
      ["analyst-01", "workforce_analytics", s.analytics_id],
    ] as const) {
      const res = await call(app, principal, "GET", `/api/v1/purposes/${purpose}/employees/${ref}`);
      expect(res.status).toBe(404);
      expect(await env.CACHE.get(`profile:${purpose}:${ref}`)).toBeNull();
    }
    const roster = (await (await call(app, "mgr-001", "GET", "/api/v1/purposes/team_management/team")).json()) as { rows: { employee_ref: string }[] };
    expect(roster.rows.map((r) => r.employee_ref)).not.toContain(s.employee_ref);
    const list = (await (await call(app, "mgr-001", "GET", "/api/v1/purposes/team_management/employees")).json()) as { rows: { employee_ref: string }[] };
    expect(list.rows.map((r) => r.employee_ref)).not.toContain(s.employee_ref);
    const wa = (await (await call(app, "analyst-01", "GET", "/api/v1/purposes/workforce_analytics/employees")).json()) as { rows: { analytics_id: string }[] };
    expect(wa.rows.map((r) => r.analytics_id)).not.toContain(s.analytics_id);
    const af = (await (await call(app, "analyst-01", "GET", "/api/v1/purposes/workforce_analytics/datasets/attrition_features?month=2026-09-01")).json()) as { rows: { analytics_id: string }[] };
    expect(af.rows.map((r) => r.analytics_id)).not.toContain(s.analytics_id);
    const lookup = (await (await call(app, "privacy-01", "POST", "/api/v1/purposes/privacy_compliance/identity-lookup", { q: String(s.truth.full_name).slice(0, 6) })).json()) as { rows: { employee_ref: string }[] };
    expect(lookup.rows.map((r) => r.employee_ref)).not.toContain(s.employee_ref);
    // nothing newly cached mentions the subject's analytics id (the roster entry predates suppression and is erased by the workflow)
    expect(await kvMentions(s.analytics_id)).toBe(false);
  });

  it("a suppressed manager's own roster is neither served nor cached", async () => {
    const { app } = worldApp();
    const mgr = subject("mgr-004", "self", 0);
    await suppress(mgr.subject_ref);
    const res = await call(app, "mgr-004", "GET", "/api/v1/purposes/team_management/team");
    expect(res.status).toBe(404);
    expect(await env.CACHE.get(`team:${mgr.employee_ref}`)).toBeNull();
  });
});
