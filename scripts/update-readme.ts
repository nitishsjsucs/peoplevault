// npm run readme:results: rewrites only the block between <!-- results:start --> and <!-- results:end --> in
// README.md from committed evals/results/*.json (SPEC.md section 19.3). Each number comes from a result file and is
// printed with its command, date and environment label; a file without command, date, git_sha or git_dirty, or one
// produced from a dirty working tree, is refused. Local results are labeled local; nothing local is called BigQuery.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./lib/run.ts";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";

// result files are produced by this repository (pv eval, pv authz) and validated for their header fields
type Json = Record<string, any>;

export interface ResultFile {
  name: string;
  data: Json;
}

export function validate(f: ResultFile): void {
  for (const k of ["command", "date", "git_sha", "git_dirty", "environment"]) {
    if (f.data[k] === undefined || f.data[k] === null || f.data[k] === "") throw new Error(`${f.name}: missing ${k}`);
  }
  if (f.data.git_dirty !== false) throw new Error(`${f.name}: produced from a working tree with uncommitted changes; rerun on a clean tree`);
}

/** Latest file per (kind, profile or target), by date then name. */
export function latest(files: ResultFile[]): ResultFile[] {
  const by = new Map<string, ResultFile>();
  for (const f of files) {
    const key = f.name.replace(/-\d{4}-\d{2}-\d{2}\.json$/, "");
    const cur = by.get(key);
    if (!cur || `${f.data.date}${f.name}` > `${cur.data.date}${cur.name}`) by.set(key, f);
  }
  return [...by.values()].sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
}

function order(name: string): number {
  return name.startsWith("deletion-full") ? 0 : name.startsWith("deletion-ci") ? 1 : name.startsWith("deletion") ? 2 : name.startsWith("authz-local") ? 3 : name.startsWith("authz-api") ? 4 : name.startsWith("cpu") ? 6 : name.startsWith("drift") ? 7 : 5;
}

const pct = (c: { display: string; applicable_pairs: number }) => (c.applicable_pairs ? `${c.display} of ${c.applicable_pairs} applicable pairs` : "n/a (0 applicable pairs)");
const label = (s: string) => s.replace(/_/g, " ");

function deletion(f: ResultFile): string[] {
  const d = f.data;
  const lines = [`**Deletion eval, ${d.profile} profile** (\`${d.command}\`, ${d.date}; ${d.environment})`, ""];
  const byStatus = Object.entries(d.requests.by_status as Record<string, number>).map(([k, v]) => `${label(k)} ${v}`).join(", ");
  lines.push(`- Requests: ${d.requests.total} (${byStatus})`);
  lines.push(`- Coverage (system verdicts, retention and DSR requests that were not held): ${pct(d.coverage)}`);
  for (const [cat, c] of Object.entries(d.coverage.by_category as Record<string, { display: string; applicable_pairs: number }>)) lines.push(`  - ${label(cat)}: ${pct(c)}`);
  const o = d.oracle;
  lines.push(`- Independent oracle: coverage ${o.oracle_coverage.display}, agreement ${(Number(o.agreement) * 100).toFixed(1)}%, false clean ${o.false_clean}, false residue ${o.false_residue}`);
  const stores = Object.entries(d.faults.by_store as Record<string, { detected: number; scenarios: number }>).map(([k, v]) => `${k} ${v.detected}/${v.scenarios}`).join(", ");
  lines.push(`- Fault detection: ${d.faults.detected} of ${d.faults.scenarios} planted residues of designed types detected (${stores})` + (d.faults.variants?.length ? `; ${d.faults.undetected_by_design} out-of-design variants undetected by design` : ""));
  lines.push(`- Legal holds: ${d.holds.held_requests} held requests, held data intact for ${d.holds.held_data_intact}`);
  if (d.retention.run === false) lines.push("- Retention sweep: not part of this profile");
  else {
    const m = d.retention.matches_expected as Record<string, boolean>;
    lines.push(`- Retention sweep: ${d.retention.retention_requests} retention requests (${d.retention.retention_held} held), ${d.retention.export_objects_deleted} export objects deleted and ${d.retention.export_objects_minimized_for_hold} minimized for holds, ${d.retention.extracts_expired} extracts expired; ${Object.values(m).every(Boolean) ? "every count equal to the golden counts" : `differs from the golden counts: ${Object.keys(m).filter((k) => !m[k]).join(", ")}`}`);
  }
  const aa = d.applicability_agreement;
  lines.push(`- Applicability agreement with ground truth: ${aa.agree} of ${aa.pairs} pairs` + (aa.disagreements?.length ? ` (${aa.disagreements.map((x: Json) => `${x.asset_id}: system ${x.system}, truth ${x.truth}`).join("; ")})` : ""));
  lines.push(`- Audit hash chain: ${d.audit_chain.ok ? "verified" : "BROKEN"} over ${d.audit_chain.length} events` + (d.audit_chain.windows ? ` (${d.audit_chain.windows} windows of at most 100)` : ""));
  if (d.audit_copy) {
    const where = String(d.environment).startsWith("local") ? "pyiceberg SqlCatalog" : "Basin Catalog";
    lines.push(`- Audit copy (\`pv audit export\`, ${where} table \`${d.audit_copy.table}\`): ${d.audit_copy.rows} rows, ${d.audit_copy.copied_this_run} copied by this run; last hash ${d.audit_copy.last_hash_matches ? "equals" : "DIFFERS FROM"} D1's at seq ${d.audit_copy.last_seq}`);
  }
  lines.push(`- Workflow duration (create to terminal${String(d.environment).startsWith("local") ? ", local" : ""}): p50 ${(d.timing_ms.workflow_p50 / 1000).toFixed(1)} s, p95 ${(d.timing_ms.workflow_p95 / 1000).toFixed(1)} s`);
  lines.push(`- Gate: ${d.gate.passed ? "passed" : "FAILED"}`);
  return lines;
}

function authz(f: ResultFile): string[] {
  const d = f.data;
  const lines = [`**Authorization cases** (\`${d.command}\`, ${d.date}; ${d.environment})`, ""];
  if (d.layers.pdp) lines.push(`- Decision point (Worker app, fixture world): ${d.layers.pdp.passed} of ${d.layers.pdp.total} cases`);
  if (d.layers.warehouse) lines.push(`- Warehouse layer (${d.layers.warehouse.backend === "duckdb" ? "DuckDB purpose views" : "BigQuery as each purpose's service account"}): ${d.layers.warehouse.passed} of ${d.layers.warehouse.total} cases`);
  if (d.ceiling_probes) lines.push(`- BigQuery ceiling probes (reported separately): ${d.ceiling_probes.passed} of ${d.ceiling_probes.total}`);
  if (d.layers.api) {
    const a = d.layers.api;
    const where = a.target === "prod" ? "deployed Worker behind Cloudflare Access" : "local Worker, limited to the tokens production has";
    lines.push(`- Through the API (${where}, full synthetic population, one token per persona principal and the executor): ${a.passed} of ${a.runnable} runnable cases passed; ${a.skipped} of ${d.cases_total} not runnable there`);
    for (const [reason, n] of Object.entries((d.skip_reasons ?? {}) as Record<string, number>).sort(([x], [y]) => x.localeCompare(y))) lines.push(`  - ${n} skipped: ${reason}`);
  }
  return lines;
}

function cpu(f: ResultFile): string[] {
  const d = f.data;
  const m = d.measurements_ms as Record<string, { warm_median_ms: number; warm_min_ms?: number; objects?: number; mib?: number; per_mib?: number }>;
  const v = (k: string) => `${m[k]!.warm_median_ms} ms` + (m[k]!.warm_min_ms !== undefined ? ` (fastest run ${m[k]!.warm_min_ms} ms)` : "");
  return [
    `**CPU of the Worker's hot paths** (\`${d.command}\`, ${d.date}; ${d.environment}; ${d.machine.cpus} cores, 1-minute load average ${d.machine.load_average_1m} at the start)`,
    "",
    `- Prefiltered transform byte-identical to the unfiltered one: ${d.prefilter_identical.comparisons} comparisons over all ${d.prefilter_identical.objects} generated export objects`,
    `- Erase step at the 4 MiB cap (${m.erase_step_at_cap!.objects} HRIS objects, ${m.erase_step_at_cap!.mib} MiB): ${v("erase_step_at_cap")}; the revision 2 HRIS step that parsed every line of ${m.revision2_hris_erase_every_line_parsed!.objects} objects: ${v("revision2_hris_erase_every_line_parsed")}`,
    `- Probe step at the 2 MiB cap (${m.probe_step_at_cap_clean!.mib} MiB): ${v("probe_step_at_cap_clean")} after a clean erasure, ${v("probe_step_at_cap_every_line")} with the subject still in every object`,
    `- Audit verification window of 100 events: ${v("audit_verify_window_100")}; audit export page of 500 rows: ${v("audit_export_page_500")}; KV probe over 420 values: ${v("kv_probe_420_values")}`,
    `- Largest step-sized path: ${d.largest_step_ms} ms (fastest warm run; largest median ${d.largest_step_median_ms ?? d.largest_step_ms} ms) on this machine; at ${d.design.edge_factor} times (edge cores and cold isolates) ${d.at_edge_factor_ms ?? (d.largest_step_ms * d.design.edge_factor).toFixed(2)} ms against Free's ${d.design.free_cpu_limit_ms} ms (${d.within_target ? "within" : "over"} the design target of ${d.design.target_ms_here} ms here, which keeps a 25% margin). Miniflare enforces no CPU limit; production readings come from the canary deletion and the doctor's CPU p99 line`,
  ];
}

const share = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

function drift(f: ResultFile): string[] {
  const d = f.data;
  const s = d.scores;
  return [
    `**Schema-drift triage, ${d.target}** (\`${d.command}\`, ${d.date}; ${d.environment})`,
    "",
    `- Model: \`${d.model}\`; every number below comes from this model only (the deterministic stub produces no reported number)`,
    `- Sensitive recall: ${share(s.sensitive_recall)} of ${s.sensitive_columns} labeled sensitive columns put in a sensitive class (${share(s.sensitive_recall_opaque_names)} where the name is opaque); rule classes alone ${share(s.rule_sensitive_recall)}, suggestions max_severity(rule, model) ${share(s.suggested_sensitive_recall)}`,
    `- Exact class accuracy ${share(s.model_class_accuracy)} over ${s.columns} columns; ${share(s.suggested_false_sensitive_rate)} of the non-sensitive columns suggested as sensitive; ${s.invalid_outputs} answers outside the schema`,
    `- Cost: ${d.neurons_total} neurons in ${d.calls} calls over ${d.days} day(s) (rates of ${d.rates_checked}${d.daily_cap ? `, daily cap ${d.daily_cap}` : ", no cap locally"})`,
  ];
}

export function renderResults(files: ResultFile[]): string {
  if (files.length === 0) return "No results yet.";
  files.forEach(validate);
  const out: string[] = [];
  const local = files.every((f) => String(f.data.environment).startsWith("local"));
  out.push(
    local
      ? `All results below are local (Miniflare, DuckDB, pyiceberg SqlCatalog${files.some((f) => f.data.kind === "drift") ? ", llama-server" : ""}); nothing here ran on Cloudflare or Google Cloud. Generated by \`npm run readme:results\` from \`evals/results/\`.`
      : "Generated by `npm run readme:results` from `evals/results/`; each result names the environment it ran in.",
    "",
  );
  for (const f of latest(files)) {
    out.push(...(f.data.kind === "deletion" ? deletion(f) : f.data.kind === "cpu" ? cpu(f) : f.data.kind === "drift" ? drift(f) : authz(f)), "");
  }
  return out.join("\n").trimEnd();
}

export function replaceBlock(readme: string, block: string): string {
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s < 0 || e < s) throw new Error("README.md has no results block markers");
  return `${readme.slice(0, s + START.length)}\n${block}\n${readme.slice(e)}`;
}

export function loadResults(dir = path.join(REPO_ROOT, "evals", "results")): ResultFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((name) => ({ name, data: JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Json }));
}

async function main(): Promise<void> {
  const file = path.join(REPO_ROOT, "README.md");
  const next = replaceBlock(readFileSync(file, "utf8"), renderResults(loadResults()));
  writeFileSync(file, next);
  console.log("README.md results block updated");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
