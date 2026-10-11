// Port probes used by doctor, dev and stop-local: a TCP connect, no lsof, same on macOS and Linux.
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
});
