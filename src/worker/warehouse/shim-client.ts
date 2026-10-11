// Local development client for the DuckDB warehouse shim (pv serve on 127.0.0.1:8893).
import type { Purpose } from "../../shared/policy-types.ts";
import { WarehouseError, type QueryParams, type WarehouseClient, type WarehouseResult } from "./client.ts";

export function createShimClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): WarehouseClient {
  return {
    async run(queryId: string, purpose: Purpose, params: QueryParams): Promise<WarehouseResult> {
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/v1/query`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-PV-Shim-Token": token },
          body: JSON.stringify({ purpose, query_id: queryId, params }),
        });
      } catch {
        throw new WarehouseError("shim_unreachable", true);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new WarehouseError(body.error ?? `shim_http_${res.status}`, res.status >= 500);
      }
      const body = (await res.json()) as { rows: Record<string, unknown>[] };
      return { rows: body.rows, backend: "duckdb-shim" };
    },
  };
}
