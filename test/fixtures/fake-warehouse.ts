// In-memory WarehouseClient over data/fixtures/purpose_rows.json (rows produced by the real DuckDB purpose views for
// world.yaml). Applies each compiled named query's filters, paging, ordering, limit and output columns.
import purposeRows from "../../data/fixtures/purpose_rows.json";
import type { Purpose } from "../../src/shared/policy-types.ts";
import { POLICY } from "../../src/worker/policy/compiled.ts";
import { WarehouseError, type QueryParams, type WarehouseClient, type WarehouseResult } from "../../src/worker/warehouse/client.ts";

type Row = Record<string, unknown>;
const VIEWS = (purposeRows as unknown as { views: Record<string, Row[]> }).views;

export interface FakeWarehouse extends WarehouseClient {
  calls: { queryId: string; purpose: Purpose; params: QueryParams }[];
}

export interface FakeOptions {
  /** Extra columns added to every returned row (to prove the Worker drops columns the warehouse should not return). */
  extraColumns?: Row;
  /** Replaces the rows of a view. */
  views?: Record<string, Row[]>;
}

const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

export function createFakeWarehouse(opts: FakeOptions = {}): FakeWarehouse {
  const calls: FakeWarehouse["calls"] = [];
  return {
    calls,
    async run(queryId: string, purpose: Purpose, params: QueryParams): Promise<WarehouseResult> {
      calls.push({ queryId, purpose, params });
      const q = POLICY.queries[queryId];
      if (!q || q.purpose !== purpose) throw new WarehouseError("purpose_dataset_denied");
      for (const name of Object.keys(q.params)) if (!(name in params)) throw new WarehouseError("bad_params");
      let rows = [...((opts.views ?? VIEWS)[`${purpose}.${q.view}`] ?? [])];
      for (const f of q.filters) {
        const v = params[f.param];
        if (f.op === "eq") rows = rows.filter((r) => r[f.column!] === v);
        else if (f.op === "in_array") rows = rows.filter((r) => (v as string[]).includes(String(r[f.column!])));
        else rows = rows.filter((r) => (f.columns ?? []).some((col) => String(r[col] ?? "").toLowerCase().startsWith(String(v).toLowerCase())));
      }
      const order = q.orderBy ?? [];
      rows.sort((a, b) => {
        for (const col of order) {
          const d = cmp(a[col], b[col]);
          if (d !== 0) return d;
        }
        return 0;
      });
      if (q.pagedBy) {
        const cursor = String(params.cursor ?? "");
        rows = rows.filter((r) => cursor === "" || String(r[q.pagedBy!]) > cursor).slice(0, Number(params.limit));
      }
      if (q.limit) rows = rows.slice(0, q.limit);
      const out = rows.map((r) => ({ ...Object.fromEntries(q.columns.map((c) => [c.name, r[c.name] ?? null])), ...(opts.extraColumns ?? {}) }));
      return { rows: out, backend: "fake" };
    },
  };
}
