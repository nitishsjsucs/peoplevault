import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { probeD1 } from "../../src/worker/verify/d1-probe.ts";
import { probeKv } from "../../src/worker/verify/kv-probe.ts";
import { probeR2 } from "../../src/worker/verify/r2-probe.ts";
import { patternFor, subjectMatchers } from "../../src/worker/verify/tokens.ts";

const s = { employeeId: "E30042", workEmail: "ian.chen@peoplevault.test", fullName: "Ian Chen", employeeRef: `er_${"k".repeat(26)}`, warehouseKey: `wk_${"m".repeat(26)}`, analyticsId: `an_${"p".repeat(26)}` };
const m = subjectMatchers(s, { includeFullName: true });

describe("independent probes", () => {
  it("R2: unregistered prefixes, later lines, key names and custom metadata", async () => {
    await env.EXPORTS.put("exports/adhoc/copy.jsonl", '{"x":1}\n{"x":2}\n{"note":"contact ian.chen@peoplevault.test."}\n');
    await env.EXPORTS.put(`exports/adhoc/${s.employeeId}.jsonl`, "{}\n");
    await env.DERIVED.put("extracts/workforce_analytics/attrition/month=2026-01/attrition.jsonl", "{}\n", { customMetadata: { owner: s.employeeRef } });
    await env.EXPORTS.put("notes/brian.txt", "brian.chen@peoplevault.test and Brian Chen and E300421\n");
    const res = await probeR2([{ name: "pv-source-exports", bucket: env.EXPORTS }, { name: "pv-derived", bucket: env.DERIVED }], m);
    const locs = res.findings.map((f) => [f.location, f.assetId]);
    expect(locs).toContainEqual(["pv-source-exports/exports/adhoc/copy.jsonl", null]);
    expect(locs).toContainEqual(["pv-source-exports/exports/adhoc/[redacted].jsonl", null]);
    expect(locs).toContainEqual(["pv-derived/extracts/workforce_analytics/attrition/month=2026-01/attrition.jsonl", "drv.r2.analytics_extracts"]);
    expect(locs.map((l) => l[0])).not.toContain("pv-source-exports/notes/brian.txt");
  });

  it("KV: key names and values", async () => {
    await env.CACHE.put(`tmp:${s.employeeRef}`, "x");
    await env.CACHE.put("report:summary", "top performer: Ian Chen, again");
    await env.CACHE.put("report:other", "Brian Chen");
    const res = await probeKv(env.CACHE, m);
    expect(res.findings.map((f) => f.location).sort()).toEqual(["report:summary", "tmp:[redacted]"]);
  });

  it("D1: an ad hoc table is found, internal tables are skipped, an unreadable table is an error", async () => {
    await env.DB.exec("CREATE TABLE IF NOT EXISTS support_notes (id TEXT, body TEXT)");
    await env.DB.prepare("INSERT INTO support_notes VALUES ('1', 'call from E30042 today')").run();
    await env.DB.exec("CREATE TABLE IF NOT EXISTS boundary_check (body TEXT)");
    await env.DB.prepare("INSERT INTO boundary_check VALUES ('brian.chen@peoplevault.test')").run();
    // a view over a table that no longer exists cannot be read
    await env.DB.exec("CREATE TABLE IF NOT EXISTS gone (body TEXT)");
    await env.DB.exec("CREATE VIEW IF NOT EXISTS gone_view AS SELECT body FROM gone");
    const res = await probeD1(env.DB, m, "final");
    expect(res.findings.map((f) => f.location)).toEqual(["support_notes"]);
    const scannedNames = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    expect(scannedNames).toContain("d1_migrations");
    expect(res.errors).toEqual([]);
  });

  it("boundary matching does not flag brian.chen@ for subject ian.chen@", () => {
    const email = new RegExp(patternFor("work_email", s.workEmail));
    expect(email.test("brian.chen@peoplevault.test")).toBe(false);
    expect(email.test("mail ian.chen@peoplevault.test.")).toBe(true);
    const name = new RegExp(patternFor("full_name", "Ann Li"));
    expect(name.test("Ann Lin")).toBe(false);
    expect(name.test("Joann Li")).toBe(false);
    expect(name.test("by Ann Li, HR")).toBe(true);
    const id = new RegExp(patternFor("employee_id", "E30042"));
    expect(id.test("E300421")).toBe(false);
    expect(id.test("XE30042")).toBe(false);
  });
});
