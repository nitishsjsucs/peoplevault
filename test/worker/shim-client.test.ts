import { describe, expect, it } from "vitest";
import { createShimClient } from "../../src/worker/warehouse/shim-client.ts";
import { WarehouseError } from "../../src/worker/warehouse/client.ts";

const ok = () => new Response(JSON.stringify({ rows: [{ n: 1 }], backend: "duckdb-shim" }), { status: 200 });

describe("local shim client", () => {
  it("retries a connection-level failure once, then answers", async () => {
    let calls = 0;
    const client = createShimClient("http://127.0.0.1:8893", "t", (async () => {
      calls++;
      if (calls === 1) throw new TypeError("Network connection lost.");
      return ok();
    }) as typeof fetch, 0);
    expect((await client.run("attrition_features", "workforce_analytics", { month: "2026-09" })).rows).toEqual([{ n: 1 }]);
    expect(calls).toBe(2);
  });

  it("gives up after the second connection failure with shim_unreachable", async () => {
    let calls = 0;
    const client = createShimClient("http://127.0.0.1:8893", "t", (async () => {
      calls++;
      throw new TypeError("connection refused");
    }) as typeof fetch, 0);
    const err = await client.run("attrition_features", "workforce_analytics", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WarehouseError);
    expect((err as WarehouseError).message).toContain("shim_unreachable");
    expect(calls).toBe(2);
  });

  it("never retries an HTTP error response", async () => {
    let calls = 0;
    const client = createShimClient("http://127.0.0.1:8893", "t", (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "query_failed" }), { status: 500 });
    }) as typeof fetch, 0);
    const err = await client.run("attrition_features", "workforce_analytics", {}).catch((e: unknown) => e);
    expect((err as WarehouseError).message).toContain("query_failed");
    expect(calls).toBe(1);
  });
});
