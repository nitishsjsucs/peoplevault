// npm run readme:results changes only the marked block, prints only numbers present in result files with their
// command, date and environment, and refuses files without a complete header or from a dirty tree.
import { describe, expect, it } from "vitest";
import { END, START, renderResults, replaceBlock, validate, type ResultFile } from "../../scripts/update-readme.ts";

const LOCAL = "local (Miniflare, DuckDB, pyiceberg SqlCatalog)";
const header = { command: "npm run eval:deletion:ci", date: "2026-10-10", git_sha: "abc", git_dirty: false, environment: LOCAL };
const cov = (n: number, d: number) => ({ display: d ? `${((100 * n) / d).toFixed(1)}%` : "n/a", applicable_pairs: d, clean_pairs: n });

function deletionFile(over: Record<string, unknown> = {}): ResultFile {
  return {
    name: "deletion-ci-2026-10-10.json",
    data: {
      ...header,
      kind: "deletion",
      profile: "ci",
      requests: { total: 25, by_status: { completed_with_residuals: 16, failed: 5, held: 4 }, cohorts: { R: 12, R_held: 2, D: 6, H: 2, F: 5, variants: 0 } },
      coverage: { ...cov(157, 157), requests: 16, by_category: { source_exports: cov(18, 18), application_caches: cov(0, 0) } },
      report: { coverage: { value: 0.932, display: "93.2%", applicablePairs: 222, cleanPairs: 207 } },
      oracle: { oracle_coverage: cov(157, 157), agreement: 1, false_clean: 0, false_residue: 0 },
      faults: { scenarios: 5, planned: 5, detected: 5, by_store: { r2: { detected: 1, scenarios: 1 } }, undetected_by_design: 0, variants: [] },
      holds: { held_requests: 4, held_subjects: 4, held_data_intact: 4, expected_held_subjects: 4 },
      retention: { retention_requests: 10, retention_held: 2, export_objects_deleted: 3, export_objects_minimized_for_hold: 5, extracts_expired: 3, matches_expected: { a: true } },
      applicability_agreement: { agree: 192, pairs: 192, disagreements: [] },
      audit_chain: { ok: true, length: 956 },
      timing_ms: { workflow_p50: 8600, workflow_p95: 30200 },
      gate: { passed: true },
      ...over,
    },
  };
}

describe("readme:results", () => {
  it("replaces only the text between the markers", () => {
    const readme = `# T\n\nbefore\n\n${START}\nold\n${END}\n\nafter\n`;
    const next = replaceBlock(readme, "new block");
    expect(next).toBe(`# T\n\nbefore\n\n${START}\nnew block\n${END}\n\nafter\n`);
    expect(() => replaceBlock("no markers", "x")).toThrow(/markers/);
  });

  it("renders a deletion result with its command, date, environment and designed-fault wording", () => {
    const text = renderResults([deletionFile()]);
    expect(text).toContain("`npm run eval:deletion:ci`, 2026-10-10; local (Miniflare, DuckDB, pyiceberg SqlCatalog)");
    expect(text).toContain("100.0% of 157 applicable pairs");
    // the coverage scope names exactly what was scored, and the planted failures are labeled as such
    expect(text).toContain("- Coverage (system verdicts over the 16 retention and data subject requests of cohorts R and D that were not held; the 5 planted-fault requests fail by design and are scored under fault detection): 100.0% of 157 applicable pairs");
    expect(text).toContain("- Requests: 25 (completed with residuals 16, failed 5 (the planted-fault requests, by design), held 4)");
    expect(text).toContain("- Deletion report (the product's own coverage, over every request): 93.2% of 222 applicable pairs, lower because it includes the planted-fault requests");
    expect(text).toContain("- Legal holds: 4 held requests for 4 held subjects (2 DSR and 2 retention subjects under hold in the cohorts), held data intact for 4");
    expect(text).toContain("- Retention sweep: 10 retention requests not held plus 2 held (12 in all)");
    expect(text).not.toContain("retention and DSR requests that were not held)");
    expect(text).toContain("application caches: n/a (0 applicable pairs)");
    expect(text).toContain("5 of 5 planted residues of designed types detected");
    expect(text).toContain("nothing here ran on Cloudflare or Google Cloud");
    expect(text).not.toMatch(/BigQuery|Basin/);
  });

  it("renders the audit verification windows and the audit copy when the result has them", () => {
    const f = deletionFile();
    f.data.audit_chain = { ok: true, length: 963, windows: 10, window: 100 };
    f.data.audit_copy = { table: "governance.audit_events", rows: 970, copied_this_run: 970, last_seq: 970, chain_length: 963, last_hash_matches: true, lag_after_export: 2 };
    const text = renderResults([f]);
    expect(text).toContain("verified over 963 events (10 windows of at most 100 events)");
    expect(text).toContain("Audit copy (`pv audit export`, pyiceberg SqlCatalog table `governance.audit_events`): 970 rows, 970 copied by this run; last hash equals D1's at seq 970");
  });

  it("renders the CPU benchmark with its machine and load, and says whether the largest step is within the target", () => {
    const m = (x: number) => ({ warm_median_ms: x, warm_min_ms: x / 2, cold_ms: x });
    const f: ResultFile = {
      name: "cpu-2026-10-11.json",
      data: {
        ...header, kind: "cpu", command: "npm run bench:cpu", environment: "local (Node v25.9.0 on darwin arm64, Apple M3)", machine: { cpus: 8, load_average_1m: 2.5, total_memory_gib: 16 },
        prefilter_identical: { objects: 41, subjects: 3, comparisons: 123 },
        measurements_ms: {
          erase_step_at_cap: { ...m(1.8), objects: 6, mib: 3.62 }, revision2_hris_erase_every_line_parsed: { ...m(13.9), objects: 13 }, probe_step_at_cap_clean: { ...m(0.9), mib: 1.81 },
          probe_step_at_cap_every_line: m(1.7), audit_verify_window_50: m(1.5), audit_export_page_500: m(0.6), kv_probe_420_values: m(0.3), erase_all_exports_prefiltered: m(4.2),
        },
        design: { target_ms_here: 2.5, edge_factor: 3, free_cpu_limit_ms: 10 }, largest_step_median_ms: 1.8, largest_step_fastest_run_ms: 0.9, within_target: true,
      },
    };
    const text = renderResults([f]);
    expect(text).toContain("**CPU of the Worker's hot paths** (`npm run bench:cpu`, 2026-10-10; local (Node v25.9.0 on darwin arm64, Apple M3); 8 cores, 1-minute load average 2.5 at the start)");
    expect(text).toContain("123 comparisons over all 41 generated export objects");
    expect(text).toContain("Audit verification window of 50 events: 1.5 ms (fastest run 0.75 ms)");
    expect(text).toContain("Largest step-sized path, judged on warm medians (SPEC.md section 30.2): 1.8 ms on this machine (largest fastest run 0.9 ms); at 3 times (edge cores and cold isolates) 5.40 ms against Free's 10 ms, within the design target of 2.5 ms here (7.5 ms at 3 times, a 25% margin)");
    // the verdict follows the median, never the fastest run
    const over = renderResults([{ ...f, data: { ...f.data, largest_step_median_ms: 2.626, largest_step_fastest_run_ms: 2.196 } }]);
    expect(over).toContain("2.626 ms on this machine (largest fastest run 2.196 ms); at 3 times (edge cores and cold isolates) 7.88 ms against Free's 10 ms, over the design target of 2.5 ms here");
  });

  it("renders the schema-drift triage with the model that produced every number, and its neurons and days", () => {
    const f: ResultFile = {
      name: "drift-local-2026-10-11.json",
      data: {
        ...header, kind: "drift", target: "local", date: "2026-10-11", command: "uv run --project pipelines pv eval drift --target local --start --ai-mode llama-server",
        environment: "local (Miniflare, llama-server/Qwen3-1.7B-Q4_0 on port 8170)", model: "llama-server/Qwen3-1.7B-Q4_0", neurons_total: 0, calls: 120, days: 1, rates_checked: "2026-10-10", daily_cap: null,
        scores: { columns: 120, sensitive_columns: 84, sensitive_recall: 0.9048, sensitive_recall_opaque_names: 0.8333, rule_sensitive_recall: 0.5595, suggested_sensitive_recall: 0.9524, model_class_accuracy: 0.725, suggested_false_sensitive_rate: 0.1389, invalid_outputs: 0 },
      },
    };
    const text = renderResults([deletionFile(), f]);
    expect(text).toContain("All results below are local (Miniflare, DuckDB, pyiceberg SqlCatalog, llama-server)");
    expect(text).toContain("**Schema-drift triage, local** (`uv run --project pipelines pv eval drift --target local --start --ai-mode llama-server`, 2026-10-11; local (Miniflare, llama-server/Qwen3-1.7B-Q4_0 on port 8170))");
    expect(text).toContain("- Model: `llama-server/Qwen3-1.7B-Q4_0`; every number below comes from this model only");
    expect(text).toContain("- Sensitive recall: 90.5% of 84 labeled sensitive columns put in a sensitive class (83.3% where the name is opaque); rule classes alone 56.0%, suggestions max_severity(rule, model) 95.2%");
    expect(text).toContain("- Cost: 0 neurons in 120 calls over 1 day(s) (rates of 2026-10-10, no cap locally)");
    expect(text.indexOf("Schema-drift")).toBeGreaterThan(text.indexOf("Deletion eval"));
    expect(renderResults([deletionFile()])).not.toContain("llama-server");
  });

  it("refuses files with a missing header field or from a dirty tree", () => {
    for (const k of ["command", "date", "git_sha", "git_dirty", "environment"]) {
      const f = deletionFile();
      delete (f.data as Record<string, unknown>)[k];
      expect(() => validate(f)).toThrow(k);
    }
    expect(() => renderResults([deletionFile({ git_dirty: true })])).toThrow(/uncommitted/);
  });

  it("renders the API layer with its runnable count and every skip reason", () => {
    const f: ResultFile = {
      name: "authz-api-local-2026-10-10.json",
      data: {
        ...header,
        command: "npm run authz:api:local",
        kind: "authz",
        cases_total: 100,
        layers: { api: { target: "local", runnable: 85, passed: 85, failed: 0, skipped: 15 } },
        skip_reasons: { "forged tokens cannot pass Cloudflare Access": 10, "principal mgr-003 has no token": 5 },
      },
    };
    const text = renderResults([f]);
    expect(text).toContain("**Authorization cases** (`npm run authz:api:local`, 2026-10-10; local (Miniflare, DuckDB, pyiceberg SqlCatalog))");
    expect(text).toContain("- Through the API (local Worker, limited to the tokens production has, full synthetic population, one token per persona principal and the executor): 85 of 85 runnable cases passed; 15 of 100 not runnable there");
    expect(text).toContain("  - 10 skipped: forged tokens cannot pass Cloudflare Access");
  });

  it("keeps the latest file per kind and profile", () => {
    const old = deletionFile({ date: "2026-10-09", requests: { total: 1, by_status: { failed: 1 } } });
    old.name = "deletion-ci-2026-10-09.json";
    const text = renderResults([old, deletionFile()]);
    expect(text).toContain("Requests: 25");
    expect(text).not.toContain("Requests: 1 ");
  });
});
