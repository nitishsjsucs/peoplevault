// npm run doctor [-- --prod]: checks every prerequisite and prints exactly what is missing, with the fix for each line.
// Exit code 1 if anything is [missing]. Google Cloud checks run in Python (`pv doctor gcp --json`) and are merged.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { exitCode, localChecks, prodChecks, render, type DoctorDeps } from "./lib/checks.ts";
import { portOpen } from "./lib/pids.ts";
import { REPO_ROOT, run, wranglerBin, wranglerEnv } from "./lib/run.ts";

export function realDeps(): DoctorDeps {
  return {
    run: (cmd, args) => run(cmd, args, { allowFail: true, ...(cmd === wranglerBin() ? { env: wranglerEnv() } : {}) }),
    env: process.env,
    fetchImpl: fetch,
    // repo-relative paths, or absolute ones such as the local model file (path.join would nest those under the repo)
    exists: (p) => existsSync(path.resolve(REPO_ROOT, p)),
    readFile: (p) => readFileSync(path.resolve(REPO_ROOT, p), "utf8"),
    portOpen: (port) => portOpen(port),
    nodeVersion: process.version,
    wrangler: wranglerBin(),
  };
}

async function main(): Promise<void> {
  const deps = realDeps();
  const results = await localChecks(deps);
  if (process.argv.includes("--prod")) results.push(...(await prodChecks(deps)));
  console.log(render(results));
  const missing = results.filter((r) => r.status === "missing").length;
  console.log(`\n${missing === 0 ? "nothing missing" : `${missing} missing`}`);
  process.exit(exitCode(results));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
