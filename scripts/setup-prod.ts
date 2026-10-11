// npm run setup:prod [-- --dry-run] [--only cloudflare|gcp|worker|access|data|github] (SPEC.md section 22.2).
// Idempotent: every group reads the current state, plans only what is missing and runs it; ids go to
// .secrets/prod-resources.json and secrets only to .secrets/ (mode 600). Secret values are never printed: plans show
// names, and `--dry-run` prints the exact commands with secret arguments as ***. planSetup() and preflight() are pure
// and golden-tested (test/node/setup-prod.dryrun.test.ts). Status: written, not yet executed against Cloudflare.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { CfApi } from "./lib/cf-api.ts";
import { PERSONA_ENV, PERSONA_TOKENS } from "./lib/checks.ts";
import { EXECUTOR_KEY_SECRET, EXECUTOR_WORKFLOW, GITHUB_SECRET_SOURCES, readGithubState, sha256, type GithubState } from "./lib/github.ts";
import {
  ACCESS_TEMPLATE,
  AUD_PENDING,
  PROD_ENV,
  RENDERED,
  RENDERED_REL,
  TEMPLATE,
  WORKER_SECRETS,
  prodEnv,
  readEnvFile,
  readResources,
  renderConfig,
  upsertEnvFile,
  writeResources,
  type ProdResources,
} from "./lib/prod-files.ts";
import { REPO_ROOT, parseJsonOutput, pv, run, wrangler, wranglerBin, type RunResult } from "./lib/run.ts";

export const GROUPS = ["cloudflare", "gcp", "worker", "access", "data", "github"] as const;
export type Group = (typeof GROUPS)[number];
export const BUCKETS = ["pv-source-exports", "pv-derived", "pv-lake"];
export const QUEUES = ["pv-retention-sweep", "pv-retention-dlq"];
// Workers Free (SPEC.md section 30, ADR 0007): no Basin Pipelines resources (Workers Paid only; this account returned
// code 1021). The audit copy governance.audit_events is pulled by `pv audit export`.

export interface SetupState {
  accountId: string | null;
  loggedIn: boolean;
  teamDomain: string | null;
  subdomain: string | null;
  buckets: string[];
  d1: { name: string; uuid: string }[];
  kv: { id: string; title: string }[];
  queues: string[];
  catalogEnabled: boolean;
  workerId: string | null;
  workerSecrets: string[];
  accessApp: { id: string; aud: string } | null;
  serviceTokens: { id: string; name: string; client_id: string }[];
  resources: ProdResources;
  /** names present in .secrets/worker-secrets.env */
  workerSecretsFile: string[];
  /** current text of the rendered config, or null */
  renderedText: string | null;
  /** Google Cloud prerequisite lines that are missing (from `pv doctor gcp --json`) */
  gcpMissing: { name: string; fix: string }[];
  dataLoaded: boolean;
  /** GitHub repository of the P1 executor.yml job */
  github: GithubState;
}

export interface Step {
  group: Group;
  id: string;
  display: string;
}

export interface Missing {
  item: string;
  fix: string;
}

const acct = (s: SetupState) => s.accountId ?? "<ACCOUNT_ID>";

/** What only Nitish can do; setup stops here (except --dry-run, which prints this list and the plan). */
export function preflight(s: SetupState, env: Record<string, string>): Missing[] {
  const out: Missing[] = [];
  if (!s.loggedIn) out.push({ item: "wrangler login", fix: "npx wrangler login" });
  if (!s.accountId) out.push({ item: "CLOUDFLARE_ACCOUNT_ID", fix: "add CLOUDFLARE_ACCOUNT_ID=<id> to .secrets/prod.env" });
  for (const [name, fix] of [
    ["PV_CF_API_TOKEN", "create the account API token (docs/PRODUCTION.md step 7) and add it to .secrets/prod.env"],
    ["PV_R2_CATALOG_TOKEN", "create the R2 API token (docs/PRODUCTION.md step 8) and add it to .secrets/prod.env"],
    ["PV_GCP_PROJECT", "add PV_GCP_PROJECT=<PROJECT_ID> to .secrets/prod.env (docs/PRODUCTION.md step 10)"],
    ["PV_ACCESS_ALLOWED_EMAILS", "add the persona sign-in emails to .secrets/prod.env (docs/PRODUCTION.md step 15)"],
    ["PV_ACCESS_PERSONA_EMAILS", "add email=principalId pairs to .secrets/prod.env (docs/PRODUCTION.md step 15)"],
  ] as const)
    if (!env[name]) out.push({ item: name, fix });
  if (env.PV_CF_API_TOKEN && !s.teamDomain) out.push({ item: "Zero Trust organization", fix: "Zero Trust onboarding in the dashboard (docs/PRODUCTION.md steps 5 and 6)" });
  if (env.PV_CF_API_TOKEN && !s.subdomain && !env.PV_WORKERS_SUBDOMAIN)
    out.push({ item: "workers.dev subdomain", fix: `https://dash.cloudflare.com/${acct(s)}/workers/onboarding, or set PV_WORKERS_SUBDOMAIN in .secrets/prod.env` });
  for (const g of s.gcpMissing) out.push({ item: `Google Cloud: ${g.name}`, fix: g.fix });
  return out;
}

export function desiredRender(s: SetupState, env: Record<string, string>): string | null {
  const d1Id = s.resources.d1_id;
  const kvId = s.resources.kv_id;
  if (!d1Id || !kvId || !s.teamDomain || !env.PV_GCP_PROJECT || !existsSync(TEMPLATE)) return null;
  return renderConfig(readFileSync(TEMPLATE, "utf8"), {
    d1Id,
    kvId,
    accessTeamDomain: s.teamDomain,
    accessAud: s.accessApp?.aud ?? AUD_PENDING,
    gcpProject: env.PV_GCP_PROJECT,
    retentionCron: s.resources.retention_cron ?? "off",
  });
}

export function planSetup(s: SetupState, env: Record<string, string>, render: string | null = null): Step[] {
  const steps: Step[] = [];
  const add = (group: Group, id: string, display: string) => steps.push({ group, id, display });
  const W = "npx wrangler";
  // cloudflare
  if (!s.subdomain && env.PV_WORKERS_SUBDOMAIN)
    add("cloudflare", "subdomain:register", `PUT /client/v4/accounts/${acct(s)}/workers/subdomain {"subdomain":"${env.PV_WORKERS_SUBDOMAIN}"} (asks first)`);
  for (const b of BUCKETS) if (!s.buckets.includes(b)) add("cloudflare", `r2:${b}`, `${W} r2 bucket create ${b}`);
  const d1 = s.d1.find((d) => d.name === "pv-control");
  if (!d1) add("cloudflare", "d1:create", `${W} d1 create pv-control (records database_id)`);
  const kv = s.kv.find((n) => n.title === "pv-cache" || n.title.endsWith("pv-cache"));
  if (!kv) add("cloudflare", "kv:create", `${W} kv namespace create pv-cache (records id)`);
  if ((d1 && s.resources.d1_id !== d1.uuid) || (kv && s.resources.kv_id !== kv.id)) add("cloudflare", "cloudflare:record", "record the D1 and KV ids in .secrets/prod-resources.json");
  for (const q of QUEUES) if (!s.queues.includes(q)) add("cloudflare", `queue:${q}`, `${W} queues create ${q}`);
  if (!s.catalogEnabled) add("cloudflare", "catalog:enable", `${W} basin catalog enable pv-lake (records PV_CATALOG_URI and PV_CATALOG_WAREHOUSE in .secrets/prod.env)`);
  else if (!env.PV_CATALOG_URI || !env.PV_CATALOG_WAREHOUSE) add("cloudflare", "catalog:record", `GET /client/v4/accounts/${acct(s)}/r2-catalog/pv-lake (records PV_CATALOG_URI and PV_CATALOG_WAREHOUSE)`);
  // gcp
  add("gcp", "gcp:setup", "uv run --project pipelines pv setup gcp (idempotent; its own plan: uv run --project pipelines pv setup gcp --dry-run)");
  // worker
  const subdomain = s.subdomain ?? env.PV_WORKERS_SUBDOMAIN;
  if (subdomain && env.PV_BASE_URL !== `https://peoplevault.${subdomain}.workers.dev`) add("worker", "worker:base-url", `record PV_BASE_URL=https://peoplevault.${subdomain}.workers.dev in .secrets/prod.env`);
  if (!s.workerSecretsFile.includes("PV_PSEUDONYM_MASTER_KEY"))
    add("worker", "worker:master-key", "generate PV_PSEUDONYM_MASTER_KEY (32 random bytes) into .secrets/worker-secrets.env, once; copy it to your password manager");
  const renderChanged = render === null || s.renderedText !== render;
  if (renderChanged) add("worker", "worker:render", `render ${RENDERED_REL} from the template (D1 id, KV id, ACCESS_TEAM_DOMAIN, ACCESS_AUD ${s.accessApp ? "from the Access application" : `= ${AUD_PENDING} until the Access application exists`}, GCP_PROJECT_ID, RETENTION_CRON=${s.resources.retention_cron ?? "off"})`);
  add("worker", "worker:migrate", `${W} d1 migrations apply pv-control --remote -c ${RENDERED_REL}`);
  const secretsMissing = ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"].some((n) => !s.workerSecrets.includes(n));
  if (!s.workerId || renderChanged || secretsMissing) add("worker", "worker:deploy", `npm run deploy (${W} deploy -c ${RENDERED_REL} --secrets-file .secrets/worker-secrets.env)`);
  // access
  const have = new Map(s.serviceTokens.map((t) => [t.name, t]));
  for (const name of PERSONA_TOKENS) {
    const t = have.get(name);
    const secretKey = `PV_CF_ACCESS_CLIENT_SECRET_${PERSONA_ENV[name]}`;
    if (!t) add("access", `access:token:${name}`, `POST /client/v4/accounts/${acct(s)}/access/service_tokens {"name":"${name}","duration":"8760h"} (client id and secret into .secrets/prod.env as ${secretKey.replace("SECRET", "ID")} / ${secretKey})`);
    else if (!env[secretKey]) add("access", `access:rotate:${name}`, `POST /client/v4/accounts/${acct(s)}/access/service_tokens/${t.id}/rotate (secret not recorded; new secret into .secrets/prod.env as ${secretKey})`);
  }
  if (!s.accessApp)
    add("access", "access:app", `POST /client/v4/accounts/${acct(s)}/access/apps (infra/cloudflare/access-app.template.json: worker destination for peoplevault, allow-owner for ${(env.PV_ACCESS_ALLOWED_EMAILS ?? "").split(",").filter(Boolean).length} email(s), service-tokens for ${PERSONA_TOKENS.length} tokens)`);
  if (!s.accessApp || s.renderedText?.includes(AUD_PENDING)) add("access", "access:redeploy", `render ACCESS_AUD from the Access application into ${RENDERED_REL}, then npm run deploy`);
  // data
  if (!s.dataLoaded) add("data", "data:seed", "npm run seed:prod (remote D1 seed and principal mapping, 41 export objects, lake self-test and table, snapshot expiration, pv load --target prod, counts and controls)");
  // the audit copy (SPEC.md section 30.3.3): the first export creates governance.audit_events, then its snapshot
  // expiration with the defaults (30 days, keep 5; free; a table-level setting needs no --token)
  if (!s.resources.audit_copy_table) add("data", "data:audit-copy", "uv run --project pipelines pv audit export --target prod (creates the Basin Catalog table governance.audit_events and copies the audit chain)");
  if (!s.resources.audit_copy_expiration) add("data", "data:audit-expiration", `${W} basin catalog snapshot-expiration enable pv-lake governance audit_events`);
  // github (P1 executor.yml; asks before writing)
  steps.push(...planGithub(s, env));
  return steps;
}

/** Repository secrets and the PV_PROD_ENABLED variable for executor.yml. Values travel on gh's stdin, never in argv. */
export function planGithub(s: SetupState, env: Record<string, string>): Step[] {
  const g = s.github;
  const out: Step[] = [];
  const add = (id: string, display: string) => out.push({ group: "github", id, display });
  if (!g.authed) {
    add("github:needs-auth", "gh is not logged in: run gh auth login, then setup again");
    return out;
  }
  if (!g.repo) {
    add("github:needs-repo", "no GitHub repository: add the origin remote or set PV_GITHUB_REPO=<owner>/<name> in .secrets/prod.env");
    return out;
  }
  const R = g.repo;
  const recorded = (s.resources.github_secrets ?? {}) as Record<string, string>;
  const waiting: string[] = [];
  if (!g.secrets.includes(EXECUTOR_KEY_SECRET))
    add("github:executor-key", `uv run --project pipelines pv setup actions-key --repo ${R} (creates a pv-executor key and pipes it into gh secret set ${EXECUTOR_KEY_SECRET}; never written to disk)`);
  for (const [name, source] of Object.entries(GITHUB_SECRET_SOURCES)) {
    const value = source(env, s.resources);
    if (!value) waiting.push(name);
    else if (!g.secrets.includes(name) || recorded[name] !== sha256(value)) add(`github:secret:${name}`, `gh secret set ${name} --app actions --repo ${R} (value on stdin)`);
  }
  if (waiting.length) add("github:blocked", `waiting for ${waiting.join(", ")}: run the cloudflare, gcp, worker and access groups first`);
  if (g.workflowState && g.workflowState !== "active") add("github:enable", `gh workflow enable ${EXECUTOR_WORKFLOW} --repo ${R} (state ${g.workflowState})`);
  if (g.variables.PV_PROD_ENABLED !== "true") add("github:variable", `gh variable set PV_PROD_ENABLED --body true --repo ${R} (executor.yml runs hourly from then on)`);
  return out;
}

export function renderPlan(missing: Missing[], steps: Step[], only: Group | null): string {
  const lines: string[] = [];
  if (missing.length) {
    lines.push("Preflight: missing (only you can do these; docs/PRODUCTION.md)");
    for (const m of missing) lines.push(`  [missing] ${m.item}\n      fix: ${m.fix}`);
  } else lines.push("Preflight: ok");
  for (const g of GROUPS) {
    if (only && g !== only) continue;
    const mine = steps.filter((st) => st.group === g);
    lines.push(`${g}: ${mine.length ? `${mine.length} step(s)${g === "github" ? " (asks first)" : ""}` : "nothing to do"}`);
    for (const st of mine) lines.push(`  ${st.display}`);
  }
  return lines.join("\n");
}

// ---- state ----------------------------------------------------------------------------------------------------------
export interface SetupDeps {
  run(cmd: string, args: string[], input?: string): Promise<RunResult>;
  fetchImpl: typeof fetch;
  wrangler: string;
}

function tryJson<T>(text: string, fallback: T): T {
  try {
    return parseJsonOutput<T>(text);
  } catch {
    return fallback;
  }
}

export async function gatherState(d: SetupDeps, env: Record<string, string>): Promise<SetupState> {
  const who = tryJson<{ loggedIn?: boolean; accounts?: { id: string }[] }>((await d.run(d.wrangler, ["whoami", "--json"])).stdout, {});
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? (who.accounts?.length === 1 ? who.accounts[0]!.id : null);
  const s: SetupState = {
    accountId,
    loggedIn: who.loggedIn === true,
    teamDomain: null,
    subdomain: null,
    buckets: [],
    d1: [],
    kv: [],
    queues: [],
    catalogEnabled: false,
    workerId: null,
    workerSecrets: [],
    accessApp: null,
    serviceTokens: [],
    resources: readResources(),
    workerSecretsFile: Object.keys(readEnvFile(WORKER_SECRETS)).filter((k) => readEnvFile(WORKER_SECRETS)[k]),
    renderedText: existsSync(RENDERED) ? readFileSync(RENDERED, "utf8") : null,
    gcpMissing: [],
    dataLoaded: false,
    github: await readGithubState(d.run, env),
  };
  if (accountId && env.PV_CF_API_TOKEN) {
    const api = new CfApi(accountId, env.PV_CF_API_TOKEN, d.fetchImpl);
    s.teamDomain = (await api.organization().catch(() => null))?.auth_domain ?? null;
    s.subdomain = await api.workersSubdomain().catch(() => null);
    s.serviceTokens = (await api.serviceTokens().catch(() => [])).map((t) => ({ id: t.id, name: t.name, client_id: t.client_id }));
    const app = (await api.accessApps().catch(() => [])).find((a) => a.name === "PeopleVault");
    s.accessApp = app ? { id: app.id, aud: app.aud } : null;
    s.workerId = (await api.workers().catch(() => [])).find((w) => w.name === "peoplevault")?.id ?? null;
  }
  if (accountId && s.loggedIn) {
    const oauth = tryJson<{ token?: string }>((await d.run(d.wrangler, ["auth", "token", "--json"])).stdout, {}).token;
    if (oauth) {
      const api = new CfApi(accountId, oauth, d.fetchImpl);
      s.buckets = (await api.r2Buckets().catch(() => ({ buckets: [] }))).buckets.map((b) => b.name);
      s.kv = await api.kvNamespaces().catch(() => []);
      s.queues = (await api.queues().catch(() => [])).map((q) => q.queue_name);
      const cat = await api.catalog("pv-lake").catch(() => null);
      s.catalogEnabled = !!cat && /active|enabled/i.test(cat.status ?? "");
    }
    s.d1 = tryJson<{ name: string; uuid: string }[]>((await d.run(d.wrangler, ["d1", "list", "--json"])).stdout, []);
    if (s.renderedText && s.workerId) {
      s.workerSecrets = tryJson<{ name: string }[]>((await d.run(d.wrangler, ["secret", "list", "-c", RENDERED_REL, "--format", "json"])).stdout, []).map((x) => x.name);
    }
  }
  const gcp = tryJson<{ group: string; name: string; status: string; fix?: string }[]>((await d.run("uv", ["run", "--project", "pipelines", "pv", "doctor", "gcp", "--json"])).stdout, []);
  s.gcpMissing = gcp.filter((c) => c.group === "Google Cloud" && c.status === "missing").map((c) => ({ name: c.name, fix: c.fix ?? "" }));
  s.dataLoaded = gcp.some((c) => c.name === "data loaded" && c.status !== "missing");
  return s;
}

// ---- apply ----------------------------------------------------------------------------------------------------------
async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function parseCatalog(text: string): { uri?: string; warehouse?: string } {
  const uri = text.match(/catalog\s*uri\s*[:=]\s*(\S+)/i)?.[1];
  const warehouse = text.match(/warehouse(?:\s*name)?\s*[:=]\s*(\S+)/i)?.[1];
  return { ...(uri ? { uri } : {}), ...(warehouse ? { warehouse } : {}) };
}

async function deploy(): Promise<void> {
  await run(process.execPath, [path.join(REPO_ROOT, "scripts", "deploy-prod.ts")], { quiet: true });
}

function renderTo(s: SetupState, env: Record<string, string>): void {
  const text = desiredRender({ ...s, resources: readResources() }, env);
  if (!text) throw new Error("cannot render the production config yet: D1 id, KV id, Zero Trust team domain and PV_GCP_PROJECT are required");
  writeFileSync(RENDERED, text);
}

async function applyStep(st: Step, s: SetupState, env: Record<string, string>): Promise<void> {
  const accountId = s.accountId!;
  const api = () => new CfApi(accountId, env.PV_CF_API_TOKEN!);
  const parts = st.id.split(":");
  const key = ["subdomain", "r2", "d1", "kv", "queue", "catalog"].includes(parts[0]!) ? parts[0]! : `${parts[0]}:${parts[1]}`;
  const arg = parts.slice(1).join(":");
  switch (key) {
    case "subdomain": {
      if (!(await ask(`Register the workers.dev subdomain "${env.PV_WORKERS_SUBDOMAIN}" for this account (account-wide, cannot be undone here)?`))) throw new Error("subdomain not registered; register it in the dashboard instead");
      await api().registerWorkersSubdomain(env.PV_WORKERS_SUBDOMAIN!);
      return;
    }
    case "r2":
      await wrangler(["r2", "bucket", "create", arg!]);
      return;
    case "d1": {
      const out = await wrangler(["d1", "create", "pv-control"]);
      const id = out.stdout.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/)?.[1];
      if (!id) throw new Error("could not read database_id from `wrangler d1 create`; run setup again to record it from `wrangler d1 list`");
      writeResources({ d1_id: id });
      return;
    }
    case "kv": {
      const out = await wrangler(["kv", "namespace", "create", "pv-cache"]);
      const id = out.stdout.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/)?.[1];
      if (!id) throw new Error("could not read the namespace id from `wrangler kv namespace create`; run setup again to record it");
      writeResources({ kv_id: id });
      return;
    }
    case "cloudflare:record": {
      const d1 = s.d1.find((x) => x.name === "pv-control");
      const kv = s.kv.find((n) => n.title === "pv-cache" || n.title.endsWith("pv-cache"));
      writeResources({ ...(d1 ? { d1_id: d1.uuid } : {}), ...(kv ? { kv_id: kv.id } : {}) });
      return;
    }
    case "queue":
      await wrangler(["queues", "create", arg!]);
      return;
    case "catalog": {
      const text = arg === "enable" ? (await wrangler(["basin", "catalog", "enable", "pv-lake"])).stdout : (await wrangler(["basin", "catalog", "get", "pv-lake"], { allowFail: true })).stdout;
      const c = parseCatalog(text);
      if (!c.uri || !c.warehouse) throw new Error("could not read the Catalog URI and Warehouse; copy them from the dashboard (R2, pv-lake, Settings) into .secrets/prod.env as PV_CATALOG_URI and PV_CATALOG_WAREHOUSE");
      upsertEnvFile(PROD_ENV, { PV_CATALOG_URI: c.uri, PV_CATALOG_WAREHOUSE: c.warehouse });
      writeResources({ catalog_uri: c.uri, catalog_warehouse: c.warehouse });
      return;
    }
    case "gcp:setup": {
      const out = await pv(["setup", "gcp"]);
      process.stdout.write(out.stdout);
      return;
    }
    case "worker:base-url":
      upsertEnvFile(PROD_ENV, { PV_BASE_URL: `https://peoplevault.${s.subdomain ?? env.PV_WORKERS_SUBDOMAIN}.workers.dev` });
      return;
    case "worker:master-key":
      upsertEnvFile(WORKER_SECRETS, { PV_PSEUDONYM_MASTER_KEY: randomBytes(32).toString("base64") });
      console.log("  generated PV_PSEUDONYM_MASTER_KEY in .secrets/worker-secrets.env: copy it to your password manager now (losing it orphans every pseudonym)");
      return;
    case "worker:render":
      renderTo(s, env);
      return;
    case "worker:migrate":
      await wrangler(["d1", "migrations", "apply", "pv-control", "--remote", "-c", RENDERED_REL], { input: "y\n" });
      return;
    case "worker:deploy":
      await deploy();
      return;
    case "access:token":
    case "access:rotate": {
      const name = parts[2]!;
      const existing = s.serviceTokens.find((t) => t.name === name);
      const t = parts[1] === "rotate" ? await api().rotateServiceToken(existing!.id) : await api().createServiceToken(name);
      if (!t.client_secret) throw new Error(`no client secret returned for ${name}`);
      const suffix = PERSONA_ENV[name]!;
      upsertEnvFile(PROD_ENV, { [`PV_CF_ACCESS_CLIENT_ID_${suffix}`]: t.client_id, [`PV_CF_ACCESS_CLIENT_SECRET_${suffix}`]: t.client_secret });
      writeResources({ service_tokens: { ...(readResources().service_tokens ?? {}), [name]: { id: t.id ?? existing?.id ?? "", client_id: t.client_id } } });
      return;
    }
    case "access:app": {
      const workerId = (await api().workers()).find((w) => w.name === "peoplevault")?.id;
      if (!workerId) throw new Error("the peoplevault Worker is not deployed yet (run the worker group first)");
      const tokens = (await api().serviceTokens()).filter((t) => (PERSONA_TOKENS as readonly string[]).includes(t.name));
      const body = accessAppBody(readFileSync(ACCESS_TEMPLATE, "utf8"), {
        subdomain: s.subdomain ?? env.PV_WORKERS_SUBDOMAIN ?? "",
        workerId,
        emails: (env.PV_ACCESS_ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean),
        serviceTokenIds: tokens.map((t) => t.id),
      });
      const app = await api().createAccessApp(body);
      writeResources({ access_app_id: app.id, access_aud: app.aud, worker_id: workerId, access_team_domain: s.teamDomain ?? undefined });
      return;
    }
    case "access:redeploy": {
      const app = (await api().accessApps()).find((a) => a.name === "PeopleVault");
      if (!app) throw new Error("the PeopleVault Access application does not exist");
      writeResources({ access_app_id: app.id, access_aud: app.aud });
      renderTo({ ...s, accessApp: { id: app.id, aud: app.aud } }, env);
      await deploy();
      return;
    }
    case "data:seed":
      await run(process.execPath, [path.join(REPO_ROOT, "scripts", "seed-prod.ts")]);
      return;
    case "data:audit-copy":
      process.stdout.write((await pv(["audit", "export", "--target", "prod"])).stdout);
      writeResources({ audit_copy_table: true });
      return;
    case "data:audit-expiration":
      await wrangler(["basin", "catalog", "snapshot-expiration", "enable", "pv-lake", "governance", "audit_events"]);
      writeResources({ audit_copy_expiration: true });
      return;
    case "github:executor-key":
      process.stdout.write((await pv(["setup", "actions-key", "--repo", s.github.repo!])).stdout);
      return;
    case "github:secret": {
      const name = parts[2]!;
      const value = GITHUB_SECRET_SOURCES[name]?.(env, readResources());
      if (!value) throw new Error(`no value for ${name}`);
      await run("gh", ["secret", "set", name, "--app", "actions", "--repo", s.github.repo!], { input: value, quiet: true });
      const res = readResources();
      writeResources({ github_secrets: { ...((res.github_secrets ?? {}) as Record<string, string>), [name]: sha256(value) } });
      return;
    }
    case "github:enable":
      await run("gh", ["workflow", "enable", EXECUTOR_WORKFLOW, "--repo", s.github.repo!]);
      return;
    case "github:variable":
      await run("gh", ["variable", "set", "PV_PROD_ENABLED", "--body", "true", "--repo", s.github.repo!]);
      return;
    case "github:needs-auth":
    case "github:needs-repo":
    case "github:blocked":
      throw new Error(st.display);
    default:
      throw new Error(`unknown step ${st.id}`);
  }
}

/** The Access application body from the template: worker destination, owner emails, service tokens. */
export function accessAppBody(template: string, v: { subdomain: string; workerId: string; emails: string[]; serviceTokenIds: string[] }): Record<string, unknown> {
  if (!v.subdomain || !v.workerId || v.emails.length === 0 || v.serviceTokenIds.length === 0) throw new Error("access app body needs the subdomain, the Worker id, at least one email and the service tokens");
  const raw = JSON.parse(template) as Record<string, unknown>;
  const text = JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))))
    .split("__WORKERS_SUBDOMAIN__")
    .join(v.subdomain)
    .split("__WORKER_ID__")
    .join(v.workerId)
    .replace('"__EMAIL_RULES__"', JSON.stringify(v.emails.map((email) => ({ email: { email } }))))
    .replace('"__SERVICE_TOKEN_RULES__"', JSON.stringify(v.serviceTokenIds.map((token_id) => ({ service_token: { token_id } }))));
  if (/__[A-Z_]+__/.test(text)) throw new Error("access app template placeholders left");
  return JSON.parse(text) as Record<string, unknown>;
}

function realDeps(): SetupDeps {
  return { run: (cmd, args, input) => run(cmd, args, { allowFail: true, ...(input ? { input } : {}) }), fetchImpl: fetch, wrangler: wranglerBin() };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const i = argv.indexOf("--only");
  const only = i >= 0 ? (argv[i + 1] as Group) : null;
  if (only && !(GROUPS as readonly string[]).includes(only)) throw new Error(`--only takes one of ${GROUPS.join(", ")}`);
  // --retention-cron on|off: RETENTION_CRON of the rendered config (SPEC.md section 30.3.4). Turn it on only after the
  // production eval result is committed; the worker group then re-renders and redeploys.
  const c = argv.indexOf("--retention-cron");
  const cron = c >= 0 ? argv[c + 1] : null;
  if (cron !== null && cron !== "on" && cron !== "off") throw new Error("--retention-cron takes on or off");
  const deps = realDeps();
  let env = prodEnv();
  let state = await gatherState(deps, env);
  if (cron) {
    if (dryRun) state.resources = { ...state.resources, retention_cron: cron };
    else state.resources = writeResources({ retention_cron: cron });
  }
  const missing = preflight(state, env);
  if (dryRun) {
    console.log(renderPlan(missing, planSetup(state, env, desiredRender(state, env)), only));
    return;
  }
  if (missing.length) {
    console.log(renderPlan(missing, [], only));
    console.log("\nsetup:prod stopped: do the items above, then run it again.");
    process.exit(1);
  }
  for (const g of GROUPS) {
    if (only && g !== only) continue;
    env = prodEnv();
    state = await gatherState(deps, env);
    const steps = planSetup(state, env, desiredRender(state, env)).filter((st) => st.group === g);
    console.log(`${g}: ${steps.length ? `${steps.length} step(s)` : "nothing to do"}`);
    if (g === "github" && steps.length) {
      for (const st of steps) console.log(`  ${st.display}`);
      const writes = steps.filter((st) => !["github:needs-auth", "github:needs-repo", "github:blocked"].includes(st.id));
      if (writes.length && !(await ask(`Write ${writes.length} change(s) to the GitHub repository ${state.github.repo} (secrets for executor.yml, PV_PROD_ENABLED=true)?`))) {
        console.log("  github: skipped (not confirmed); the executor keeps running from this machine until you run setup:prod -- --only github");
        continue;
      }
    }
    for (const st of steps) {
      if (g !== "github") console.log(`  ${st.display}`);
      await applyStep(st, state, prodEnv());
      if (st.id.startsWith("cloudflare:") || st.id.startsWith("d1:") || st.id.startsWith("kv:")) state.resources = readResources();
    }
  }
  console.log(`
Next (docs/PRODUCTION.md section "Commands after the logins"):
  npm run doctor -- --prod
  uv run --project pipelines pv authz warehouse --target bigquery --write-results --ceiling-probes
  uv run --project pipelines pv executor run --target prod --drain
  uv run --project pipelines pv residuals check --target prod   # after 48 hours, and again after 1 day for Basin`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
