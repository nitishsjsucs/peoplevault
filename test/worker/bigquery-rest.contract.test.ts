import { describe, expect, it } from "vitest";
import accessDenied from "../fixtures/contracts/bigquery.error.accessDenied.json";
import page1 from "../fixtures/contracts/bigquery.getQueryResults.page1.json";
import page2 from "../fixtures/contracts/bigquery.getQueryResults.page2.json";
import incomplete from "../fixtures/contracts/bigquery.jobs.query.incomplete.json";
import { POLICY } from "../../src/worker/policy/compiled.ts";
import { buildQueryRequest, classifyBigQueryError, createBigQueryClient, MAX_PAGES, MAX_POLLS, MAXIMUM_BYTES_BILLED, normalizeRows, type BqRow, type BqSchema } from "../../src/worker/warehouse/bigquery-rest.ts";
import { WarehouseError } from "../../src/worker/warehouse/client.ts";

const purposeSa = {
  employee_relations: "pv-er-reader@pv-test.iam.gserviceaccount.com",
  team_management: "pv-tm-reader@pv-test.iam.gserviceaccount.com",
  workforce_analytics: "pv-wa-reader@pv-test.iam.gserviceaccount.com",
  privacy_compliance: "pv-pc-reader@pv-test.iam.gserviceaccount.com",
  legal_hold_management: "pv-lh-reader@pv-test.iam.gserviceaccount.com",
};
const tokens = { gatewayToken: async () => "g", purposeToken: async (sa: string) => `token-for-${sa}` };
const json = (f: { status: number; body: unknown }) => new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": "application/json" } });

describe("BigQuery REST contract (recorded responses)", () => {
  it("polls jobComplete=false, follows pageToken and normalizes rows", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, ...(init ? { init } : {}) });
      if (u.endsWith("/projects/pv-test/queries")) return json(incomplete);
      if (u.includes("pageToken=page-2-token")) return json(page2);
      return json(page1);
    }) as typeof fetch;
    const client = createBigQueryClient({ projectId: "pv-test", location: "US", purposeSa, tokens, fetchImpl, pollDelayMs: 0 });
    const res = await client.run("employee_relations.list", "employee_relations", { org_units: ["ENG-PRODUCT"], cursor: "", limit: 100 });
    expect(res.backend).toBe("bigquery");
    expect(res.rows).toHaveLength(3);
    expect(res.bytesProcessed).toBe(20971520);
    expect(res.rows[0]).toEqual({
      employee_ref: "er_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      rating: 4,
      base_salary: 125000.5,
      is_restricted: false,
      birth_date: "1990-01-01",
      loaded_at: "2026-10-04T16:00:00.000Z",
      org_units: ["ENG-PRODUCT", "SALES-NA"],
      band: { salary_band: "120k_160k", level: 3 },
    });
    expect(res.rows[1]).toEqual({ employee_ref: "er_bbbbbbbbbbbbbbbbbbbbbbbbbb", rating: null, base_salary: null, is_restricted: true, birth_date: null, loaded_at: null, org_units: [], band: null });
    expect(res.rows[2]!.band).toEqual({ salary_band: "80k_120k", level: null });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain("/projects/pv-test/queries/job_contract_001?location=US");
    expect(calls[2]!.url).toContain("pageToken=page-2-token");
    const auth = (calls[0]!.init!.headers as Record<string, string>).authorization;
    expect(auth).toBe("Bearer token-for-pv-er-reader@pv-test.iam.gserviceaccount.com");
  });

  it("sends named parameters, the purpose label and useQueryCache=false", () => {
    const req = buildQueryRequest("employee_relations.profile", "employee_relations", { org_units: ["A", "B"], employee_ref: "er_x" }, "pv-test", "US");
    expect(req.useQueryCache).toBe(false);
    expect(req.useLegacySql).toBe(false);
    expect(req.parameterMode).toBe("NAMED");
    expect(req.labels).toEqual({ app: "peoplevault", purpose: "employee_relations" });
    expect(req.query).toContain("`pv-test.pv_purpose_employee_relations.profile`(@org_units, @employee_ref)");
    expect(req.queryParameters).toEqual([
      { name: "org_units", parameterType: { type: "ARRAY", arrayType: { type: "STRING" } }, parameterValue: { arrayValues: [{ value: "A" }, { value: "B" }] } },
      { name: "employee_ref", parameterType: { type: "STRING" }, parameterValue: { value: "er_x" } },
    ]);
    expect(() => buildQueryRequest("employee_relations.profile", "team_management", { org_units: [], employee_ref: "x" }, "p", "US")).toThrow(WarehouseError);
    expect(() => buildQueryRequest("employee_relations.profile", "employee_relations", { org_units: [] }, "p", "US")).toThrow(/bad_params/);
  });

  it("classifies errors", async () => {
    expect(classifyBigQueryError(403, accessDenied.body).code).toBe("access_denied");
    expect(classifyBigQueryError(404, {}).code).toBe("not_found");
    expect(classifyBigQueryError(400, {}).code).toBe("invalid_query");
    const e = classifyBigQueryError(503, {});
    expect([e.code, e.retryable]).toEqual(["backend_error", true]);
    const fetchImpl = (async () => json(accessDenied)) as typeof fetch;
    const client = createBigQueryClient({ projectId: "pv-test", location: "US", purposeSa, tokens, fetchImpl });
    await expect(client.run("workforce_analytics.headcount_monthly", "workforce_analytics", {})).rejects.toMatchObject({ code: "access_denied" });
  });

  it("normalizes an empty result", () => {
    expect(normalizeRows({ fields: [] } as BqSchema, [] as BqRow[])).toEqual([]);
  });
});

describe("BigQuery REST client on Workers Free (SPEC.md section 30.3.2)", () => {
  it("every jobs.query body carries maximumBytesBilled of 100 MiB", () => {
    for (const [id, q] of Object.entries(POLICY.queries)) {
      const params = Object.fromEntries(Object.entries(q.params).map(([n, t]) => [n, t === "string_array" ? ["A"] : t === "int" ? 1 : t === "date" ? "2026-01-01" : "x"]));
      const req = buildQueryRequest(id, q.purpose, params, "pv-test", "US");
      expect(req.maximumBytesBilled, id).toBe("104857600");
      expect(MAXIMUM_BYTES_BILLED).toBe(String(100 * 1024 * 1024));
    }
  });

  it("gives up after 20 polls and 10 pages, so a data request stays within 34 external fetches", async () => {
    expect([MAX_POLLS, MAX_PAGES]).toEqual([20, 10]);
    let fetches = 0;
    const neverDone = (async (url: string | URL | Request) => {
      fetches++;
      const u = String(url);
      return json({ status: 200, body: { ...incomplete.body, ...(u.endsWith("/queries") ? {} : { jobComplete: false }) } });
    }) as typeof fetch;
    const client = createBigQueryClient({ projectId: "pv-test", location: "US", purposeSa, tokens, fetchImpl: neverDone, pollDelayMs: 0 });
    await expect(client.run("workforce_analytics.headcount_monthly", "workforce_analytics", {})).rejects.toMatchObject({ code: "query_timeout" });
    expect(fetches).toBe(1 + MAX_POLLS);

    fetches = 0;
    const endlessPages = (async (url: string | URL | Request) => {
      fetches++;
      const u = String(url);
      const base = page1.body as Record<string, unknown>;
      return json({ status: 200, body: { ...base, jobComplete: true, pageToken: u.endsWith("/queries") ? "t0" : `t${fetches}` } });
    }) as typeof fetch;
    const paged = createBigQueryClient({ projectId: "pv-test", location: "US", purposeSa, tokens, fetchImpl: endlessPages, pollDelayMs: 0 });
    await expect(paged.run("workforce_analytics.headcount_monthly", "workforce_analytics", {})).rejects.toMatchObject({ code: "result_too_large" });
    expect(fetches).toBe(MAX_PAGES);
    // 1 JWKS (cold isolate) + 2 token calls (gateway assertion, generateAccessToken) + 1 query + polls + further pages
    expect(1 + 2 + 1 + MAX_POLLS + (MAX_PAGES - 1)).toBeLessThanOrEqual(34);
  });

  it("classifies a byte-capped query as bytes_billed_limit", () => {
    expect(classifyBigQueryError(400, { error: { errors: [{ reason: "bytesBilledLimitExceeded" }] } }).code).toBe("bytes_billed_limit");
  });
});
