// Port probes used by doctor, dev and stop-local: a TCP connect, no lsof, same on macOS and Linux. And the wait that keeps
// npm run dev and npm run llm:serve in the foreground until Ctrl+C.
import { spawn } from "node:child_process";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { LOCAL_PORTS, portOpen } from "../../scripts/lib/pids.ts";

describe("pids", () => {
  it("portOpen is true while something listens and false after it closes", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    expect(await portOpen(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await portOpen(port)).toBe(false);
  });

  it("uses the ports assigned to this repository", () => {
    expect({ worker: LOCAL_PORTS.worker, inspector: LOCAL_PORTS.inspector, llm: LOCAL_PORTS.llm }).toEqual({ worker: 8793, inspector: 9243, llm: 8170 });
  });

  it("waitForSignal keeps a foreground script running until its signal handler exits it", async () => {
    // A bare `await new Promise(() => {})` with only unref'd children lets Node exit at once with code 13, so
    // `npm run dev` returned with the stack still running and Ctrl+C had nothing to stop.
    const pids = new URL("../../scripts/lib/pids.ts", import.meta.url).href;
    const code = `import { waitForSignal } from ${JSON.stringify(pids)};
process.on("SIGTERM", () => process.exit(0));
console.log("ready");
await waitForSignal();`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });
});
