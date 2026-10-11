// Doctor checks (SPEC.md section 22.1): one line per check, [ok], [warn] or [missing], and for every non-ok line the
// exact command or console path that fixes it. Every dependency (commands, environment, files, HTTP, ports) is injected
// so tests drive each check with a fake runner and recorded API responses.
import { AI_GATEWAY_ID, gatewayDrift } from "./ai-gateway.ts";
import { CfApi, CfApiError } from "./cf-api.ts";
import { nameConflicts, type AccountResources } from "./conflicts.ts";
import { FACTS, PER_INVOCATION, SHARE, projectedD1RowsRead } from "./free-budget.ts";
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
  // P1 schema-drift triage: only the local eval needs these (the Worker's default AI_MODE is the stub)
  const llama = await d.run("llama-server", ["--version"]);
  const llamaVersion = `${llama.stdout}\n${llama.stderr}`.match(/version: [^\n]+/)?.[0];
  out.push(llama.code === 0 ? ok(G, "llama-server", llamaVersion ?? "found") : warn(G, "llama-server", "not found (needed only for the local schema-drift eval)", "brew install llama.cpp"));
  const model = d.env.PV_LLM_MODEL ?? `${d.env.HOME ?? "~"}/Developer/projects/_models/Qwen3-1.7B-Q4_0-rtn.gguf`;
  out.push(d.exists(model) ? ok(G, "Qwen3 model file", model) : warn(G, "Qwen3 model file", `${model} not found (needed only for the local schema-drift eval)`, "set PV_LLM_MODEL to the Qwen3-1.7B Q4_0 GGUF file"));
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
    out.push(failed.length ? missing(A, "PV_CF_API_TOKEN scopes", `no access to: ${failed.join(", ")}`, tokenFix) : ok(A, "PV_CF_API_TOKEN scopes", "Access and the Workers subdomain readable"));
    out.push(org?.auth_domain ? ok(A, "Zero Trust organization", org.auth_domain) : missing(A, "Zero Trust organization", "none", "Zero Trust onboarding in the dashboard (docs/PRODUCTION.md step 5)"));
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
    // the AI Gateway, only when the production template binds Workers AI (SPEC.md section 16.3)
    if (d.exists(TEMPLATE_PATH) && /"ai"\s*:\s*\{\s*"binding"/.test(d.readFile(TEMPLATE_PATH))) out.push(await aiGatewayCheck(api));
  }
  const R = "Cloudflare resources";
  const seen: AccountResources = { buckets: [], d1: [], kv: [], queues: [], workerId: null };
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
      seen.buckets = [...buckets];
      const needB = ["pv-source-exports", "pv-derived", "pv-lake"].filter((b) => !buckets.has(b));
      out.push(needB.length ? missing(R, "R2 buckets", `missing: ${needB.join(", ")}`, "npm run setup:prod") : ok(R, "R2 buckets", "3 of 3"));
      seen.kv = await api.kvNamespaces().catch(() => []);
      const kv = seen.kv.some((n) => n.title === "pv-cache" || n.title.endsWith("pv-cache"));
      out.push(kv ? ok(R, "KV namespace", "pv-cache") : missing(R, "KV namespace", "pv-cache missing", "npm run setup:prod"));
      const qs = new Set((await api.queues().catch(() => [])).map((q) => q.queue_name));
      seen.queues = [...qs];
      const needQ = ["pv-retention-sweep", "pv-retention-dlq"].filter((q) => !qs.has(q));
      out.push(needQ.length ? missing(R, "Queues", `missing: ${needQ.join(", ")}`, "npm run setup:prod") : ok(R, "Queues", "2 of 2"));
      const cat = await api.catalog("pv-lake").catch(() => null);
      out.push(cat && /active|enabled/i.test(cat.status ?? "") ? ok(R, "Basin Catalog", "enabled on pv-lake") : missing(R, "Basin Catalog", "not enabled on pv-lake (or status unreadable)", "npx wrangler basin catalog enable pv-lake"));
    }
    const d1 = await d.run(d.wrangler, ["d1", "list", "--json"]);
    let hasD1 = false;
    try {
      seen.d1 = jsonFrom(d1.stdout) as { name: string; uuid: string }[];
      hasD1 = seen.d1.some((x) => x.name === "pv-control");
    } catch {
      hasD1 = false;
    }
    out.push(hasD1 ? ok(R, "D1", "pv-control") : missing(R, "D1", "pv-control missing", "npm run setup:prod"));
    // shared account (SPEC.md section 30.3.9): a resource with one of this repo's names that setup did not record
    const recorded = d.exists(".secrets/prod-resources.json") ? (JSON.parse(d.readFile(".secrets/prod-resources.json")) as Record<string, never>) : {};
    const conflicts = nameConflicts(seen, recorded);
    out.push(conflicts.length ? missing(R, "name conflicts", conflicts.map((c) => c.item).join("; "), conflicts[0]!.fix) : ok(R, "name conflicts", "every resource with this repo's names is recorded as this repo's"));
  }
  out.push(env.PV_R2_CATALOG_TOKEN ? ok(R, "PV_R2_CATALOG_TOKEN", "set (checked by the Google Cloud group's lake check)") : missing(R, "PV_R2_CATALOG_TOKEN", "not set", "create an R2 API token (docs/PRODUCTION.md step 8) and add it to .secrets/prod.env"));
  if (env.PV_R2_CATALOG_TOKEN && env.PV_BASE_URL) out.push(auditCopyCheck(await d.run("uv", ["run", "--project", "pipelines", "pv", "audit", "status", "--target", "prod", "--json"])));
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
    if (!placeholders.length && loggedIn) out.push(...(await freePlanUsage(d, text, env, accountId ?? null)));
  }
  const V = "Live checks";
  if (subdomain) {
    const origin = `https://peoplevault.${subdomain}.workers.dev`;
    const url = `${origin}/api/v1/me`;
    // the API and the privacy console (static assets, served without invoking the Worker) must both sit behind Access
    for (const [name, target] of [
      ["edge protection", url],
      ["console protection", `${origin}/`],
    ] as const) {
      try {
        const res = await d.fetchImpl(target, { redirect: "manual" });
        const loc = res.headers.get("location") ?? "";
        const byAccess = (res.status >= 300 && res.status < 400 && loc.includes("cloudflareaccess.com")) || (res.status === 403 && !(res.headers.get("content-type") ?? "").includes("application/json"));
        out.push(byAccess ? ok(V, name, "unauthenticated request answered by Access") : missing(V, name, `answered by the Worker or something else (HTTP ${res.status})`, "protect the Worker with the Access application (docs/PRODUCTION.md, Access)"));
      } catch {
        out.push(missing(V, name, "Worker unreachable", "npm run deploy"));
      }
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

const TEMPLATE_PATH = "infra/cloudflare/wrangler.production.template.jsonc";

/** The AI Gateway `peoplevault` exists with no stored logs, no cache and its rate limit (SPEC.md section 30.3.6). */
export async function aiGatewayCheck(api: CfApi): Promise<CheckResult> {
  const G = "Workers AI";
  try {
    const g = await api.aiGateway(AI_GATEWAY_ID);
    if (!g) return missing(G, "AI Gateway", `${AI_GATEWAY_ID} not found`, "npm run setup:prod -- --only cloudflare");
    const drift = gatewayDrift(g);
    return drift.length ? missing(G, "AI Gateway", drift.join("; "), "npm run setup:prod -- --only cloudflare") : ok(G, "AI Gateway", `${AI_GATEWAY_ID}: no stored logs, no cache, 10 requests per 60 s`);
  } catch (e) {
    const scope = e instanceof CfApiError && e.status === 403;
    return missing(G, "AI Gateway", scope ? "PV_CF_API_TOKEN cannot read AI Gateway" : "could not read the gateway", scope ? "add AI Gateway Edit to PV_CF_API_TOKEN (docs/PRODUCTION.md step 7)" : "npm run doctor -- --prod again later");
  }
}

/** A var of the rendered production config ("" when absent). */
export function configVar(text: string, name: string): string {
  return new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(text)?.[1] ?? "";
}

/**
 * Workers Free usage (SPEC.md sections 22.1 and 30.4), read-only: the retention cron switch, today's admissions
 * against DAILY_DELETION_STARTS, the D1 rows one deletion's three probes read projected at the cap against this
 * repo's 25% share of 5M rows a day, and (optional) the Worker's CPU p99 from Workers analytics.
 */
export async function freePlanUsage(d: DoctorDeps, config: string, env: Record<string, string | undefined>, accountId: string | null, now = new Date()): Promise<CheckResult[]> {
  const G = "Free plan usage";
  const out: CheckResult[] = [];
  const cron = configVar(config, "RETENTION_CRON");
  out.push(
    cron === "on"
      ? ok(G, "retention cron", "on")
      : warn(G, "retention cron", "off: the daily cron only re-admits deferred and orphaned requests (turn it on after the production eval result is committed)", "npm run setup:prod -- --only worker --retention-cron on"),
  );
  const cap = Number(configVar(config, "DAILY_DELETION_STARTS")) || null;
  const d1 = async (sql: string) => jsonFrom((await d.run(d.wrangler, ["d1", "execute", "pv-control", "--remote", "-c", PROD_CONFIG, "--json", "--command", sql])).stdout) as { results: Record<string, unknown>[] }[];
  try {
    const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const n = Number((await d1(`SELECT COUNT(*) AS n FROM deletion_requests WHERE admitted_at >= '${day}'`))[0]!.results[0]!.n);
    const detail = `${n} of ${cap ?? "unlimited"} deletion starts admitted today (UTC)`;
    out.push(cap !== null && n >= cap ? warn(G, "admissions today", `${detail}: further requests wait for tomorrow's cron`, "wait for 03:00 UTC, or check what started them") : ok(G, "admissions today", detail));
  } catch {
    out.push(warn(G, "admissions today", "could not read deletion_requests", "npm run setup:prod"));
  }
  try {
    const tables = (await d1("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'd1_migrations'"))[0]!.results.map((r) => String(r.name)).filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
    const rows = tables.length ? Number((await d1(`SELECT ${tables.map((t) => `(SELECT COUNT(*) FROM ${t})`).join(" + ")} AS n`))[0]!.results[0]!.n) : 0;
    const projected = projectedD1RowsRead(rows, cap ?? 16);
    const share = FACTS.F12.value[0] * SHARE;
    const detail = `${rows} rows in the probed tables; ${projected} D1 rows read projected on a capped day (share ${share})`;
    out.push(projected <= share ? ok(G, "D1 rows per probe", detail) : warn(G, "D1 rows per probe", detail, "archive old audit events and results, or lower DAILY_DELETION_STARTS"));
  } catch {
    out.push(warn(G, "D1 rows per probe", "could not count the probed tables", "npm run setup:prod"));
  }
  const aiCap = Number(configVar(config, "AI_DAILY_NEURONS")) || null;
  if (aiCap !== null) {
    try {
      const r = (await d1(`SELECT COALESCE(SUM(neurons), 0) AS n, COALESCE(SUM(calls), 0) AS c FROM ai_usage WHERE day = '${now.toISOString().slice(0, 10)}'`))[0]!.results[0]!;
      const n = Math.round(Number(r.n) * 100) / 100;
      const detail = `${n} of ${aiCap} neurons used today (UTC) in ${Number(r.c)} call(s)`;
      out.push(n + 25.83 > aiCap ? warn(G, "Workers AI neurons today", `${detail}: triage falls back to the rule class until 00:00 UTC`, "wait for the next UTC day") : ok(G, "Workers AI neurons today", detail));
    } catch {
      out.push(warn(G, "Workers AI neurons today", "could not read ai_usage", "npx wrangler d1 migrations apply pv-control --remote -c infra/cloudflare/wrangler.production.jsonc"));
    }
  }
  out.push(await cpuP99(d, env, accountId, now));
  return out;
}

/** Optional: CPU p99 per invocation of the Worker over the last 24 hours (Workers analytics GraphQL; the dataset and
 * field names are unverified until the first production read; the token needs Account Analytics Read). */
async function cpuP99(d: DoctorDeps, env: Record<string, string | undefined>, accountId: string | null, now: Date): Promise<CheckResult> {
  const G = "Free plan usage";
  const skipped = ok(G, "CPU p99", "not checked (optional: needs Account Analytics Read on PV_CF_API_TOKEN)");
  if (!env.PV_CF_API_TOKEN || !accountId) return skipped;
  const query = `query($a: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $a }) { workersInvocationsAdaptive(limit: 1, filter: { scriptName: "peoplevault", datetime_geq: $since, datetime_leq: $until }) { quantiles { cpuTimeP99 } } } } }`;
  try {
    const res = await d.fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${env.PV_CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { a: accountId, since: new Date(now.getTime() - 86_400_000).toISOString(), until: now.toISOString() } }),
    });
    const body = (await res.json()) as { data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: { quantiles?: { cpuTimeP99?: number } }[] }[] } } };
    const us = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.quantiles?.cpuTimeP99;
    if (!res.ok || typeof us !== "number") return skipped;
    const ms = us / 1000;
    const detail = `${ms.toFixed(2)} ms over the last 24 hours (limit ${FACTS.F2.value} ms, target ${PER_INVOCATION.cpuTargetMs} ms)`;
    return ms <= PER_INVOCATION.cpuTargetMs ? ok(G, "CPU p99", detail) : warn(G, "CPU p99", detail, "lower R2_ERASE_STEP_BYTES and R2_PROBE_STEP_BYTES in the production template, then npm run setup:prod -- --only worker");
  } catch {
    return skipped;
  }
}

/** The audit copy in the Basin Catalog (SPEC.md section 30.3.3): lag and the age of the last export commit. */
export function auditCopyCheck(res: RunResult): CheckResult {
  const G = "Cloudflare resources";
  const fix = "uv run --project pipelines pv audit export --target prod";
  let s: { exists: boolean; lag: number; last_commit_age_hours: number | null; last_hash_matches: boolean };
  try {
    s = jsonFrom(res.stdout) as typeof s;
  } catch {
    return missing(G, "audit copy", "could not read governance.audit_events (catalog or Worker unreachable)", fix);
  }
  if (res.code !== 0 || !s || typeof s.exists !== "boolean") return missing(G, "audit copy", "could not read governance.audit_events", fix);
  if (!s.exists) return missing(G, "audit copy", `governance.audit_events not created yet (${s.lag} events waiting)`, fix);
  if (!s.last_hash_matches) return missing(G, "audit copy", "the copy's last hash differs from D1's at that seq", `${fix} --rebuild`);
  const age = s.last_commit_age_hours;
  const detail = `lag ${s.lag} events, last commit ${age === null ? "never" : `${age.toFixed(1)} h ago`}`;
  return age !== null && age > 26 ? warn(G, "audit copy", `${detail} (more than 26 hours)`, fix) : ok(G, "audit copy", detail);
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
