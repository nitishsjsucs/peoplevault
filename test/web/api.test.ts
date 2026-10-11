// The console's API client: CSRF header on every mutating call (SPEC.md section 11.5), identity lookups only as POST
// bodies, server error codes surfaced, and the windowed audit chain check stitched by anchor hashes.
import { describe, expect, it, vi } from "vitest";
import { ApiError, api, createRequest, getDevPrincipals, getEmployees, identityLookup, verifyChain, type VerifyWindow } from "../../src/web/api.ts";
import { fakeApi, REF, reply } from "./fake-api.ts";

describe("api client", () => {
  it("sends the CSRF header and a JSON body on POST, neither on GET, and always same-origin credentials", async () => {
    const { calls } = fakeApi({ "GET /api/v1/purposes/employee_relations/employees": { rows: [], columns: {}, nextCursor: null }, "POST /api/v1/privacy/deletion-requests": reply(202, { requestId: "r1", status: "received" }) });
    await getEmployees("employee_relations", null);
    await createRequest(REF, "employee asked");
    expect(calls[0]).toMatchObject({ method: "GET", body: undefined });
    expect(calls[0]!.headers["X-PV-Requested-With"]).toBeUndefined();
    expect(calls[1]).toMatchObject({ method: "POST", body: { employee_ref: REF, reason: "employee asked" } });
    expect(calls[1]!.headers).toMatchObject({ "X-PV-Requested-With": "peoplevault", "Content-Type": "application/json" });
    // every call says it comes from the console, so the Worker never fills the KV cache for it
    expect(calls.map((c) => c.headers["X-PV-Client"])).toEqual(["console", "console"]);
    const init = (fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1];
    expect(init.credentials).toBe("same-origin");
  });

  it("puts cursors in the query string, encoded", async () => {
    const { calls } = fakeApi({ "GET /api/v1/purposes/employee_relations/employees": { rows: [], columns: {}, nextCursor: null } });
    await getEmployees("employee_relations", "a b&c");
    expect(calls[0]!.url).toBe("/api/v1/purposes/employee_relations/employees?cursor=a+b%26c");
  });

  it("identity lookup is a POST to the purpose's route; the search text travels only in the body", async () => {
    const { calls } = fakeApi({ "POST /api/v1/purposes/legal_hold_management/identity-lookup": { rows: [] } });
    await identityLookup("legal_hold_management", "sofia.costa");
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/v1/purposes/legal_hold_management/identity-lookup", body: { q: "sofia.costa" } });
    expect(calls[0]!.url).not.toContain("sofia");
  });

  it("turns an error response into an ApiError with the server's code", async () => {
    fakeApi({ "POST /api/v1/privacy/deletion-requests": reply(409, { error: "conflict", code: "active_request_exists" }), "GET /x": reply(500, "not json at all") });
    await expect(createRequest(REF, "again")).rejects.toMatchObject({ name: "ApiError", status: 409, code: "active_request_exists" });
    const e = await api("/x").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(500);
  });

  it("reads a redirect (an expired Access session) as signed out instead of following it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ type: "opaqueredirect", status: 0, ok: false, json: async () => null })));
    await expect(api("/api/v1/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    const init = (fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0]![1];
    expect(init.redirect).toBe("manual");
  });

  it("dev principals are null when /dev/* answers 404 (production), a list locally", async () => {
    fakeApi({});
    expect(await getDevPrincipals()).toBeNull();
    fakeApi({ "GET /dev/principals": { principals: [{ id: "privacy-01", kind: "human", persona: "privacy_officer", status: "active" }] } });
    expect(await getDevPrincipals()).toHaveLength(1);
  });
});

const GENESIS = "0".repeat(64);
function win(afterSeq: number, anchorHash: string, rows: number, lastHash: string, complete: boolean, extra: Partial<VerifyWindow> = {}): VerifyWindow {
  return { ok: true, afterSeq, anchorHash, from: rows ? afterSeq + 1 : null, to: rows ? afterSeq + rows : null, lastHash, nextAfterSeq: afterSeq + rows, complete, checked: rows, ...extra };
}

describe("verifyChain: one 100-event window per request (SPEC.md section 30.3.2)", () => {
  it("follows nextAfterSeq until complete and reports the events checked", async () => {
    const windows = [win(0, GENESIS, 100, "h100", false), win(100, "h100", 100, "h200", false), win(200, "h200", 7, "h207", true)];
    const seen: number[] = [];
    const progress: number[] = [];
    const r = await verifyChain(
      (checked) => progress.push(checked),
      async (after) => {
        seen.push(after);
        return windows.shift()!;
      },
    );
    expect(seen).toEqual([0, 100, 200]);
    expect(progress).toEqual([100, 200, 207]);
    expect(r).toEqual({ ok: true, checked: 207, windows: 3, lastHash: "h207", brokenAtSeq: null, reason: "intact" });
  });

  it("fails when a window does not start on the previous window's last hash", async () => {
    const windows = [win(0, GENESIS, 100, "h100", false), win(100, "forged", 100, "h200", true)];
    const r = await verifyChain(undefined, async () => windows.shift()!);
    expect(r).toMatchObject({ ok: false, reason: "anchor_mismatch", brokenAtSeq: 100, checked: 100 });
  });

  it("fails on a hash mismatch inside a window and names the seq", async () => {
    const windows = [win(0, GENESIS, 100, "h100", false), win(100, "h100", 41, "h141", true, { ok: false, brokenAtSeq: 142 })];
    const r = await verifyChain(undefined, async () => windows.shift()!);
    expect(r).toMatchObject({ ok: false, reason: "hash_mismatch", brokenAtSeq: 142, checked: 141 });
  });

  it("stops when the server does not advance", async () => {
    const r = await verifyChain(undefined, async () => win(0, GENESIS, 0, GENESIS, false));
    expect(r).toMatchObject({ ok: false, reason: "no_progress" });
  });

  it("an empty log is intact", async () => {
    expect(await verifyChain(undefined, async () => win(0, GENESIS, 0, GENESIS, true))).toMatchObject({ ok: true, checked: 0, windows: 1 });
  });
});
