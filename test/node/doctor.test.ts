// npm run doctor: every line is ok, warn or missing, every non-ok line carries its fix, and the exit code is 1 only
// when something is missing. All commands, files, ports and HTTP are fakes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CF_API } from "../../scripts/lib/cf-api.ts";
import { exitCode, localChecks, prodChecks, render, type DoctorDeps } from "../../scripts/lib/checks.ts";
import { REPO_ROOT, type RunResult } from "../../scripts/lib/run.ts";

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const fail: RunResult = { code: 1, stdout: "", stderr: "" };

function fixture(name: string): { status: number; body: unknown } {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "test", "fixtures", "contracts", "cloudflare", `${name}.json`), "utf8"));
}

function deps(over: Partial<DoctorDeps> & { files?: Record<string, string>; commands?: Record<string, RunResult>; routes?: Record<string, string | Response> } = {}): DoctorDeps {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { hono: "4.13.13" }, devDependencies: {} }),
    "node_modules/hono/package.json": JSON.stringify({ version: "4.13.13" }),
    ".dev.vars": "DEV_ACCESS_JWKS=a\nDEV_ACCESS_PRIVATE_JWK=b\nPV_PSEUDONYM_MASTER_KEY=c\nWAREHOUSE_SHIM_TOKEN=d\nGCP_GATEWAY_SA_KEY=\n",
    "pipelines/.data/warehouse.duckdb": "",
    "pipelines/.data/lake/catalog.db": "",
    ...over.files,
  };
  const commands: Record<string, RunResult> = {
    "uv --version": ok("uv 0.12.17"),
    "uv sync --project pipelines --locked --check": ok(""),
    "uv python find 3.12": ok("/usr/bin/python3.12"),
    "wrangler d1 execute pv-control --local --json --command SELECT COUNT(*) AS n FROM identity_map": ok(JSON.stringify([{ results: [{ n: 1200 }] }])),
    "wrangler whoami --json": ok(JSON.stringify({ loggedIn: false })),
    "uv run --project pipelines pv doctor gcp --json": ok(JSON.stringify([{ group: "Google Cloud", name: "gcloud", status: "missing", detail: "not installed", fix: "brew install --cask gcloud-cli" }])),
    ...over.commands,
  };
  const routes = over.routes ?? {};
  return {
    run: async (cmd, args) => commands[[cmd, ...args].join(" ")] ?? fail,
    env: over.env ?? {},
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const r = routes[`${init?.method ?? "GET"} ${url.replace(CF_API, "")}`] ?? routes[url];
      if (r instanceof Response) return r;
      if (!r) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }), { status: 403 });
      const f = fixture(r);
      return new Response(JSON.stringify(f.body), { status: f.status });
    }) as typeof fetch,
    exists: (p) => p in files,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`no ${p}`);
      return files[p]!;
    },
    portOpen: over.portOpen ?? (async () => false),
    nodeVersion: over.nodeVersion ?? "v24.11.0",
    wrangler: "wrangler",
  };
}

function nonOkHaveFixes(lines: { status: string; fix?: string }[]): void {
  for (const l of lines) if (l.status !== "ok") expect(l.fix, JSON.stringify(l)).toBeTruthy();
}

describe("doctor (local)", () => {
  it("all ok on a seeded machine", async () => {
    const r = await localChecks(deps());
    expect(r.filter((x) => x.status !== "ok")).toEqual([]);
    expect(exitCode(r)).toBe(0);
  });

  it("warns on Node 25 and busy ports, and is missing an unseeded store, with fixes", async () => {
    const r = await localChecks(deps({ nodeVersion: "v25.9.0", portOpen: async (p) => p === 8793, commands: { "wrangler d1 execute pv-control --local --json --command SELECT COUNT(*) AS n FROM identity_map": fail } }));
    const by = Object.fromEntries(r.map((x) => [x.name, x]));
    expect(by.node).toMatchObject({ status: "warn", fix: "nvm install 24 && nvm use 24" });
    expect(by.ports).toMatchObject({ status: "warn", fix: "npm run stop:local" });
    expect(by["local seed"]).toMatchObject({ status: "missing", fix: "npm run seed:local -- --fresh" });
    expect(exitCode(r)).toBe(1);
    nonOkHaveFixes(r);
  });

  it("flags .dev.vars with names other than secrets.required and drifted node_modules", async () => {
    const r = await localChecks(deps({ files: { ".dev.vars": "PV_PSEUDONYM_MASTER_KEY=c\n", "node_modules/hono/package.json": JSON.stringify({ version: "4.0.0" }) } }));
    const by = Object.fromEntries(r.map((x) => [x.name, x]));
    expect(by[".dev.vars"]!.fix).toBe("npm run dev:keys -- --force");
    expect(by.node_modules!.fix).toBe("npm ci");
  });
});

describe("doctor --prod", () => {
  it("logged out with no tokens: every Cloudflare line says how to fix it, Google lines are merged", async () => {
    const r = await prodChecks(deps());
    const text = render(r);
    expect(text).toContain("[missing] wrangler login: not logged in");
    expect(text).toContain("fix: npx wrangler login");
    expect(text).toContain("[missing] gcloud: not installed");
    expect(r.find((x) => x.name === "PV_CF_API_TOKEN")!.status).toBe("missing");
    nonOkHaveFixes(r);
    expect(exitCode(r)).toBe(1);
  });

  it("with the API token: reads Access, the Zero Trust org, subscriptions and the missing workers.dev subdomain", async () => {
    const r = await prodChecks(
      deps({
        env: { CLOUDFLARE_ACCOUNT_ID: "acct", PV_CF_API_TOKEN: "tok-value-zq" },
        routes: {
          "GET /accounts/acct/access/apps": "access_apps",
          "GET /accounts/acct/access/service_tokens": "service_tokens",
          "GET /accounts/acct/access/organizations": "organizations",
          "GET /accounts/acct/workers/subdomain": "workers_subdomain_missing",
          "GET /accounts/acct/subscriptions": "subscriptions",
        },
      }),
    );
    const by = Object.fromEntries(r.map((x) => [x.name, x]));
    expect(by["PV_CF_API_TOKEN scopes"]!.status).toBe("ok");
    expect(by["Zero Trust organization"]).toMatchObject({ status: "ok", detail: "nitish-pv.cloudflareaccess.com" });
    expect(by["Workers Paid"]!.status).toBe("ok");
    expect(by["workers.dev subdomain"]).toMatchObject({ status: "missing" });
    expect(by["workers.dev subdomain"]!.fix).toContain("https://dash.cloudflare.com/acct/workers/onboarding");
    expect(by["service tokens"]).toMatchObject({ status: "missing", detail: "missing: pv-persona-manager, pv-persona-analyst, pv-persona-privacy" });
    expect(render(r)).not.toContain("tok-value-zq");
  });

  it("names the scopes the token lacks", async () => {
    const r = await prodChecks(deps({ env: { CLOUDFLARE_ACCOUNT_ID: "acct", PV_CF_API_TOKEN: "t" }, routes: { "GET /accounts/acct/access/apps": "access_apps" } }));
    const line = r.find((x) => x.name === "PV_CF_API_TOKEN scopes")!;
    expect(line.status).toBe("missing");
    expect(line.detail).toContain("subscriptions (Billing Read)");
  });

  it("edge protection: an Access redirect is ok, a Worker JSON 401 is missing", async () => {
    const base = {
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", PV_CF_API_TOKEN: "t" },
      routes: {
        "GET /accounts/acct/access/apps": "access_apps",
        "GET /accounts/acct/access/service_tokens": "service_tokens",
        "GET /accounts/acct/access/organizations": "organizations",
        "GET /accounts/acct/workers/subdomain": "workers_subdomain",
        "GET /accounts/acct/subscriptions": "subscriptions",
      } as Record<string, string | Response>,
    };
    const url = "https://peoplevault.nitish-pv.workers.dev/api/v1/me";
    const redirected = await prodChecks(deps({ ...base, routes: { ...base.routes, [url]: new Response(null, { status: 302, headers: { location: "https://nitish-pv.cloudflareaccess.com/cdn-cgi/access/login" } }) } }));
    expect(redirected.find((x) => x.name === "edge protection")!.status).toBe("ok");
    const open = await prodChecks(deps({ ...base, routes: { ...base.routes, [url]: new Response(JSON.stringify({ error: "missing_token" }), { status: 401, headers: { "content-type": "application/json" } }) } }));
    expect(open.find((x) => x.name === "edge protection")).toMatchObject({ status: "missing" });
  });
});
