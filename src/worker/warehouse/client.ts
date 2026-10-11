// Warehouse clients behind one interface (SPEC.md section 12.1): BigQuery REST as the purpose's identity in
// production, the local DuckDB shim in development, and an in-memory fake in tests.
import type { Purpose } from "../../shared/policy-types.ts";
import type { Config } from "../env.ts";
import { createBigQueryClient } from "./bigquery-rest.ts";
import { createGcpTokenSource } from "./gcp-auth.ts";
import { createShimClient } from "./shim-client.ts";

export type QueryId = string;
export type QueryParams = Record<string, string | number | string[]>;

export interface WarehouseResult {
  rows: Record<string, unknown>[];
  backend: "bigquery" | "duckdb-shim" | "fake";
  bytesProcessed?: number;
}

export interface WarehouseClient {
  run(queryId: QueryId, purpose: Purpose, params: QueryParams): Promise<WarehouseResult>;
}

export class WarehouseError extends Error {
  override name = "WarehouseError";
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

export type WarehouseFactory = (env: Env, cfg: Config) => WarehouseClient;

export function createWarehouseClient(env: Env, cfg: Config, fetchImpl: typeof fetch = fetch): WarehouseClient {
  if (cfg.warehouseMode === "bigquery" && cfg.bigquery) {
    const tokens = createGcpTokenSource(cfg.bigquery.gatewayKeyJson, fetchImpl);
    return createBigQueryClient({ projectId: cfg.bigquery.projectId, location: cfg.bigquery.location, purposeSa: cfg.bigquery.purposeSa, tokens, fetchImpl });
  }
  if (!cfg.shim) throw new WarehouseError("warehouse_not_configured");
  return createShimClient(cfg.shim.url, cfg.shim.token, fetchImpl);
}
