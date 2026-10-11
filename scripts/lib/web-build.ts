// The privacy console build (dist/web). Wrangler refuses to start or deploy without the configured assets directory,
// so `npm run dev` (and every script that starts the local stack) builds the console when it is missing or older
// than its sources, and `npm run deploy` always builds it first.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, run } from "./run.ts";

export const WEB_OUT = path.join(REPO_ROOT, "dist", "web");
const SOURCES = ["index.html", "vite.config.ts", "package-lock.json", path.join("src", "web")];

function newestMtime(p: string): number {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const e of readdirSync(p)) newest = Math.max(newest, newestMtime(path.join(p, e)));
  return newest;
}

/** True when the build is missing or a source changed after it was written. */
export function webBuildStale(root = REPO_ROOT, out = path.join(root, "dist", "web")): boolean {
  const index = path.join(out, "index.html");
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  return SOURCES.some((s) => newestMtime(path.join(root, s)) > built);
}

export async function buildWeb(): Promise<void> {
  const vite = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  if (!existsSync(vite)) throw new Error("vite is not installed; run `npm ci`");
  await run(vite, ["build", "--logLevel", "warn"], { quiet: true });
}

/** Builds the console when stale; returns whether it built. */
export async function ensureWebBuild(): Promise<boolean> {
  if (!webBuildStale()) return false;
  await buildWeb();
  return true;
}
