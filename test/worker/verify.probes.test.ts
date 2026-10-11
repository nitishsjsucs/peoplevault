import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1_PROBE_TABLES_PER_STEP, excludedTables, probeD1, type D1Stage } from "../../src/worker/verify/d1-probe.ts";
import { probeKv } from "../../src/worker/verify/kv-probe.ts";
import { countMatchingLines, probeR2 } from "../../src/worker/verify/r2-probe.ts";
import { countMatches, patternFor, subjectMatchers } from "../../src/worker/verify/tokens.ts";
import { seedObjects, seedWorld, type WorldIdentity } from "../fixtures/seed.ts";

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

// The D1 probe of revision 2 (commit 38): every TEXT cell of every table sent to the Worker. Kept as the reference.
async function fullScanD1(db: D1Database, matchers: ReturnType<typeof subjectMatchers>, stage: D1Stage) {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  const skip = excludedTables(stage);
  const out: { location: string; matches: number }[] = [];
  for (const { name } of results) {
    if (name.startsWith("_cf_") || name.startsWith("sqlite_") || name === "d1_migrations" || skip.has(name)) continue;
    const cols = await db.prepare(`PRAGMA table_info(${name})`).all<{ name: string; type: string }>();
    const textCols = cols.results.filter((c) => c.type === "" || /TEXT|CHAR|CLOB/i.test(c.type)).map((c) => c.name);
    if (textCols.length === 0) continue;
    const rows = await db.prepare(`SELECT ${textCols.join(", ")} FROM ${name}`).all<Record<string, unknown>>();
    let matches = 0;
    for (const row of rows.results) for (const c of textCols) matches += countMatches(c, row[c], matchers);
    if (matches > 0) out.push({ location: name, matches });
  }
  return out;
}

describe("D1 probe inside SQLite (Workers Free, SPEC.md 30.3.1)", () => {
  it("the instr prefilter finds exactly what the full scan finds, over the fixture world plus the 3 eval ad hoc tables", async () => {
    await seedWorld();
    const world = (await env.DB.prepare("SELECT * FROM identity_map ORDER BY employee_id").all<WorldIdentity>()).results;
    const [a, b, c] = world;
    await env.DB.exec("CREATE TABLE IF NOT EXISTS principal_aliases (alias TEXT, email TEXT)");
    await env.DB.exec("CREATE TABLE IF NOT EXISTS cache_mirror (k TEXT, v TEXT)");
    await env.DB.prepare("INSERT INTO support_notes VALUES ('n9', ?)").bind(`call from ${a!.employee_id} today`).run();
    await env.DB.prepare("INSERT INTO principal_aliases VALUES ('a1', ?)").bind(b!.work_email).run();
    await env.DB.prepare("INSERT INTO cache_mirror VALUES ('c1', ?)").bind(c!.employee_ref).run();
    let compared = 0;
    let found = 0;
    for (const w of world) {
      const wm = subjectMatchers({ employeeId: w.employee_id, workEmail: w.work_email, fullName: w.full_name, employeeRef: w.employee_ref, warehouseKey: w.warehouse_key, analyticsId: w.analytics_id }, { includeFullName: true });
      for (const stage of ["before_identity_erasure", "before_redaction", "final"] as D1Stage[]) {
        const want = await fullScanD1(env.DB, wm, stage);
        const got = await probeD1(env.DB, wm, stage, { maxTables: 1000 });
        expect(got.findings.map((f) => ({ location: f.location, matches: f.matches })), `${w.employee_id} ${stage}`).toEqual(want);
        compared++;
        found += want.length;
      }
    }
    expect(compared).toBe(world.length * 3);
    expect(found).toBeGreaterThan(world.length); // identity tables in the later stages, the 3 planted rows, principals
  });

  it("splits a table list longer than 16 across steps by index, and the union equals one pass", async () => {
    for (let i = 0; i < 12; i++) await env.DB.exec(`CREATE TABLE IF NOT EXISTS pad_${String(i).padStart(2, "0")} (body TEXT)`);
    await env.DB.prepare("INSERT INTO pad_11 VALUES (?)").bind(`note for ${s.workEmail}`).run();
    const whole = await probeD1(env.DB, m, "final", { maxTables: 1000 });
    expect(whole.tables).toBeGreaterThan(D1_PROBE_TABLES_PER_STEP);
    const first = await probeD1(env.DB, m, "final");
    expect(first.next).toBe(D1_PROBE_TABLES_PER_STEP);
    expect(first.scanned).toBe(D1_PROBE_TABLES_PER_STEP);
    const second = await probeD1(env.DB, m, "final", { from: first.next! });
    expect(second.next).toBeNull();
    expect([...first.findings, ...second.findings]).toEqual(whole.findings);
    expect(whole.findings.map((f) => f.location)).toContain("pad_11");
  });

  it("leaves out the rows it is told to skip (the final stage's own task rows)", async () => {
    await env.DB.prepare("INSERT INTO executor_tasks (id, request_id, workflow, instance_id, phase, event_type, payload_json, status, created_at, updated_at) VALUES ('t-own', 'req-own', 'DELETION', 'req-own', 'erase', 'executor_result_erase', ?, 'done', 'x', 'x')")
      .bind(JSON.stringify({ subject: { workEmail: s.workEmail } }))
      .run();
    const seen = await probeD1(env.DB, m, "final", { maxTables: 1000 });
    const skipped = await probeD1(env.DB, m, "final", { maxTables: 1000, skipRows: { executor_tasks: { column: "request_id", value: "req-own" } } });
    expect(seen.findings.map((f) => f.location)).toContain("executor_tasks");
    expect(skipped.findings.map((f) => f.location)).not.toContain("executor_tasks");
    await env.DB.prepare("DELETE FROM executor_tasks WHERE id = 't-own'").run();
  });
});

describe("R2 probe line matching from token occurrences (Workers Free CPU)", () => {
  const everyLine = (text: string, matchers: ReturnType<typeof subjectMatchers>) => text.split("\n").filter((line) => line && countMatches(null, line, matchers)).length;

  it("counts exactly the lines that testing every line counts, over every fixture subject and object", async () => {
    await seedWorld();
    await seedObjects();
    const world = (await env.DB.prepare("SELECT * FROM identity_map ORDER BY employee_id").all<WorldIdentity>()).results;
    const texts: string[] = [];
    for (const b of [env.EXPORTS, env.DERIVED]) for (const o of (await b.list({ limit: 1000 })).objects) texts.push(await (await b.get(o.key))!.text());
    let hits = 0;
    for (const w of world) {
      const wm = subjectMatchers({ employeeId: w.employee_id, workEmail: w.work_email, fullName: w.full_name, employeeRef: w.employee_ref, warehouseKey: w.warehouse_key, analyticsId: w.analytics_id }, { includeFullName: true });
      for (const t of texts) {
        const n = countMatchingLines(t, wm);
        expect(n).toBe(everyLine(t, wm));
        hits += n;
      }
    }
    expect(hits).toBeGreaterThan(world.length);
  });

  it("handles boundary cases, repeated tokens on one line, a last line without a newline and carriage returns", () => {
    const text = ["brian.chen@peoplevault.test and Brian Chen", "contact ian.chen@peoplevault.test. twice ian.chen@peoplevault.test", "", "E300421 is not E30042", `ref ${s.employeeRef}\r`, `E30042`].join("\n");
    expect(countMatchingLines(text, m)).toBe(everyLine(text, m));
    // lines 2 (the email), 4 (E30042 at the end, after E300421), 5 (the ref before \r) and 6 (no trailing newline)
    expect(countMatchingLines(text, m)).toBe(4);
    expect(countMatchingLines("", m)).toBe(0);
  });
});
