// Local development client for the DuckDB warehouse shim (pv serve on 127.0.0.1:8893).
import type { Purpose } from "../../shared/policy-types.ts";
import { WarehouseError, type QueryParams, type WarehouseClient, type WarehouseResult } from "./client.ts";

// Every shim query is a read, so a connection-level failure (the request never got an HTTP response) is retried once
// after a short pause; an HTTP error response is never retried. Seen once in a full local eval: a 502
// `shim_unreachable` on an extract query while the shim was otherwise answering.
export const SHIM_RETRY_DELAY_MS = 250;

export function createShimClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch, retryDelayMs = SHIM_RETRY_DELAY_MS): WarehouseClient {
  return {
    async run(queryId: string, purpose: Purpose, params: QueryParams): Promise<WarehouseResult> {
      const send = () =>
        fetchImpl(`${baseUrl}/v1/query`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-PV-Shim-Token": token },
          body: JSON.stringify({ purpose, query_id: queryId, params }),
        });
      let res: Response;
      try {
        res = await send();
      } catch {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        try {
          res = await send();
        } catch {
          throw new WarehouseError("shim_unreachable", true);
        }
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
