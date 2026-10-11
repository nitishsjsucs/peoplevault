// The privacy console as static assets (SPEC.md sections 4 and 30.1): both Wrangler configs serve the same dist/web,
// only /api/* and /dev/* invoke the Worker, and the build stays far inside Workers Free's static asset limits (F21)
// with a strict CSP, no source maps and no third-party resources.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FACTS } from "../../scripts/lib/free-budget.ts";
import { TEMPLATE } from "../../scripts/lib/prod-files.ts";
import { REPO_ROOT } from "../../scripts/lib/run.ts";
import { webBuildStale } from "../../scripts/lib/web-build.ts";

function stripJsonc(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

type Assets = { directory: string; not_found_handling: string; run_worker_first: string[]; binding?: string };
const configs: [string, string][] = [
  ["wrangler.jsonc", path.join(REPO_ROOT, "wrangler.jsonc")],
  ["production template", TEMPLATE],
];

describe("assets configuration", () => {
  it.each(configs)("%s serves dist/web as a single-page app and runs the Worker first only for /api/* and /dev/*", (_name, file) => {
    const assets = (JSON.parse(stripJsonc(readFileSync(file, "utf8"))) as { assets: Assets }).assets;
    expect(path.resolve(path.dirname(file), assets.directory)).toBe(path.join(REPO_ROOT, "dist", "web"));
    expect(assets.not_found_handling).toBe("single-page-application");
    expect(assets.run_worker_first).toEqual(["/api/*", "/dev/*"]);
    // no ASSETS binding: the Worker never serves the console itself, and Env (worker-configuration.d.ts) is unchanged
    expect(assets.binding).toBeUndefined();
  });

  it("the console's paths never start with a Worker-first prefix", () => {
    const src = readFileSync(path.join(REPO_ROOT, "src", "web", "router.ts"), "utf8");
    for (const p of src.match(/`\/[a-z_/${}.]+`/g) ?? []) expect(p).not.toMatch(/^`\/(api|dev)\//);
  });
});

describe("console build", () => {
  let out: string;
  beforeAll(async () => {
    out = mkdtempSync(path.join(os.tmpdir(), "peoplevault-web-"));
    await build({ configFile: path.join(REPO_ROOT, "vite.config.ts"), root: REPO_ROOT, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it("stays far inside Free's static asset limits and publishes no source maps", () => {
    const all = files(out);
    expect(FACTS.F21.value).toEqual([20_000, 25]);
    expect(all.length).toBeLessThanOrEqual(10);
    for (const f of all) expect(statSync(f).size).toBeLessThan(FACTS.F21.value[1] * 1024 * 1024);
    expect(all.filter((f) => f.endsWith(".map"))).toEqual([]);
  });

  it("index.html loads only its own hashed script and stylesheet, with no inline script", () => {
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!);
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toMatch(/src="\/assets\/index-[\w-]+\.js"/);
    expect(html).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/index-[\w-]+\.css"/);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("_headers sets a same-origin CSP, no framing and no Referer on every path", () => {
    const headers = readFileSync(path.join(out, "_headers"), "utf8");
    const all = headers.split(/\n(?=\/)/).find((b) => b.startsWith("/*\n"))!;
    expect(all).toContain("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';");
    expect(all).toContain("connect-src 'self'");
    expect(all).toContain("frame-ancestors 'none'");
    expect(all).toContain("Referrer-Policy: no-referrer");
    expect(all).toContain("X-Content-Type-Options: nosniff");
  });
});

describe("web build staleness (npm run dev builds the console when stale)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "peoplevault-stale-"));
    mkdirSync(path.join(root, "src", "web", "pages"), { recursive: true });
    for (const f of ["index.html", "vite.config.ts", "package-lock.json", "src/web/App.tsx", "src/web/pages/MePage.tsx"]) writeFileSync(path.join(root, f), "x");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is stale without a build, fresh after one, and stale again when any source changes", () => {
    expect(webBuildStale(root)).toBe(true);
    const out = path.join(root, "dist", "web");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "index.html"), "built");
    const t = Date.now() / 1000;
    for (const f of ["index.html", "vite.config.ts", "package-lock.json", "src/web/App.tsx", "src/web/pages/MePage.tsx", "src/web/pages", "src/web", "src"]) utimesSync(path.join(root, f), t - 100, t - 100);
    utimesSync(path.join(out, "index.html"), t, t);
    expect(webBuildStale(root)).toBe(false);
    utimesSync(path.join(root, "src/web/pages/MePage.tsx"), t + 10, t + 10);
    expect(webBuildStale(root)).toBe(true);
  });
});
