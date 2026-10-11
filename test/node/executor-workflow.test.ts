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

  it("sets every variable the Python executor reads in production, with public logs and the key-based dbt target", () => {
    for (const name of ["PV_BASE_URL", "PV_CF_ACCESS_CLIENT_ID_EXECUTOR", "PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR", "PV_GCP_PROJECT", "PV_R2_CATALOG_TOKEN", "PV_CATALOG_URI", "PV_CATALOG_WAREHOUSE", "PV_POLICY_TAGS_JSON"])
      expect(job.env[name], name).toMatch(/^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/);
    expect(job.env.PV_PUBLIC_LOGS).toBe("true");
    expect(job.env.PV_DBT_TARGET).toBe("bigquery_actions");
    const python = readFileSync(path.join(REPO_ROOT, "pipelines", "src", "peoplevault", "executor", "prod.py"), "utf8");
    for (const name of ["PV_BASE_URL", "PV_CF_ACCESS_CLIENT_ID_EXECUTOR", "PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR", "PV_GCP_PROJECT"]) expect(python).toContain(`"${name}"`);
  });

  it("uses the same pinned actions and uv as CI, and does not keep git credentials", () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => s.uses);
    expect(uses).toEqual(["actions/checkout@v7", "astral-sh/setup-uv@v10.3.0"]);
    expect(job.steps[0]!.with).toEqual({ "persist-credentials": false });
    expect(job.steps[1]!.with).toMatchObject({ version: "0.12.17", "python-version": "3.12" });
    expect(job.steps.some((s) => s.run === "uv sync --project pipelines --locked")).toBe(true);
  });

  it("writes the key with umask 077 into the runner temp dir and always deletes it", () => {
    const write = job.steps.find((s) => s.name === "Write the pv-executor key")!;
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
    expect(text).not.toMatch(/store[-_]failures|--log-level (debug|info)\b|set -x/);
  });
});
