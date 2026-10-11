// Doctor checks (SPEC.md section 22.1): one line per check, [ok], [warn] or [missing], and for every non-ok line the
// exact command or console path that fixes it. Every dependency (commands, environment, files, HTTP, ports) is injected
// so tests drive each check with a fake runner and recorded API responses.
import { CfApi, isWorkersPaid } from "./cf-api.ts";
import { EXECUTOR_WORKFLOW, GITHUB_SECRETS, MAX_RUN_AGE_HOURS, readGithubState, type GithubState } from "./github.ts";
import type { RunResult } from "./run.ts";

export type Status = "ok" | "warn" | "missing";
export interface CheckResult {
  group: string;
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  run(cmd: string, args: string[]): Promise<RunResult>;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  exists(path: string): boolean;
  readFile(path: string): string;
  portOpen(port: number): Promise<boolean>;
  nodeVersion: string;
  wrangler: string;
  /** clock for the executor workflow's freshness check (defaults to Date.now) */
  now?: () => number;
}

export const REQUIRED_SECRETS = ["DEV_ACCESS_JWKS", "DEV_ACCESS_PRIVATE_JWK", "PV_PSEUDONYM_MASTER_KEY", "WAREHOUSE_SHIM_TOKEN", "GCP_GATEWAY_SA_KEY"];
export const PROD_CONFIG = "infra/cloudflare/wrangler.production.jsonc";
export const PERSONA_TOKENS = ["pv-executor", "pv-persona-hr", "pv-persona-manager", "pv-persona-analyst", "pv-persona-privacy"];
export const PERSONA_PRINCIPAL: Record<string, string> = { "pv-persona-hr": "hr_partner", "pv-persona-manager": "manager", "pv-persona-analyst": "people_analyst", "pv-persona-privacy": "privacy_officer" };
export const PERSONA_ENV: Record<string, string> = { "pv-executor": "EXECUTOR", "pv-persona-hr": "HR", "pv-persona-manager": "MANAGER", "pv-persona-analyst": "ANALYST", "pv-persona-privacy": "PRIVACY" };

const ok = (group: string, name: string, detail: string): CheckResult => ({ group, name, status: "ok", detail });
const warn = (group: string, name: string, detail: string, fix: string): CheckResult => ({ group, name, status: "warn", detail, fix });
const missing = (group: string, name: string, detail: string, fix: string): CheckResult => ({ group, name, status: "missing", detail, fix });

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function jsonFrom(text: string): unknown {
  const i = text.search(/[[{]/);
  return JSON.parse(i >= 0 ? text.slice(i) : "null");
}

// ---- local --------------------------------------------------------------------------------------------------------
export async function localChecks(d: DoctorDeps): Promise<CheckResult[]> {
  const G = "Local toolchain";
  const out: CheckResult[] = [];
  const major = Number(d.nodeVersion.replace(/^v/, "").split(".")[0]);
  if (major === 24 || major === 26) out.push(ok(G, "node", d.nodeVersion));
  else if (major === 25) out.push(warn(G, "node", `${d.nodeVersion} (Node 25 reached end of life on 2026-06-01; CI uses 24)`, "nvm install 24 && nvm use 24"));
  else out.push(missing(G, "node", `${d.nodeVersion} (need 24, 25 or 26)`, "nvm install 24 && nvm use 24"));
  const pkg = JSON.parse(d.readFile("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const wrong = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name, version]) => {
    const p = `node_modules/${name}/package.json`;
    return !d.exists(p) || (JSON.parse(d.readFile(p)) as { version: string }).version !== version;
  });
  out.push(wrong.length ? missing(G, "node_modules", `${wrong.length} package(s) differ from package.json`, "npm ci") : ok(G, "node_modules", "match package.json pins"));
  const uv = await d.run("uv", ["--version"]);
  if (uv.code !== 0) out.push(missing(G, "uv", "not found", "brew install uv"));
  else {
    out.push(ok(G, "uv", uv.stdout.trim()));
    const lock = await d.run("uv", ["sync", "--project", "pipelines", "--locked", "--check"]);
    out.push(lock.code === 0 ? ok(G, "python environment", "in sync with uv.lock") : missing(G, "python environment", "out of sync with uv.lock", "uv sync --project pipelines --locked"));
    const py = await d.run("uv", ["python", "find", "3.12"]);
    out.push(py.code === 0 ? ok(G, "python 3.12", py.stdout.trim()) : missing(G, "python 3.12", "not available to uv", "uv python install 3.12"));
  }
  const L = "Local data";
  if (!d.exists(".dev.vars")) out.push(missing(L, ".dev.vars", "missing", "npm run dev:keys"));
  else {
    const names = Object.keys(parseEnv(d.readFile(".dev.vars")));
    const same = names.length === REQUIRED_SECRETS.length && REQUIRED_SECRETS.every((n) => names.includes(n));
    out.push(same ? ok(L, ".dev.vars", "exactly the secrets.required names") : missing(L, ".dev.vars", "names differ from wrangler.jsonc secrets.required", "npm run dev:keys -- --force"));
  }
  const busy: string[] = [];
  for (const [name, port] of [["wrangler dev", 8793], ["inspector", 9243], ["shim", 8893]] as const) if (await d.portOpen(port)) busy.push(`${name} ${port}`);
  out.push(busy.length ? warn(L, "ports", `in use: ${busy.join(", ")}`, "npm run stop:local") : ok(L, "ports", "8793, 9243 and 8893 are free"));
  const d1 = await d.run(d.wrangler, ["d1", "execute", "pv-control", "--local", "--json", "--command", "SELECT COUNT(*) AS n FROM identity_map"]);
  let n = -1;
  try {
    n = (jsonFrom(d1.stdout) as { results: { n: number }[] }[])[0]?.results[0]?.n ?? -1;
  } catch {
    n = -1;
  }
  const seeded = d1.code === 0 && n === 1200 && d.exists("pipelines/.data/warehouse.duckdb") && d.exists("pipelines/.data/lake/catalog.db");
  out.push(seeded ? ok(L, "local seed", "D1 1,200 identity rows, DuckDB file, lake catalog") : missing(L, "local seed", "not seeded or incomplete", "npm run seed:local -- --fresh"));
  return out;
}

// ---- production ---------------------------------------------------------------------------------------------------
export async function prodChecks(d: DoctorDeps): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const env = { ...(d.exists(".secrets/prod.env") ? parseEnv(d.readFile(".secrets/prod.env")) : {}), ...d.env };
  const A = "Cloudflare account";
  const who = await d.run(d.wrangler, ["whoami", "--json"]);
  let loggedIn = false;
  let accounts: { id: string; name: string }[] = [];
  try {
    const w = jsonFrom(who.stdout) as { loggedIn: boolean; accounts?: { id: string; name: string }[] };
    loggedIn = w.loggedIn === true;
    accounts = w.accounts ?? [];
  } catch {
    loggedIn = false;
  }
  out.push(loggedIn ? ok(A, "wrangler login", "logged in") : missing(A, "wrangler login", "not logged in", "npx wrangler login"));
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? (accounts.length === 1 ? accounts[0]!.id : undefined);
  out.push(accountId ? ok(A, "account id", "set") : missing(A, "account id", "CLOUDFLARE_ACCOUNT_ID not set and not exactly one account", "add CLOUDFLARE_ACCOUNT_ID=<id> to .secrets/prod.env"));
  const tokenFix = "create PV_CF_API_TOKEN (docs/PRODUCTION.md, Accounts step 7) and add it to .secrets/prod.env";
  let subdomain: string | null = null;
  if (!env.PV_CF_API_TOKEN || !accountId) out.push(missing(A, "PV_CF_API_TOKEN", "not set", tokenFix));
  else {
    const api = new CfApi(accountId, env.PV_CF_API_TOKEN, d.fetchImpl);
    const failed: string[] = [];
    let org: { auth_domain: string } | null = null;
    let subs: Awaited<ReturnType<CfApi["subscriptions"]>> = [];
    let apps: Awaited<ReturnType<CfApi["accessApps"]>> = [];
    let tokens: Awaited<ReturnType<CfApi["serviceTokens"]>> = [];
    try {
      apps = await api.accessApps();
    } catch {
      failed.push("Access apps");
    }
    try {
      tokens = await api.serviceTokens();
    } catch {
      failed.push("service tokens");
    }
    try {
      org = await api.organization();
    } catch {
      failed.push("organizations");
    }
    try {
      subdomain = await api.workersSubdomain();
    } catch {
      failed.push("workers subdomain");
    }
    try {
      subs = await api.subscriptions();
    } catch {
      failed.push("subscriptions (Billing Read)");
    }
    out.push(failed.length ? missing(A, "PV_CF_API_TOKEN scopes", `no access to: ${failed.join(", ")}`, tokenFix) : ok(A, "PV_CF_API_TOKEN scopes", "Access, Workers subdomain and subscriptions readable"));
    out.push(org?.auth_domain ? ok(A, "Zero Trust organization", org.auth_domain) : missing(A, "Zero Trust organization", "none", "Zero Trust onboarding in the dashboard (docs/PRODUCTION.md step 5)"));
    out.push(
      isWorkersPaid(subs)
        ? ok(A, "Workers Paid", "subscription found")
        : warn(A, "Workers Paid", `no subscription matched Workers Paid (plans: ${subs.map((s) => s.rate_plan?.public_name).join(", ") || "none"})`, "upgrade to Workers Paid (docs/PRODUCTION.md step 2)"),
    );
    out.push(
      subdomain
        ? ok(A, "workers.dev subdomain", `${subdomain}.workers.dev`)
        : missing(A, "workers.dev subdomain", "none registered (Workflows cannot deploy without one)", `https://dash.cloudflare.com/${accountId}/workers/onboarding, or set PV_WORKERS_SUBDOMAIN in .secrets/prod.env and run npm run setup:prod`),
    );
    const X = "Access";
    const app = apps.find((a) => a.name === "PeopleVault");
    out.push(app ? ok(X, "Access application", `PeopleVault (${app.destinations?.map((x) => x.type).join(", ") ?? "no destinations"})`) : missing(X, "Access application", "PeopleVault not found", "npm run setup:prod"));
    const have = new Set(tokens.map((t) => t.name));
    const absent = PERSONA_TOKENS.filter((t) => !have.has(t));
    out.push(absent.length ? missing(X, "service tokens", `missing: ${absent.join(", ")}`, "npm run setup:prod") : ok(X, "service tokens", "5 of 5"));
  }
  const R = "Cloudflare resources";
  if (loggedIn && accountId) {
    const tok = await d.run(d.wrangler, ["auth", "token", "--json"]);
    let oauth = "";
    try {
      oauth = (jsonFrom(tok.stdout) as { token: string }).token;
    } catch {
      oauth = "";
    }
    if (!oauth) out.push(missing(R, "wrangler OAuth token", "unavailable", "npx wrangler login"));
    else {
      const api = new CfApi(accountId, oauth, d.fetchImpl);
      const buckets = new Set((await api.r2Buckets().catch(() => ({ buckets: [] }))).buckets.map((b) => b.name));
      const needB = ["pv-source-exports", "pv-derived", "pv-lake"].filter((b) => !buckets.has(b));
      out.push(needB.length ? missing(R, "R2 buckets", `missing: ${needB.join(", ")}`, "npm run setup:prod") : ok(R, "R2 buckets", "3 of 3"));
      const kv = (await api.kvNamespaces().catch(() => [])).some((n) => n.title === "pv-cache" || n.title.endsWith("pv-cache"));
      out.push(kv ? ok(R, "KV namespace", "pv-cache") : missing(R, "KV namespace", "pv-cache missing", "npm run setup:prod"));
      const qs = new Set((await api.queues().catch(() => [])).map((q) => q.queue_name));
      const needQ = ["pv-retention-sweep", "pv-retention-dlq"].filter((q) => !qs.has(q));
      out.push(needQ.length ? missing(R, "Queues", `missing: ${needQ.join(", ")}`, "npm run setup:prod") : ok(R, "Queues", "2 of 2"));
      const cat = await api.catalog("pv-lake").catch(() => null);
      out.push(cat && /active|enabled/i.test(cat.status ?? "") ? ok(R, "Basin Catalog", "enabled on pv-lake") : missing(R, "Basin Catalog", "not enabled on pv-lake (or status unreadable)", "npx wrangler basin catalog enable pv-lake"));
    }
    const d1 = await d.run(d.wrangler, ["d1", "list", "--json"]);
    let hasD1 = false;
    try {
      hasD1 = (jsonFrom(d1.stdout) as { name: string }[]).some((x) => x.name === "pv-control");
    } catch {
      hasD1 = false;
    }
    out.push(hasD1 ? ok(R, "D1", "pv-control") : missing(R, "D1", "pv-control missing", "npm run setup:prod"));
    for (const [label, kind, name] of [["audit stream", ["streams"], "pv_audit_events"], ["audit sink", ["sinks"], "pv_audit_sink"], ["audit pipeline", [], "pv_audit_pipeline"]] as const) {
      const res = await d.run(d.wrangler, ["basin", "pipelines", ...kind, "list", "--json", "--per-page", "100"]);
      let names: string[] = [];
      try {
        names = (jsonFrom(res.stdout) as { name: string }[]).map((x) => x.name);
      } catch {
        names = [];
      }
      out.push(names.includes(name) ? ok(R, label, name) : missing(R, label, `${name} missing (Basin Pipelines copy of the audit log)`, "npm run setup:prod -- --only cloudflare"));
    }
  }
  out.push(env.PV_R2_CATALOG_TOKEN ? ok(R, "PV_R2_CATALOG_TOKEN", "set (checked by the Google Cloud group's lake check)") : missing(R, "PV_R2_CATALOG_TOKEN", "not set", "create an R2 API token (docs/PRODUCTION.md step 8) and add it to .secrets/prod.env"));
  const W = "Worker";
  if (!d.exists(PROD_CONFIG)) out.push(missing(W, "production config", `${PROD_CONFIG} not rendered`, "npm run setup:prod"));
  else {
    const text = d.readFile(PROD_CONFIG);
    const placeholders = text.match(/__[A-Z0-9_]+__/g) ?? [];
    const logsOff = /"invocation_logs"\s*:\s*false/.test(text);
    if (placeholders.length) out.push(missing(W, "production config", `placeholders left: ${[...new Set(placeholders)].join(", ")}`, "npm run setup:prod"));
    else if (!logsOff) out.push(missing(W, "production config", "invocation_logs is not false", "restore observability.logs.invocation_logs = false"));
    else out.push(ok(W, "production config", "rendered, no placeholders, invocation logs off"));
    const sec = await d.run(d.wrangler, ["secret", "list", "-c", PROD_CONFIG, "--format", "json"]);
    let names: string[] = [];
    try {
      names = (jsonFrom(sec.stdout) as { name: string }[]).map((s) => s.name);
    } catch {
      names = [];
    }
    const needS = ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"].filter((s) => !names.includes(s));
    out.push(needS.length ? missing(W, "Worker secrets", `missing: ${needS.join(", ")}`, "npm run deploy") : ok(W, "Worker secrets", "2 of 2"));
  }
  const V = "Live checks";
  if (subdomain) {
    const url = `https://peoplevault.${subdomain}.workers.dev/api/v1/me`;
    try {
      const res = await d.fetchImpl(url, { redirect: "manual" });
      const loc = res.headers.get("location") ?? "";
      const byAccess = (res.status >= 300 && res.status < 400 && loc.includes("cloudflareaccess.com")) || (res.status === 403 && !(res.headers.get("content-type") ?? "").includes("application/json"));
      out.push(byAccess ? ok(V, "edge protection", "unauthenticated request answered by Access") : missing(V, "edge protection", `answered by the Worker or something else (HTTP ${res.status})`, "protect the Worker with the Access application (docs/PRODUCTION.md, Access)"));
    } catch {
      out.push(missing(V, "edge protection", "Worker unreachable", "npm run deploy"));
    }
    for (const [token, persona] of Object.entries(PERSONA_PRINCIPAL)) {
      const id = env[`PV_CF_ACCESS_CLIENT_ID_${PERSONA_ENV[token]}`];
      const secret = env[`PV_CF_ACCESS_CLIENT_SECRET_${PERSONA_ENV[token]}`];
      if (!id || !secret) {
        out.push(missing(V, `persona ${persona}`, "service token not recorded", "npm run setup:prod"));
        continue;
      }
      try {
        const res = await d.fetchImpl(url, { headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } });
        const body = (await res.json().catch(() => ({}))) as { persona?: string };
        out.push(body.persona === persona ? ok(V, `persona ${persona}`, "round trip through Access") : missing(V, `persona ${persona}`, `HTTP ${res.status}`, "npm run seed:prod"));
      } catch {
        out.push(missing(V, `persona ${persona}`, "request failed", "npm run deploy"));
      }
    }
  }
  const P = "Google Cloud";
  const gcp = await d.run("uv", ["run", "--project", "pipelines", "pv", "doctor", "gcp", "--json"]);
  try {
    out.push(...(jsonFrom(gcp.stdout) as CheckResult[]));
  } catch {
    out.push(missing(P, "pv doctor gcp", "could not run the Google Cloud checks", "uv sync --project pipelines --locked"));
  }
  out.push(...githubChecks(await readGithubState(d.run, env), (d.now ?? Date.now)()));
  return out;
}

/** The scheduled production executor (P1 executor.yml): logged in, secrets and variable set, schedule alive. */
export function githubChecks(gh: GithubState, nowMs: number): CheckResult[] {
  const H = "GitHub";
  const setup = "npm run setup:prod -- --only github";
  if (!gh.authed) return [missing(H, "gh login", "gh is not logged in", "gh auth login")];
  if (!gh.repo) return [missing(H, "repository", "no GitHub repository (origin remote or PV_GITHUB_REPO)", "set PV_GITHUB_REPO=<owner>/<name> in .secrets/prod.env")];
  const out: CheckResult[] = [ok(H, "gh login", `repository ${gh.repo}`)];
  const absent = GITHUB_SECRETS.filter((n) => !gh.secrets.includes(n));
  out.push(absent.length ? missing(H, "executor secrets", `missing: ${absent.join(", ")}`, setup) : ok(H, "executor secrets", `${GITHUB_SECRETS.length} of ${GITHUB_SECRETS.length}`));
  out.push(gh.variables.PV_PROD_ENABLED === "true" ? ok(H, "PV_PROD_ENABLED", "true") : missing(H, "PV_PROD_ENABLED", "not true: executor.yml is skipped", setup));
  if (!gh.workflowState) {
    out.push(missing(H, "executor workflow", `${EXECUTOR_WORKFLOW} not found on GitHub (repository not pushed yet)`, "git push origin main"));
    return out;
  }
  if (gh.workflowState !== "active") {
    out.push(missing(H, "executor workflow", `state ${gh.workflowState} (public repositories lose scheduled workflows after 60 days without activity)`, `gh workflow enable ${EXECUTOR_WORKFLOW} --repo ${gh.repo}`));
    return out;
  }
  out.push(ok(H, "executor workflow", "active"));
  if (!gh.lastSuccess) out.push(warn(H, "executor last success", "no successful run yet", `gh workflow run ${EXECUTOR_WORKFLOW} --repo ${gh.repo}`));
  else {
    const hours = (nowMs - Date.parse(gh.lastSuccess)) / 3_600_000;
    out.push(
      hours <= MAX_RUN_AGE_HOURS
        ? ok(H, "executor last success", `${hours.toFixed(1)} h ago`)
        : missing(H, "executor last success", `${hours.toFixed(1)} h ago (expected hourly; deletions fail after 24 h without the executor)`, `gh run list --workflow ${EXECUTOR_WORKFLOW} --repo ${gh.repo}`),
    );
  }
  return out;
}

export function render(results: CheckResult[]): string {
  const groups = [...new Set(results.map((r) => r.group))];
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(g);
    for (const r of results.filter((x) => x.group === g)) {
      lines.push(`  [${r.status}] ${r.name}: ${r.detail}`);
      if (r.status !== "ok" && r.fix) lines.push(`      fix: ${r.fix}`);
    }
  }
  return lines.join("\n");
}

export const exitCode = (results: CheckResult[]) => (results.some((r) => r.status === "missing") ? 1 : 0);
