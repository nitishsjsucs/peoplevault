// npm run dev: starts wrangler dev (8793, inspector 9243) and pv serve (shim 8893 + executor loop) as detached process
// groups with pidfiles, waits for both, and stops both on exit (Ctrl+C). Logs: .dev/logs/.
import path from "node:path";
import { LOCAL_PORTS, portOpen, startGroup, stopAll, waitForHttp } from "./lib/pids.ts";
import { REPO_ROOT, wranglerBin, wranglerEnv } from "./lib/run.ts";

export async function startLocalStack(opts: { executor?: boolean } = {}): Promise<void> {
  for (const [name, port] of Object.entries({ worker: LOCAL_PORTS.worker, inspector: LOCAL_PORTS.inspector, shim: LOCAL_PORTS.shim })) {
    if (await portOpen(port)) throw new Error(`port ${port} (${name}) is already in use; run \`npm run stop:local\``);
  }
  startGroup("wrangler-dev", wranglerBin(), ["dev", "--port", String(LOCAL_PORTS.worker), "--inspector-port", String(LOCAL_PORTS.inspector), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"], {
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

async function main(): Promise<void> {
  if (process.argv.includes("--detach")) {
    // used by the eval and seed:local: start, wait for health, leave the process groups running, exit
    await startLocalStack({ executor: !process.argv.includes("--no-executor") });
    console.log("[dev] local stack running (detached); stop it with `npm run stop:local`");
    return;
  }
  await startLocalStack();
  console.log(`[dev] Worker http://127.0.0.1:${LOCAL_PORTS.worker} (local dev login: /dev/login?principal=privacy-01), shim and executor on ${LOCAL_PORTS.shim}. Ctrl+C stops both.`);
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
