// Golden plans of `npm run setup:prod -- --dry-run` for an empty, a partly set up and a complete account
// (SPEC.md section 22.2). planSetup() and preflight() are pure; the states below stand in for what gatherState() reads.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONA_TOKENS } from "../../scripts/lib/checks.ts";
import { AUD_PENDING } from "../../scripts/lib/prod-files.ts";
import { REPO_ROOT } from "../../scripts/lib/run.ts";
import { accessAppBody, desiredRender, planSetup, preflight, renderPlan, type SetupState } from "../../scripts/setup-prod.ts";

const GOLDEN = path.join(REPO_ROOT, "test", "fixtures", "golden");
const SECRETS = { PV_CF_API_TOKEN: "cf-token-value-zq1", PV_R2_CATALOG_TOKEN: "r2-token-value-zq2" };
const ENV_FULL: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: "acct-0123",
  PV_GCP_PROJECT: "peoplevault-test",
  PV_ACCESS_ALLOWED_EMAILS: "owner+hr@example.test,owner+mgr@example.test,owner+analyst@example.test,owner+privacy@example.test",
  PV_ACCESS_PERSONA_EMAILS: "owner+hr@example.test=hrbp-01,owner+mgr@example.test=mgr-001,owner+analyst@example.test=analyst-01,owner+privacy@example.test=privacy-01",
  PV_WORKERS_SUBDOMAIN: "nitish-pv",
  PV_CF_API_TOKEN: SECRETS.PV_CF_API_TOKEN,
  PV_R2_CATALOG_TOKEN: SECRETS.PV_R2_CATALOG_TOKEN,
};

function empty(): SetupState {
  return {
    accountId: null, loggedIn: false, teamDomain: null, subdomain: null, buckets: [], d1: [], kv: [], queues: [], catalogEnabled: false, workerId: null,
    workerSecrets: [], accessApp: null, serviceTokens: [], resources: {}, workerSecretsFile: [], renderedText: null,
    gcpMissing: [{ name: "gcloud", fix: "brew install --cask gcloud-cli" }], dataLoaded: false,
  };
}

function partial(): SetupState {
  return {
    ...empty(), accountId: "acct-0123", loggedIn: true, teamDomain: "nitish-pv.cloudflareaccess.com", subdomain: null,
    buckets: ["pv-source-exports"], d1: [{ name: "pv-control", uuid: "11111111-2222-3333-4444-555555555555" }], kv: [], queues: ["pv-retention-sweep"],
    serviceTokens: [{ id: "st-1", name: "pv-executor", client_id: "exec.access" }], gcpMissing: [],
  };
}

function complete(): SetupState {
  const tokens = PERSONA_TOKENS.map((name, i) => ({ id: `st-${i}`, name, client_id: `${name}.access` }));
  const s: SetupState = {
    accountId: "acct-0123", loggedIn: true, teamDomain: "nitish-pv.cloudflareaccess.com", subdomain: "nitish-pv", buckets: ["pv-source-exports", "pv-derived", "pv-lake"],
    d1: [{ name: "pv-control", uuid: "11111111-2222-3333-4444-555555555555" }], kv: [{ id: "0123456789abcdef0123456789abcdef", title: "pv-cache" }],
    queues: ["pv-retention-sweep", "pv-retention-dlq"], catalogEnabled: true, workerId: "w-1", workerSecrets: ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"],
    accessApp: { id: "app-1", aud: "aud-123" }, serviceTokens: tokens,
    resources: { d1_id: "11111111-2222-3333-4444-555555555555", kv_id: "0123456789abcdef0123456789abcdef" },
    workerSecretsFile: ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"], renderedText: null, gcpMissing: [], dataLoaded: true,
  };
  return s;
}

function completeEnv(): Record<string, string> {
  const env: Record<string, string> = { ...ENV_FULL, PV_CATALOG_URI: "https://catalog.example.test/acct", PV_CATALOG_WAREHOUSE: "acct_pv-lake", PV_BASE_URL: "https://peoplevault.nitish-pv.workers.dev" };
  for (const suffix of ["EXECUTOR", "HR", "MANAGER", "ANALYST", "PRIVACY"]) env[`PV_CF_ACCESS_CLIENT_SECRET_${suffix}`] = `client-secret-value-zq-${suffix}`;
  return env;
}

function plan(s: SetupState, env: Record<string, string>): string {
  return renderPlan(preflight(s, env), planSetup(s, env, desiredRender(s, env)), null) + "\n";
}

function golden(name: string, text: string): void {
  const file = path.join(GOLDEN, `setup-prod-${name}.txt`);
  if (process.env.PV_UPDATE_GOLDEN === "1") writeFileSync(file, text);
  expect(text).toBe(readFileSync(file, "utf8"));
  for (const v of [...Object.values(SECRETS), "value-zq"]) expect(text).not.toContain(v);
}

describe("setup:prod --dry-run", () => {
  it("empty account: preflight lists what only Nitish can do, and the full plan follows", () => {
    golden("empty", plan(empty(), {}));
  });

  it("partly set up account: creates only what is missing, registers the subdomain after asking, rotates an unrecorded token secret", () => {
    const text = plan(partial(), { ...ENV_FULL });
    golden("partial", text);
    expect(text).not.toContain("r2 bucket create pv-source-exports");
    expect(text).toContain("rotate");
  });

  it("complete account: nothing to create (migrations re-apply as a no-op)", () => {
    const s = complete();
    const env = completeEnv();
    s.renderedText = desiredRender(s, env);
    const text = plan(s, env);
    golden("complete", text);
    expect(planSetup(s, env, s.renderedText).map((st) => st.id)).toEqual(["gcp:setup", "worker:migrate"]);
  });

  it("renders the production config with every placeholder filled and ACCESS_AUD pending until the Access app exists", () => {
    const s = complete();
    s.accessApp = null;
    const text = desiredRender(s, completeEnv())!;
    expect(text).not.toMatch(/__[A-Z0-9_]+__/);
    expect(text).toContain(`"ACCESS_AUD": "${AUD_PENDING}"`);
    expect(text).toContain('"database_id": "11111111-2222-3333-4444-555555555555"');
    expect(text).toContain("pv-gateway@peoplevault-test.iam.gserviceaccount.com");
    expect(text).toMatch(/"invocation_logs": false/);
  });

  it("builds the Access application body from the template", () => {
    const body = accessAppBody(readFileSync(path.join(REPO_ROOT, "infra", "cloudflare", "access-app.template.json"), "utf8"), {
      subdomain: "nitish-pv",
      workerId: "w-1",
      emails: ["a@example.test", "b@example.test"],
      serviceTokenIds: ["st-1", "st-2"],
    });
    expect(body).toMatchObject({ type: "self_hosted", name: "PeopleVault", domain: "peoplevault.nitish-pv.workers.dev", destinations: [{ type: "worker", worker_id: "w-1" }] });
    expect(Object.keys(body).some((k) => k.startsWith("_"))).toBe(false);
    const policies = body.policies as { name: string; decision: string; include: unknown[] }[];
    expect(policies.map((p) => [p.name, p.decision, p.include.length])).toEqual([["allow-owner", "allow", 2], ["service-tokens", "non_identity", 2]]);
    expect(policies[1]!.include[0]).toEqual({ service_token: { token_id: "st-1" } });
    expect(() => accessAppBody(JSON.stringify({ type: "self_hosted" }), { subdomain: "", workerId: "w", emails: ["a@x"], serviceTokenIds: ["s"] })).toThrow();
  });
});
