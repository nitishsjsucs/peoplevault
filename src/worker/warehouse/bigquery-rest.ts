// BigQuery REST client for the purpose data API (SPEC.md section 11.4). Runs the generated named-query SQL as the
// purpose's own service account with named parameters and useQueryCache=false (cached results can expose data after
// a policy change). jobs.query may return jobComplete=false; the client polls getQueryResults until complete and
// through its pages, then normalizes the string-encoded f/v rows to the same typed shape the shim returns.
// Workers Free (SPEC.md section 30.3.2): at most 20 polls and 10 result pages, so one data request makes at most
// 1 JWKS + 2 token + 1 query + 20 + 9 = 33 external fetches (Free allows 50), and every query is byte-capped with
// maximumBytesBilled (100 MiB; a capped query fails without being billed).
import type { Purpose } from "../../shared/policy-types.ts";
import type { PurposeSaMap } from "../env.ts";
import { POLICY } from "../policy/compiled.ts";
import { WarehouseError, type QueryParams, type WarehouseClient, type WarehouseResult } from "./client.ts";
import type { GcpTokenSource } from "./gcp-auth.ts";

export interface BqField {
  name: string;
  type: string;
  mode?: "NULLABLE" | "REQUIRED" | "REPEATED";
  fields?: BqField[];
}
export interface BqSchema {
  fields: BqField[];
}
export interface BqCell {
  v: unknown;
}
export interface BqRow {
  f: BqCell[];
}

interface QueryResponse {
  jobComplete: boolean;
  jobReference: { projectId: string; jobId: string; location?: string };
  schema?: BqSchema;
  rows?: BqRow[];
  pageToken?: string;
  totalBytesProcessed?: string;
  errors?: { reason: string; message: string }[];
}

const BASE = "https://bigquery.googleapis.com/bigquery/v2";
export const MAX_POLLS = 20;
/** Result pages per query, the first included. */
export const MAX_PAGES = 10;
/** 100 MiB: a purpose query references at most 3 small tables (SPEC.md section 30.3.2). */
export const MAXIMUM_BYTES_BILLED = "104857600";

function scalar(type: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const s = String(v);
  switch (type) {
    case "INTEGER":
    case "INT64":
      return Number.parseInt(s, 10);
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return Number.parseFloat(s);
    case "BOOLEAN":
    case "BOOL":
      return s === "true";
    case "TIMESTAMP": {
      // jobs.query encodes TIMESTAMP as floating point seconds since the epoch
      const ms = Math.round(Number.parseFloat(s) * 1000);
      return new Date(ms).toISOString();
    }
    default:
      return s; // STRING, DATE (YYYY-MM-DD), DATETIME, TIME, BYTES (base64)
  }
}

function cell(field: BqField, v: unknown): unknown {
  if (field.mode === "REPEATED") {
    if (!Array.isArray(v)) return [];
    return v.map((item) => cell({ ...field, mode: "NULLABLE" }, (item as BqCell).v));
  }
  if (field.type === "RECORD" || field.type === "STRUCT") {
    if (v === null || v === undefined) return null;
    const inner = (v as BqRow).f;
    return Object.fromEntries((field.fields ?? []).map((f, i) => [f.name, cell(f, inner[i]?.v)]));
  }
  return scalar(field.type, v);
}

/** Converts BigQuery f/v rows into plain objects typed like the shim's rows. */
export function normalizeRows(schema: BqSchema, rows: BqRow[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(schema.fields.map((field, i) => [field.name, cell(field, row.f[i]?.v)])));
}

export function classifyBigQueryError(status: number, body: unknown): WarehouseError {
  const reason = ((body as { error?: { errors?: { reason?: string }[] } })?.error?.errors?.[0]?.reason ?? "") as string;
  if (reason === "bytesBilledLimitExceeded") return new WarehouseError("bytes_billed_limit");
  if (status === 403 || reason === "accessDenied") return new WarehouseError("access_denied");
  if (status === 404 || reason === "notFound") return new WarehouseError("not_found");
  if (status === 400 || reason === "invalidQuery" || reason === "invalid") return new WarehouseError("invalid_query");
  if (status === 429 || reason === "rateLimitExceeded") return new WarehouseError("rate_limited", true);
  if (status >= 500 || reason === "backendError") return new WarehouseError("backend_error", true);
  return new WarehouseError(`bigquery_${status}`);
}

function bqParam(name: string, type: string, value: string | number | string[]) {
  if (type === "string_array") {
    return { name, parameterType: { type: "ARRAY", arrayType: { type: "STRING" } }, parameterValue: { arrayValues: (value as string[]).map((v) => ({ value: v })) } };
  }
  const bqType = type === "date" ? "DATE" : type === "int" ? "INT64" : "STRING";
  return { name, parameterType: { type: bqType }, parameterValue: { value: String(value) } };
}

export interface BigQueryClientOptions {
  projectId: string;
  location: string;
  purposeSa: PurposeSaMap;
  tokens: GcpTokenSource;
  fetchImpl?: typeof fetch;
  pollDelayMs?: number;
}

export function buildQueryRequest(queryId: string, purpose: Purpose, params: QueryParams, projectId: string, location: string) {
  const q = POLICY.queries[queryId];
  if (!q || q.purpose !== purpose) throw new WarehouseError("unknown_query");
  const names = Object.keys(q.params);
  if (names.length !== Object.keys(params).length || names.some((n) => !(n in params))) throw new WarehouseError("bad_params");
  return {
    query: q.sql.bigquery.replaceAll("{project}", projectId),
    useLegacySql: false,
    parameterMode: "NAMED",
    queryParameters: names.map((n) => bqParam(n, q.params[n]!, params[n]!)),
    useQueryCache: false,
    maximumBytesBilled: MAXIMUM_BYTES_BILLED,
    location,
    timeoutMs: 10000,
    labels: { app: "peoplevault", purpose },
  };
}

export function createBigQueryClient(opts: BigQueryClientOptions): WarehouseClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delay = opts.pollDelayMs ?? 250;
  return {
    async run(queryId: string, purpose: Purpose, params: QueryParams): Promise<WarehouseResult> {
      const body = buildQueryRequest(queryId, purpose, params, opts.projectId, opts.location);
      const token = await opts.tokens.purposeToken(opts.purposeSa[purpose]);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const first = await fetchImpl(`${BASE}/projects/${opts.projectId}/queries`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!first.ok) throw classifyBigQueryError(first.status, await first.json().catch(() => null));
      let page = (await first.json()) as QueryResponse;
      const job = page.jobReference;
      let polls = 0;
      while (!page.jobComplete) {
        if (++polls > MAX_POLLS) throw new WarehouseError("query_timeout", true);
        await new Promise((r) => setTimeout(r, delay));
        page = await getResults(job, undefined);
      }
      const schema = page.schema ?? { fields: [] };
      const rows = normalizeRows(schema, page.rows ?? []);
      let pageToken = page.pageToken;
      let pages = 1;
      while (pageToken) {
        if (++pages > MAX_PAGES) throw new WarehouseError("result_too_large");
        const next = await getResults(job, pageToken);
        rows.push(...normalizeRows(schema, next.rows ?? []));
        pageToken = next.pageToken;
      }
      const result: WarehouseResult = { rows, backend: "bigquery" };
      if (page.totalBytesProcessed) result.bytesProcessed = Number.parseInt(page.totalBytesProcessed, 10);
      return result;

      async function getResults(j: QueryResponse["jobReference"], token: string | undefined): Promise<QueryResponse> {
        const url = new URL(`${BASE}/projects/${j.projectId}/queries/${j.jobId}`);
        url.searchParams.set("location", j.location ?? opts.location);
        url.searchParams.set("timeoutMs", "10000");
        if (token) url.searchParams.set("pageToken", token);
        const res = await fetchImpl(url.toString(), { headers });
        if (!res.ok) throw classifyBigQueryError(res.status, await res.json().catch(() => null));
        return (await res.json()) as QueryResponse;
      }
    },
  };
}
