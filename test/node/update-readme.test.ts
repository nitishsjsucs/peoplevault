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
      requests: { total: 25, by_status: { completed_with_residuals: 16, failed: 5, held: 4 } },
      coverage: { ...cov(157, 157), by_category: { source_exports: cov(18, 18), application_caches: cov(0, 0) } },
      oracle: { oracle_coverage: cov(157, 157), agreement: 1, false_clean: 0, false_residue: 0 },
      faults: { scenarios: 5, detected: 5, by_store: { r2: { detected: 1, scenarios: 1 } }, undetected_by_design: 0, variants: [] },
      holds: { held_requests: 4, held_data_intact: 4 },
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
    expect(text).toContain("application caches: n/a (0 applicable pairs)");
    expect(text).toContain("5 of 5 planted residues of designed types detected");
    expect(text).toContain("nothing here ran on Cloudflare or Google Cloud");
    expect(text).not.toMatch(/BigQuery|Basin/);
  });

  it("renders the audit verification windows and the audit copy when the result has them", () => {
    const f = deletionFile();
    f.data.audit_chain = { ok: true, length: 963, windows: 10 };
    f.data.audit_copy = { table: "governance.audit_events", rows: 970, copied_this_run: 970, last_seq: 970, chain_length: 963, last_hash_matches: true, lag_after_export: 2 };
    const text = renderResults([f]);
    expect(text).toContain("verified over 963 events (10 windows of at most 100)");
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
          probe_step_at_cap_every_line: m(1.7), audit_verify_window_100: m(1.5), audit_export_page_500: m(0.6), kv_probe_420_values: m(0.3), erase_all_exports_prefiltered: m(4.2),
        },
        design: { target_ms_here: 2.5, edge_factor: 3, free_cpu_limit_ms: 10 }, largest_step_ms: 1.8, within_target: true,
      },
    };
    const text = renderResults([f]);
    expect(text).toContain("**CPU of the Worker's hot paths** (`npm run bench:cpu`, 2026-10-10; local (Node v25.9.0 on darwin arm64, Apple M3); 8 cores, 1-minute load average 2.5 at the start)");
    expect(text).toContain("123 comparisons over all 41 generated export objects");
    expect(text).toContain("Largest median 1.8 ms against the design target of 2.5 ms on this machine");
    expect(text).toContain("within target");
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
