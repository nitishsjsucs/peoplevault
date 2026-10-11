// npm run dev: builds the privacy console when stale, starts wrangler dev (8793, inspector 9243) and pv serve (shim
// 8893 + executor loop) as detached process groups with pidfiles, waits for both, and stops both on exit (Ctrl+C).
// Logs: .dev/logs/.
import path from "node:path";
import { LOCAL_PORTS, portOpen, startGroup, stopAll, waitForHttp } from "./lib/pids.ts";
import { REPO_ROOT, wrangler, wranglerBin, wranglerEnv } from "./lib/run.ts";
import { ensureWebBuild } from "./lib/web-build.ts";

export const AI_MODES = ["stub", "llama-server"] as const;
export type LocalAiMode = (typeof AI_MODES)[number];

/** wrangler dev arguments; `aiMode` overrides AI_MODE for this run (`pv eval drift --start --ai-mode llama-server`). */
export function wranglerDevArgs(aiMode: LocalAiMode | null = null): string[] {
  return ["dev", "--port", String(LOCAL_PORTS.worker), "--inspector-port", String(LOCAL_PORTS.inspector), "--ip", "127.0.0.1", "--show-interactive-dev-session=false", ...(aiMode ? ["--var", `AI_MODE:${aiMode}`] : [])];
}

export async function startLocalStack(opts: { executor?: boolean; aiMode?: LocalAiMode | null } = {}): Promise<void> {
  for (const [name, port] of Object.entries({ worker: LOCAL_PORTS.worker, inspector: LOCAL_PORTS.inspector, shim: LOCAL_PORTS.shim })) {
    if (await portOpen(port)) throw new Error(`port ${port} (${name}) is already in use; run \`npm run stop:local\``);
  }
  // wrangler dev serves the privacy console from dist/web and refuses to start without it
  await ensureWebBuild();
  // the local D1 state follows the migrations (a no-op when it is current), so a newer migration needs no reseed
  await wrangler(["d1", "migrations", "apply", "pv-control", "--local"], { input: "y\n" });
  startGroup("wrangler-dev", wranglerBin(), wranglerDevArgs(opts.aiMode ?? null), {
    env: wranglerEnv(),
    port: LOCAL_PORTS.worker,
  });
  startGroup("pv-serve", "uv", ["run", "--project", "pipelines", "pv", "serve", ...(opts.executor === false ? ["--no-executor"] : [])], { port: LOCAL_PORTS.shim, cwd: REPO_ROOT });
  const okWorker = await waitForHttp(`http://127.0.0.1:${LOCAL_PORTS.worker}/api/health`, 120000);
  const okShim = await waitForHttp(`http://127.0.0.1:${LOCAL_PORTS.shim}/health`, 120000);
  if (!okWorker || !okShim) {
    await stopAll();
    throw new Error(`local stack did not start (worker ${okWorker}, shim ${okShim}); see ${path.join(".dev", "logs")}`);
  }
}

function aiModeArg(): LocalAiMode | null {
  const i = process.argv.indexOf("--ai-mode");
  if (i < 0) return null;
  const mode = process.argv[i + 1];
  if (!(AI_MODES as readonly string[]).includes(mode ?? "")) throw new Error(`--ai-mode takes ${AI_MODES.join(" or ")}`);
  return mode as LocalAiMode;
}

async function main(): Promise<void> {
  if (process.argv.includes("--detach")) {
    // used by the eval and seed:local: start, wait for health, leave the process groups running, exit
    await startLocalStack({ executor: !process.argv.includes("--no-executor"), aiMode: aiModeArg() });
    console.log("[dev] local stack running (detached); stop it with `npm run stop:local`");
    return;
  }
  await startLocalStack({ aiMode: aiModeArg() });
  console.log(`[dev] console and API http://127.0.0.1:${LOCAL_PORTS.worker} (local sign-in on the console's first page), shim and executor on ${LOCAL_PORTS.shim}. Ctrl+C stops both.`);
  const stop = async () => {
    await stopAll();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
