// Pins the Workers Free configuration (SPEC.md sections 18.5 and 30.3.5) so a later change cannot drift back into
// Workers Paid territory: no `limits`, no `pipelines`, no Durable Objects, Workers AI capped, one Cron Trigger, the five Free vars with
// their exact production values, the 64-variable limit, 3-day instance retention and 7-day D1 Time Travel.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE } from "../../scripts/lib/prod-files.ts";
import { REPO_ROOT } from "../../scripts/lib/run.ts";

// Worker modules use Worker globals the node project does not type, so their constants are read from the source.
const src = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const retention = /INSTANCE_RETENTION = \{ successRetention: "([^"]+)", errorRetention: "([^"]+)" \}/.exec(src("src/worker/requests.ts"));
const INSTANCE_RETENTION = { successRetention: retention?.[1] ?? "", errorRetention: retention?.[2] ?? "" };
const D1_TIME_TRAVEL_DAYS = Number(/export const D1_TIME_TRAVEL_DAYS = (\d+);/.exec(src("src/worker/residuals/residuals.ts"))?.[1]);

function stripJsonc(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

type Config = Record<string, unknown> & { vars: Record<string, string>; secrets: { required: string[] }; triggers: { crons: string[] } };
const template = JSON.parse(stripJsonc(readFileSync(TEMPLATE, "utf8"))) as Config;
const local = JSON.parse(stripJsonc(readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8"))) as Config;

const FREE_VARS_PROD = {
  DAILY_DELETION_STARTS: "16",
  RETENTION_DAILY_MAX: "8",
  RETENTION_CRON: "off",
  R2_ERASE_STEP_BYTES: "4194304",
  R2_PROBE_STEP_BYTES: "2097152",
};

function days(duration: string): number {
  const m = /^(\d+) (second|minute|hour|day)s?$/.exec(duration);
  if (!m) throw new Error(`not a duration: ${duration}`);
  const n = Number(m[1]);
  return { second: n / 86_400, minute: n / 1_440, hour: n / 24, day: n }[m[2] as "second" | "minute" | "hour" | "day"];
}

describe("production template on Workers Free", () => {
  it("has no Paid-only or Durable Object blocks", () => {
    for (const key of ["limits", "pipelines", "durable_objects", "migrations", "containers"]) expect(template, key).not.toHaveProperty(key);
    expect(JSON.stringify(template)).not.toMatch(/cpu_ms|AUDIT_STREAM"|"stream"/);
  });

  it("Workers AI (P1, Free: 10,000 neurons a day per account, F17) is capped at 2,000 a day through the gateway, in production only", () => {
    expect(template.ai).toEqual({ binding: "AI" });
    expect(local).not.toHaveProperty("ai");
    expect(template.vars).toMatchObject({ AI_MODE: "workers-ai", AI_GATEWAY_ID: "peoplevault", AI_DAILY_NEURONS: "2000", LLM_URL: "" });
    expect(Number(template.vars.AI_DAILY_NEURONS)).toBeLessThanOrEqual(10_000 * 0.25 * 0.8);
    expect(local.vars).toMatchObject({ AI_MODE: "stub", AI_GATEWAY_ID: "", AI_DAILY_NEURONS: "", LLM_URL: "http://127.0.0.1:8170" });
  });

  it("declares exactly one Cron Trigger (the account allows 5, shared by four repos)", () => {
    expect(template.triggers.crons).toEqual(["0 3 * * *"]);
    expect(local.triggers.crons).toEqual(template.triggers.crons);
  });

  it("sets the five Free plan vars to their exact production values", () => {
    for (const [name, value] of Object.entries(FREE_VARS_PROD)) expect(template.vars[name], name).toBe(value);
  });

  it("stays within 64 environment variables (vars plus secrets)", () => {
    expect(Object.keys(template.vars).length + template.secrets.required.length).toBeLessThanOrEqual(64);
  });

  it("the local config declares the same var names, unlimited capacity and the same byte caps", () => {
    expect(Object.keys(local.vars).sort()).toEqual(Object.keys(template.vars).sort());
    expect(local.vars.DAILY_DELETION_STARTS).toBe("");
    expect(local.vars.RETENTION_DAILY_MAX).toBe("");
    expect(local.vars.RETENTION_CRON).toBe("on");
    expect(local.vars.R2_ERASE_STEP_BYTES).toBe(FREE_VARS_PROD.R2_ERASE_STEP_BYTES);
    expect(local.vars.R2_PROBE_STEP_BYTES).toBe(FREE_VARS_PROD.R2_PROBE_STEP_BYTES);
  });

  it("keeps invocation logs off in both configs", () => {
    for (const c of [template, local]) expect((c.observability as { logs: { invocation_logs: boolean } }).logs.invocation_logs).toBe(false);
  });
});

describe("plan-dependent constants", () => {
  it("Workflow instances are kept at most 3 days (Free keeps 3 and retention can only shorten it)", () => {
    expect(days(INSTANCE_RETENTION.successRetention)).toBeLessThanOrEqual(3);
    expect(days(INSTANCE_RETENTION.errorRetention)).toBeLessThanOrEqual(3);
  });

  it("D1 Time Travel is modeled at 7 days in TypeScript and Python", () => {
    expect(D1_TIME_TRAVEL_DAYS).toBe(7);
    const py = readFileSync(path.join(REPO_ROOT, "pipelines", "src", "peoplevault", "residuals", "model.py"), "utf8");
    expect(py).toMatch(/^D1_TIME_TRAVEL_DAYS = 7$/m);
  });
});

describe("Workflow code makes no external fetch (Free allows 50 per invocation; the design uses 0)", () => {
  it("no module a Workflow step runs calls fetch", async () => {
    const { readdirSync } = await import("node:fs");
    const dirs = ["workflows", "erase", "verify", "storage", "retention", "executor", "holds", "residuals", "audit", "assets"];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const f of readdirSync(path.join(REPO_ROOT, "src", "worker", dir))) {
        if (f.endsWith(".ts") && /\bfetch\(/.test(src(`src/worker/${dir}/${f}`))) offenders.push(`${dir}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
