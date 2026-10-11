// npm run bench:cpu (SPEC.md sections 30.2 and 30.3): CPU of the Worker's hot paths under Workers Free, measured by
// bundling the repo's own modules with the repo's esbuild and running them over the full generated population
// (`pv synth` output in data/generated, seed 20261010). Values are warm medians in milliseconds on this machine; edge
// cores and cold isolates are assumed up to 3 times slower, so the design target is 2.5 ms here (7.5 ms at 3 times,
// 25% under Free's 10 ms). Before timing anything it checks that the prefiltered transform is byte-identical to the
// unfiltered one over every generated export object for subjects that include managers and reviewers.
// Writes evals/results/cpu-<date>.json with command, date, git state and machine.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./lib/run.ts";

const GENERATED = path.join(REPO_ROOT, "data", "generated");
const ERASE_CAP = 4_194_304;
const PROBE_CAP = 2_097_152;
const RUNS = 25;

type Fn = (...a: never[]) => unknown;
interface Bundle {
  transformRows: Fn;
  deletionRule: Fn;
  subjectMatchers: Fn;
  countMatches: Fn;
  anyTokenIncluded: Fn;
  chainHash: (prev: string, fields: Record<string, unknown>) => Promise<string>;
  hashedFields: Fn;
  createPseudonymizer: (k: string) => { pseudonym(kind: string, id: string): Promise<string> };
  ASSETS: { id: string; parts: { name: string; location: string | null; format: string | null; referenceColumns: string[] }[] }[];
}

async function loadBundle(): Promise<Bundle> {
  const esbuild = (await import(pathToFileURL(path.join(REPO_ROOT, "node_modules", "esbuild", "lib", "main.js")).href)) as typeof import("esbuild");
  const dir = mkdtempSync(path.join(os.tmpdir(), "pv-bench-"));
  const out = path.join(dir, "bench.mjs");
  await esbuild.build({
    stdin: {
      contents: [
        'export { transformRows, deletionRule } from "./src/worker/erase/jsonl-objects.ts";',
        'export { subjectMatchers, countMatches, anyTokenIncluded } from "./src/worker/verify/tokens.ts";',
        'export { chainHash, hashedFields } from "./src/worker/audit/audit-log.ts";',
        'export { createPseudonymizer } from "./src/worker/pseudo/hmac.ts";',
        'export { ASSETS } from "./src/worker/assets/registry.ts";',
      ].join("\n"),
      resolveDir: REPO_ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: out,
    logLevel: "silent",
  });
  const mod = (await import(pathToFileURL(out).href)) as Bundle;
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Warm median (the design numbers of SPEC.md section 30.2) and warm minimum (the least disturbed run on a loaded
 * machine), plus the first, cold call. */
async function time(fn: () => unknown | Promise<unknown>): Promise<{ warm_median_ms: number; warm_min_ms: number; cold_ms: number }> {
  let t = performance.now();
  await fn();
  const cold = performance.now() - t;
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  return { warm_median_ms: Number(median(xs).toFixed(3)), warm_min_ms: Number(Math.min(...xs).toFixed(3)), cold_ms: Number(cold.toFixed(3)) };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const loadAtStart = os.loadavg()[0] ?? 0;
  if (!existsSync(path.join(GENERATED, "exports"))) throw new Error("data/generated is missing: run `uv run --project pipelines pv synth` (or npm run seed:local) first");
  const b = await loadBundle();
  const exportsAsset = b.ASSETS.find((a) => a.id === "src.r2.exports")!;
  const objects = walk(path.join(GENERATED, "exports"))
    .sort()
    .map((file) => {
      const key = path.relative(GENERATED, file).split(path.sep).join("/");
      const part = exportsAsset.parts.find((p) => p.location && key.startsWith(p.location))!;
      return { key, part, format: (part.format ?? "jsonl") as "jsonl" | "csv", body: readFileSync(file, "utf8"), size: statSync(file).size };
    });
  const truth = JSON.parse(readFileSync(path.join(GENERATED, "truth", "subjects.json"), "utf8")) as { employee_id: string; full_name: string; work_email: string; role: string; manager_id: string | null }[];
  const reviewer = truth.find((t) => t.role === "line_manager")!;
  const staff = truth.find((t) => t.role === "staff" && t.manager_id === reviewer.employee_id) ?? truth.find((t) => t.role === "staff")!;
  const orgHead = truth.find((t) => t.role === "org_head")!;
  const subjects = [staff, reviewer, orgHead];

  // 1. byte-identical: the prefiltered transform equals the unfiltered one over every generated export object
  let compared = 0;
  for (const s of subjects) {
    for (const o of objects) {
      const rule = (b.deletionRule as (p: unknown, c: string, v: string, h?: Set<string>) => Record<string, unknown>)(o.part, "employee_id", s.employee_id, new Set());
      const { prefilter: _p, ...plain } = rule;
      const got = JSON.stringify((b.transformRows as (x: string, f: string, r: unknown) => unknown)(o.body, o.format, rule));
      const want = JSON.stringify((b.transformRows as (x: string, f: string, r: unknown) => unknown)(o.body, o.format, plain));
      if (got !== want) throw new Error(`prefiltered transform differs for ${o.key}`);
      compared++;
    }
  }

  const transform = b.transformRows as (x: string, f: string, r: unknown) => { body: string };
  const rule = (b.deletionRule as (p: unknown, c: string, v: string) => Record<string, unknown>);
  const hris = objects.filter((o) => o.part.name === "hris");
  const byCap = (cap: number, list = objects) => {
    const out: typeof objects = [];
    let bytes = 0;
    for (const o of list) {
      if (out.length > 0 && bytes + o.size > cap) break;
      out.push(o);
      bytes += o.size;
    }
    return out;
  };
  const eraseStep = byCap(ERASE_CAP, hris);
  const eraseBytes = eraseStep.reduce((n, o) => n + o.size, 0);

  // 2. erase step at the 4 MiB cap with the prefilter, and revision 2's HRIS step (every line parsed) for comparison
  const prefiltered = await time(() => {
    for (const o of eraseStep) transform(o.body, o.format, rule(o.part, "employee_id", reviewer.employee_id));
  });
  const rev2Hris = await time(() => {
    for (const o of hris) {
      const { prefilter: _p, ...plain } = rule(o.part, "employee_id", reviewer.employee_id);
      transform(o.body, o.format, plain);
    }
  });
  const allPrefiltered = await time(() => {
    for (const o of objects) transform(o.body, o.format, rule(o.part, "employee_id", reviewer.employee_id));
  });
  const totalMiB = objects.reduce((n, o) => n + o.size, 0) / 1_048_576;

  // 3. probe step at the 2 MiB cap over objects the subject was erased from (a clean deletion's probe)
  const pseudo = b.createPseudonymizer(Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"));
  const tokens = {
    employeeId: staff.employee_id,
    workEmail: staff.work_email,
    fullName: staff.full_name,
    employeeRef: await pseudo.pseudonym("employee_ref", staff.employee_id),
    warehouseKey: await pseudo.pseudonym("warehouse_key", staff.employee_id),
    analyticsId: await pseudo.pseudonym("analytics_id", staff.employee_id),
  };
  const matchers = (b.subjectMatchers as (t: unknown, o: unknown) => unknown[])(tokens, { includeFullName: true });
  const erased = byCap(PROBE_CAP, hris).map((o) => transform(o.body, o.format, rule(o.part, "employee_id", staff.employee_id)).body);
  const probeBytes = byCap(PROBE_CAP, hris).reduce((n, o) => n + o.size, 0);
  const count = b.countMatches as (c: string | null, v: unknown, m: unknown[]) => number;
  const included = b.anyTokenIncluded as (t: string, m: unknown[]) => boolean;
  const probe = await time(() => {
    let n = 0;
    for (const text of erased) {
      if (included(text, matchers)) for (const line of text.split("\n")) if (line && count(null, line, matchers)) n++;
    }
    return n;
  });
  // the probe's line loop runs when a token is present (an object that still holds the subject): the worst case
  const probeWorst = await time(() => {
    let n = 0;
    for (const o of byCap(PROBE_CAP, hris)) for (const line of o.body.split("\n")) if (line && count(null, line, matchers)) n++;
    return n;
  });

  // 4. audit chain verification window of 100 events and an export page of 500 rows
  const row = (i: number) => ({ id: `id-${i}`, ts: "2026-10-10T00:00:00.000Z", actor: "privacy-01", actor_kind: "human", persona: "privacy_officer", purpose: "privacy_compliance", action: "read_audit", route: "/api/v1/privacy/audit", subject_ref: null, request_id: null, decision: "allow", reason: "ok", row_count: i, detail_json: '{"n":1}' });
  const verify = await time(async () => {
    let prev = "0".repeat(64);
    for (let i = 0; i < 100; i++) prev = await b.chainHash(prev, (b.hashedFields as (r: unknown) => Record<string, unknown>)(row(i)));
  });
  const page = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, ...row(i), prev_hash: "a".repeat(64), hash: "b".repeat(64) }));
  const exportPage = await time(() => JSON.parse(JSON.stringify({ rows: page, headSeq: 500 })));

  // 5. the KV probe's matching over 420 cached values
  const values = Array.from({ length: 420 }, (_, i) => JSON.stringify({ v: 1, profile: { employee_ref: `er_${String(i).padStart(26, "a")}`, full_name: `Person ${i}`, job_title: "Engineer" }, scope: { org_unit: "ENG-PRODUCT" } }));
  const kv = await time(() => values.reduce((n, v) => n + (included(v, matchers) ? count(null, v, matchers) : 0), 0));

  const cpus = os.cpus();
  const date = new Date().toISOString().slice(0, 10);
  const result = {
    kind: "cpu",
    command: "npm run bench:cpu",
    date,
    git_sha: git("rev-parse", "HEAD") || "unknown",
    git_dirty: git("status", "--porcelain") !== "",
    environment: `local (Node ${process.version} on ${os.platform()} ${os.arch()}, ${cpus[0]?.model ?? "unknown CPU"})`,
    // other processes share this machine; the 1-minute load average at the start says how disturbed the run was
    machine: { cpus: cpus.length, load_average_1m: Number(loadAtStart.toFixed(2)), total_memory_gib: Number((os.totalmem() / 2 ** 30).toFixed(1)) },
    population: { export_objects: objects.length, export_mib: Number(totalMiB.toFixed(2)), seed: 20261010 },
    prefilter_identical: { objects: objects.length, subjects: subjects.length, comparisons: compared },
    measurements_ms: {
      erase_step_at_cap: { ...prefiltered, objects: eraseStep.length, mib: Number((eraseBytes / 1_048_576).toFixed(2)) },
      erase_all_exports_prefiltered: { ...allPrefiltered, per_mib: Number((allPrefiltered.warm_median_ms / totalMiB).toFixed(3)) },
      revision2_hris_erase_every_line_parsed: { ...rev2Hris, objects: hris.length },
      probe_step_at_cap_clean: { ...probe, mib: Number((probeBytes / 1_048_576).toFixed(2)) },
      probe_step_at_cap_every_line: probeWorst,
      audit_verify_window_100: verify,
      audit_export_page_500: exportPage,
      kv_probe_420_values: kv,
    },
    design: { target_ms_here: 2.5, edge_factor: 3, free_cpu_limit_ms: 10 },
  };
  const largest = Math.max(prefiltered.warm_median_ms, probeWorst.warm_median_ms, verify.warm_median_ms, exportPage.warm_median_ms, kv.warm_median_ms);
  (result as Record<string, unknown>).largest_step_ms = largest;
  (result as Record<string, unknown>).within_target = largest <= 2.5;
  const file = path.join(REPO_ROOT, "evals", "results", `cpu-${date}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ file: path.relative(REPO_ROOT, file), largest_step_ms: largest, within_target: largest <= 2.5, measurements_ms: result.measurements_ms }, null, 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
