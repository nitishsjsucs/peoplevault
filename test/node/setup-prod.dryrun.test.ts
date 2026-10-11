// Golden plans of `npm run setup:prod -- --dry-run` for an empty, a partly set up and a complete account
// (SPEC.md section 22.2). planSetup() and preflight() are pure; the states below stand in for what gatherState() reads.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONA_TOKENS } from "../../scripts/lib/checks.ts";
import { GITHUB_SECRETS, GITHUB_SECRET_SOURCES, githubRepo, sha256, type GithubState } from "../../scripts/lib/github.ts";
import { AUD_PENDING } from "../../scripts/lib/prod-files.ts";
import { REPO_ROOT } from "../../scripts/lib/run.ts";
import { accessAppBody, desiredRender, planGithub, planSetup, preflight, renderPlan, type SetupState } from "../../scripts/setup-prod.ts";

const GOLDEN = path.join(REPO_ROOT, "test", "fixtures", "golden");
const REPO = "nitishsjsucs/peoplevault";
const NO_GITHUB: GithubState = { authed: false, repo: null, secrets: [], variables: {}, workflowState: null, lastSuccess: null };
const TAGS = { compensation: "projects/p/locations/us/taxonomies/1/policyTags/3" };
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
    workerSecrets: [], accessApp: null, serviceTokens: [], aiGateway: null, resources: {}, workerSecretsFile: [], renderedText: null,
    gcpMissing: [{ name: "gcloud", fix: "brew install --cask gcloud-cli" }], dataLoaded: false, github: NO_GITHUB,
  };
}

function partial(): SetupState {
  return {
    ...empty(), accountId: "acct-0123", loggedIn: true, teamDomain: "nitish-pv.cloudflareaccess.com", subdomain: null,
    buckets: ["pv-source-exports"], d1: [{ name: "pv-control", uuid: "11111111-2222-3333-4444-555555555555" }], kv: [], queues: ["pv-retention-sweep"],
    serviceTokens: [{ id: "st-1", name: "pv-executor", client_id: "exec.access" }], gcpMissing: [],
    // created by an earlier, interrupted setup run of this repo, which recorded them
    resources: { created_buckets: ["pv-source-exports"], created_queues: ["pv-retention-sweep"], d1_id: "11111111-2222-3333-4444-555555555555" },
    github: { ...NO_GITHUB, authed: true, repo: REPO },
  };
}

function complete(): SetupState {
  const tokens = PERSONA_TOKENS.map((name, i) => ({ id: `st-${i}`, name, client_id: `${name}.access` }));
  const s: SetupState = {
    accountId: "acct-0123", loggedIn: true, teamDomain: "nitish-pv.cloudflareaccess.com", subdomain: "nitish-pv", buckets: ["pv-source-exports", "pv-derived", "pv-lake"],
    d1: [{ name: "pv-control", uuid: "11111111-2222-3333-4444-555555555555" }], kv: [{ id: "0123456789abcdef0123456789abcdef", title: "pv-cache" }],
    queues: ["pv-retention-sweep", "pv-retention-dlq"], catalogEnabled: true, workerId: "w-1",
    workerSecrets: ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"],
    accessApp: { id: "app-1", aud: "aud-123" }, serviceTokens: tokens,
    aiGateway: { id: "peoplevault", collect_logs: false, cache_ttl: 0, rate_limiting_interval: 60, rate_limiting_limit: 10, rate_limiting_technique: "fixed" },
    resources: {
      d1_id: "11111111-2222-3333-4444-555555555555", kv_id: "0123456789abcdef0123456789abcdef", policy_tags: TAGS, audit_copy_table: true, audit_copy_expiration: true,
      created_buckets: ["pv-source-exports", "pv-derived", "pv-lake"], created_queues: ["pv-retention-sweep", "pv-retention-dlq"], worker_deployed: true, ai_gateway_created: true,
    },
    workerSecretsFile: ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"], renderedText: null, gcpMissing: [], dataLoaded: true,
    github: { authed: true, repo: REPO, secrets: [...GITHUB_SECRETS], variables: { PV_PROD_ENABLED: "true" }, workflowState: "active", lastSuccess: "2026-10-10T03:07:00Z" },
  };
  const env = completeEnv();
  s.resources.github_secrets = Object.fromEntries(Object.entries(GITHUB_SECRET_SOURCES).map(([n, f]) => [n, sha256(f(env, s.resources)!)]));
  return s;
}

function completeEnv(): Record<string, string> {
  const env: Record<string, string> = { ...ENV_FULL, PV_CATALOG_URI: "https://catalog.example.test/acct", PV_CATALOG_WAREHOUSE: "acct_pv-lake", PV_BASE_URL: "https://peoplevault.nitish-pv.workers.dev" };
  for (const suffix of ["EXECUTOR", "HR", "MANAGER", "ANALYST", "PRIVACY"]) {
    env[`PV_CF_ACCESS_CLIENT_ID_${suffix}`] = `${suffix.toLowerCase()}.access`;
    env[`PV_CF_ACCESS_CLIENT_SECRET_${suffix}`] = `client-secret-value-zq-${suffix}`;
  }
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

  it("preflight stops on missing Google Cloud prerequisites except the APIs, which pv setup gcp enables itself", () => {
    const s = { ...complete(), gcpMissing: [{ name: "billing", fix: "link billing" }, { name: "APIs", fix: "npm run setup:prod (pv setup gcp enables them)" }] };
    expect(preflight(s, completeEnv()).map((m) => m.item)).toEqual(["Google Cloud: billing"]);
  });

  it("complete account: nothing to create (migrations re-apply as a no-op)", () => {
    const s = complete();
    const env = completeEnv();
    s.renderedText = desiredRender(s, env);
    const text = plan(s, env);
    golden("complete", text);
    expect(planSetup(s, env, s.renderedText).map((st) => st.id)).toEqual(["gcp:setup", "worker:migrate"]);
  });

  it("github: needs gh login first, then plans the key, every secret on stdin and the variable last", () => {
    const s = complete();
    expect(planGithub({ ...s, github: NO_GITHUB }, completeEnv()).map((x) => x.id)).toEqual(["github:needs-auth"]);
    expect(planGithub({ ...s, github: { ...NO_GITHUB, authed: true } }, completeEnv()).map((x) => x.id)).toEqual(["github:needs-repo"]);
    const fresh = { ...s, resources: { ...s.resources, github_secrets: {} }, github: { ...NO_GITHUB, authed: true, repo: REPO, workflowState: "disabled_inactivity" } };
    const steps = planGithub(fresh, completeEnv());
    expect(steps.map((x) => x.id)).toEqual([
      "github:executor-key",
      ...Object.keys(GITHUB_SECRET_SOURCES).map((n) => `github:secret:${n}`),
      "github:enable",
      "github:variable",
    ]);
    const text = steps.map((x) => x.display).join("\n");
    expect(text).toContain("value on stdin");
    for (const v of Object.values(completeEnv())) if (v.includes("value-zq")) expect(text).not.toContain(v);
  });

  it("github: re-uploads only a secret whose value changed (for example a rotated service token)", () => {
    const s = complete();
    expect(planGithub(s, completeEnv())).toEqual([]);
    const rotated = { ...completeEnv(), PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR: "rotated-value-zq" };
    expect(planGithub(s, rotated).map((x) => x.id)).toEqual(["github:secret:PV_CF_ACCESS_CLIENT_SECRET"]);
  });

  it("github: waits for values that earlier groups write, and never enables the job early", () => {
    const s = partial();
    const ids = planGithub(s, { ...ENV_FULL }).map((x) => x.id);
    expect(ids).toContain("github:blocked");
    expect(ids.indexOf("github:blocked")).toBeLessThan(ids.indexOf("github:variable"));
    expect(planGithub(s, { ...ENV_FULL }).find((x) => x.id === "github:blocked")!.display).toContain("PV_BASE_URL");
  });

  it("the audit copy: the first export creates governance.audit_events, then its snapshot expiration (no token for a table)", () => {
    const text = plan(partial(), { ...ENV_FULL });
    expect(text).toContain("uv run --project pipelines pv audit export --target prod (creates the Basin Catalog table governance.audit_events");
    expect(text).toContain("npx wrangler basin catalog snapshot-expiration enable pv-lake governance audit_events");
    expect(text).not.toContain("--token");
    expect(planSetup(complete(), completeEnv(), null).map((x) => x.id)).not.toContain("data:audit-copy");
  });

  it("shared account: a same-named resource with no record stops setup, and the conflict names how to resolve it", () => {
    const s = complete();
    s.resources = { ...s.resources, created_buckets: ["pv-source-exports", "pv-derived"], d1_id: "another-database", worker_deployed: false };
    s.queues = [...s.queues];
    const items = preflight(s, completeEnv()).map((m) => m.item);
    expect(items).toEqual([
      "conflict: R2 bucket pv-lake exists but this repo has no record of creating it",
      "conflict: D1 database pv-control exists but its id is not the recorded d1_id",
      "conflict: Worker peoplevault exists but this repo has no record of deploying it",
    ]);
    expect(preflight(s, completeEnv())[0]!.fix).toContain("record it in .secrets/prod-resources.json");
    expect(preflight(complete(), completeEnv())).toEqual([]);
    expect(planSetup(complete(), completeEnv(), null).map((x) => x.id)).not.toContain("cloudflare:record");
  });

  it("the AI Gateway: created with no logs and no cache, repaired when its settings drift, never adopted without a record", () => {
    const text = plan(partial(), { ...ENV_FULL });
    expect(text).toContain('POST /client/v4/accounts/acct-0123/ai-gateway/gateways {"id":"peoplevault","cache_ttl":0,"cache_invalidate_on_update":false,"collect_logs":false,"rate_limiting_interval":60,"rate_limiting_limit":10,"rate_limiting_technique":"fixed"}');
    const drifted = complete();
    drifted.aiGateway = { ...drifted.aiGateway!, collect_logs: true, cache_ttl: 300 };
    const steps = planSetup(drifted, completeEnv(), null).filter((x) => x.id.startsWith("ai-gateway"));
    expect(steps.map((x) => x.id)).toEqual(["ai-gateway:update"]);
    expect(steps[0]!.display).toContain("collect_logs is on");
    expect(steps[0]!.display).toContain("cache_ttl is 300");
    const unrecorded = complete();
    unrecorded.resources = { ...unrecorded.resources, ai_gateway_created: false };
    expect(preflight(unrecorded, completeEnv()).map((m) => m.item)).toEqual(["conflict: AI Gateway peoplevault exists but this repo has no record of creating it"]);
  });

  it("Workers Free: no plan creates Basin Pipelines resources or checks a Workers Paid plan", () => {
    for (const [s, env] of [[empty(), {}], [partial(), { ...ENV_FULL }], [complete(), completeEnv()]] as const) {
      const text = plan(s, env);
      expect(text).not.toMatch(/basin pipelines|Workers Paid|subscriptions|--catalog-token/);
      expect(text).not.toContain(SECRETS.PV_R2_CATALOG_TOKEN);
    }
    const s = complete();
    s.resources = { ...s.resources, kv_id: undefined };
    expect(desiredRender(s, completeEnv())).toBeNull();
  });

  it("finds the repository from PV_GITHUB_REPO or the origin remote", () => {
    expect(githubRepo({}, "https://github.com/nitishsjsucs/peoplevault.git\n")).toBe(REPO);
    expect(githubRepo({}, "git@github.com:nitishsjsucs/peoplevault.git")).toBe(REPO);
    expect(githubRepo({ PV_GITHUB_REPO: "someone/fork" }, "https://github.com/nitishsjsucs/peoplevault.git")).toBe("someone/fork");
    expect(githubRepo({ PV_GITHUB_REPO: "not a repo" }, "")).toBeNull();
    expect(githubRepo({}, "https://gitlab.com/x/y.git")).toBeNull();
  });

  it("renders the production config with every placeholder filled and ACCESS_AUD pending until the Access app exists", () => {
    const s = complete();
    s.accessApp = null;
    const text = desiredRender(s, completeEnv())!;
    expect(text).not.toMatch(/__[A-Z0-9_]+__/);
    expect(text).toContain(`"ACCESS_AUD": "${AUD_PENDING}"`);
    expect(text).toContain('"database_id": "11111111-2222-3333-4444-555555555555"');
    expect(text).toContain("peoplevault-gateway@peoplevault-test.iam.gserviceaccount.com");
    expect(text).not.toContain('"pipelines"');
    expect(text).not.toContain('"limits"');
    expect(text).toMatch(/"invocation_logs": false/);
  });

  it("renders RETENTION_CRON off until --retention-cron on is recorded, and re-renders (and redeploys) when it changes", () => {
    const s = complete();
    const off = desiredRender(s, completeEnv())!;
    expect(off).toContain('"RETENTION_CRON": "off"');
    s.renderedText = off;
    expect(planSetup(s, completeEnv(), off).map((x) => x.id)).not.toContain("worker:render");
    s.resources = { ...s.resources, retention_cron: "on" };
    const on = desiredRender(s, completeEnv())!;
    expect(on).toContain('"RETENTION_CRON": "on"');
    const ids = planSetup(s, completeEnv(), on).map((x) => x.id);
    expect(ids).toContain("worker:render");
    expect(ids).toContain("worker:deploy");
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
