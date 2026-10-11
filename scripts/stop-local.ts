// npm run stop:local: stops every process group recorded in .dev/pids/, then confirms that 8793, 9243, 8893 and 8170
// refuse TCP connections (no lsof, same on macOS and Linux). Exit 1 if a port is still open.
import { LOCAL_PORTS, portOpen, stopAll } from "./lib/pids.ts";

async function main(): Promise<void> {
  const stopped = await stopAll();
  console.log(`[stop:local] stopped: ${stopped.length ? stopped.join(", ") : "nothing running"}`);
  const open: string[] = [];
  for (const [name, port] of Object.entries(LOCAL_PORTS)) if (await portOpen(port)) open.push(`${name}:${port}`);
  if (open.length) {
    console.error(`[stop:local] still listening: ${open.join(", ")} (not started by this repo's launchers, or still shutting down)`);
    process.exit(1);
  }
  console.log("[stop:local] ports 8793, 9243, 8893 and 8170 refuse connections");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
