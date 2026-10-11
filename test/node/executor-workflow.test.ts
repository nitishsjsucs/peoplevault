// .github/workflows/executor.yml (P1, SPEC.md section 20): the hourly production executor. Checked statically because
// it only runs on GitHub with production secrets: schedule, no overlap, skipped until enabled, exactly the secrets
// setup:prod uploads, the variables the Python side reads, public-log hygiene and the key's lifetime.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GITHUB_SECRETS } from "../../scripts/lib/github.ts";
import { REPO_ROOT } from "../../scripts/lib/run.ts";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Workflow {
  on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
  concurrency: { group: string; "cancel-in-progress": boolean };
  permissions: Record<string, string>;
  jobs: { executor: { if: string; "runs-on": string; "timeout-minutes": number; env: Record<string, string>; steps: Step[] } };
}

const text = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "executor.yml"), "utf8");
const wf = parse(text) as Workflow;
const job = wf.jobs.executor;

describe("executor.yml", () => {
  it("runs hourly and on demand, never two at once, read-only token, skipped until PV_PROD_ENABLED is true", () => {
    expect(wf.on.schedule).toEqual([{ cron: "7 * * * *" }]);
    expect(wf.on.workflow_dispatch).toBeTruthy();
    expect(wf.concurrency).toEqual({ group: "pv-executor-prod", "cancel-in-progress": false });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.if).toBe("vars.PV_PROD_ENABLED == 'true'");
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBeLessThan(60);
  });

  it("reads exactly the repository secrets that setup:prod uploads", () => {
    const used = new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual([...GITHUB_SECRETS].sort());
  });

  it("sets every variable the Python executor reads on each pv step only, with public logs and the key-based dbt target", () => {
    const pvSteps = job.steps.filter((s) => (s.run ?? "").startsWith("uv run --project pipelines pv "));
    expect(pvSteps).toHaveLength(3);
    for (const step of pvSteps)
      for (const name of ["PV_BASE_URL", "PV_CF_ACCESS_CLIENT_ID_EXECUTOR", "PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR", "PV_GCP_PROJECT", "PV_R2_CATALOG_TOKEN", "PV_CATALOG_URI", "PV_CATALOG_WAREHOUSE", "PV_POLICY_TAGS_JSON"])
        expect(step.env?.[name], `${step.name}: ${name}`).toMatch(/^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/);
    // no secret at job level, so checkout, setup-uv and uv sync never see one
    expect(job.env).toEqual({ PV_PUBLIC_LOGS: "true", PV_DBT_TARGET: "bigquery_actions" });
    for (const step of job.steps.filter((s) => s.uses || s.run === "uv sync --project pipelines --locked")) expect(step.env, step.uses ?? step.run).toBeUndefined();
    const python = readFileSync(path.join(REPO_ROOT, "pipelines", "src", "peoplevault", "executor", "prod.py"), "utf8");
    for (const name of ["PV_BASE_URL", "PV_CF_ACCESS_CLIENT_ID_EXECUTOR", "PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR", "PV_GCP_PROJECT"]) expect(python).toContain(`"${name}"`);
  });

  it("uses the same actions, pinned to full commit SHAs, and uv as CI, and does not keep git credentials", () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => s.uses);
    expect(uses).toEqual(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "astral-sh/setup-uv@1c37ad07a6a961277cf70c0d37d6f313000f5884"]);
    const ci = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
    for (const wfText of [text, ci]) for (const m of wfText.matchAll(/uses: (\S+)/g)) expect(m[1], m[1]).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    for (const u of uses) expect(ci).toContain(`uses: ${u}`);
    expect(job.steps[0]!.with).toEqual({ "persist-credentials": false });
    expect(job.steps[1]!.with).toMatchObject({ version: "0.12.17", "python-version": "3.12" });
    expect(job.steps.some((s) => s.run === "uv sync --project pipelines --locked")).toBe(true);
  });

  it("writes the key with umask 077 into the runner temp dir and always deletes it", () => {
    const write = job.steps.find((s) => s.name === "Write the peoplevault-executor key")!;
    expect(write.env).toEqual({ PV_GCP_EXECUTOR_KEY: "${{ secrets.PV_GCP_EXECUTOR_KEY }}" });
    expect(write.run).toMatch(/^umask 077\n/);
    expect(write.run).toContain('"$RUNNER_TEMP/gcp.json"');
    const del = job.steps.at(-1)!;
    expect(del).toMatchObject({ if: "always()", run: 'rm -f "$RUNNER_TEMP/gcp.json"' });
  });

  it("drains tasks every run and checks residuals once a day at 04 UTC, logging at warning and never storing failures", () => {
    const runs = job.steps.map((s) => s.run ?? "");
    expect(runs).toContain("uv run --project pipelines pv --log-level warning executor run --target prod --drain");
    const residuals = job.steps.find((s) => (s.run ?? "").includes("residuals check"))!;
    expect(residuals.run).toBe("uv run --project pipelines pv --log-level warning residuals check --target prod");
    expect(residuals.if).toBe("steps.clock.outputs.hour == '04' || inputs.residuals");
    // the audit copy replaces Basin Pipelines (Workers Paid only): pulled hourly when due (SPEC.md section 30.3.3)
    const exportStep = job.steps.find((s) => (s.run ?? "").includes("audit export"))!;
    expect(exportStep.run).toBe("uv run --project pipelines pv --log-level warning audit export --target prod --if-due");
    expect(exportStep.if).toBeUndefined();
    expect(text).not.toMatch(/store[-_]failures|--log-level (debug|info)\b|set -x/);
  });
});
