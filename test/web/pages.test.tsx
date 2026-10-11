// Console pages against a fake Worker API: purpose-scoped tables with masked columns labeled, the identity lookup kept
// out of URLs and off the screen after use, holds, the coverage report and the audit chain check.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/web/App.tsx";
import { windowOf } from "../../src/web/pages/ReportPage.tsx";
import { fakeApi, REF, REF2, reply, signedIn, SUBJECT } from "./fake-api.ts";

function at(path: string) {
  window.history.pushState(null, "", path);
  return render(<App />);
}

const AN = `an_${"q".repeat(26)}`;
const AN2 = `an_${"r".repeat(26)}`;

describe("employee browser", () => {
  const columns = { analytics_id: "allow", org_unit: "allow", birth_date: "mask_date_year", gender: "allow" };
  const page1 = { rows: [{ analytics_id: AN, org_unit: "ENG-PRODUCT", birth_date: "1990-01-01", gender: "F" }], columns, nextCursor: AN };
  const page2 = { rows: [{ analytics_id: AN2, org_unit: "SALES-NA", birth_date: "1985-01-01", gender: "M" }], columns, nextCursor: null };

  it("labels masked columns, pages by cursor and links rows to profiles by pseudonymous ref", async () => {
    const { calls } = fakeApi({
      ...signedIn("people_analyst", "analyst-01"),
      "GET /api/v1/purposes/workforce_analytics/employees": page1,
      [`GET /api/v1/purposes/workforce_analytics/employees?cursor=${AN}`]: page2,
      [`GET /api/v1/purposes/workforce_analytics/employees/${AN2}`]: { profile: { analytics_id: AN2, org_unit: "SALES-NA", birth_date: "1985-01-01" }, columns: { analytics_id: "allow", org_unit: "allow", birth_date: "mask_date_year" } },
    });
    at("/purposes/workforce_analytics/employees");
    expect(await screen.findByText("ENG-PRODUCT")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /birth_date/ }).textContent).toBe("birth_dateyear only");
    expect(screen.getByText("1990")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("SALES-NA")).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain(`/api/v1/purposes/workforce_analytics/employees?cursor=${AN}`);
    fireEvent.click(screen.getByRole("link", { name: AN2 }));
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/purposes/workforce_analytics/employees/${AN2}`);
    expect(await screen.findByText("1985")).toBeTruthy();
  });

  it("shows masked values as hidden, never as an empty field", async () => {
    fakeApi({
      ...signedIn("manager", "mgr-001"),
      [`GET /api/v1/purposes/team_management/employees/${REF}`]: { profile: { employee_ref: REF, full_name: "Ana Lima", base_salary: null }, columns: { employee_ref: "allow", full_name: "allow", base_salary: "mask_nullify", review_text: "allow" } },
    });
    at(`/purposes/team_management/employees/${REF}`);
    const term = await screen.findByText("base_salary");
    const field = term.closest("div")!;
    expect(within(field).getByText("masked")).toBeTruthy();
    expect(within(field).getByText("hidden")).toBeTruthy();
    // a column the Worker did not return is not invented
    expect(screen.queryByText("review_text")).toBeNull();
  });

  it("a 404 profile reads as not found or outside scope (no existence oracle)", async () => {
    fakeApi(signedIn("hr_partner", "hrbp-01"));
    at(`/purposes/employee_relations/employees/${REF}`);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Not found, or outside your scope.");
  });
});

const LOOKUP_ROW = { employee_ref: REF, full_name: "Sofia Costa", work_email: "sofia.costa@peoplevault.test", org_unit: "PEOPLE", employment_status: "active" };
const REQUEST = { id: "req-1", kind: "dsr", subjectRef: SUBJECT, status: "failed", requestedBy: "privacy-01", workflowInstanceId: "req-1", createdAt: "2026-10-11T08:00:00.000Z", completedAt: "2026-10-11T08:01:00.000Z", admittedAt: "2026-10-11T08:00:00.000Z", summary: { coverage: 1 } };

describe("deletion requests", () => {
  it("looks a person up by POST, files the request by employee_ref, and clears the names from the screen", async () => {
    const { calls } = fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/deletion-requests": { requests: [] },
      "POST /api/v1/purposes/privacy_compliance/identity-lookup": { rows: [LOOKUP_ROW], columns: {} },
      "POST /api/v1/privacy/deletion-requests": reply(202, { requestId: "req-9", status: "received", deferred: true }),
    });
    at("/privacy/requests");
    const input = await screen.findByLabelText(/Find a person/);
    expect(input.getAttribute("name")).toBeNull();
    fireEvent.change(input, { target: { value: "sofia" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("Sofia Costa")).toBeTruthy();
    const lookup = calls.find((c) => c.path.endsWith("/identity-lookup"))!;
    expect(lookup).toMatchObject({ method: "POST", body: { q: "sofia" } });
    expect(lookup.headers["X-PV-Requested-With"]).toBe("peoplevault");
    expect(calls.every((c) => !c.url.includes("sofia"))).toBe(true);
    expect(window.location.href).not.toContain("sofia");

    fireEvent.click(screen.getByRole("button", { name: "Request deletion" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "employee asked to be forgotten" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm request deletion" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringMatching(/req-9 received\. Today's deletion starts are used up/));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/privacy/deletion-requests")!.body).toEqual({ employee_ref: REF, reason: "employee asked to be forgotten" });
    await waitFor(() => expect(screen.queryByText("Sofia Costa")).toBeNull());
    expect((screen.getByLabelText(/Find a person/) as HTMLInputElement).value).toBe("");
  });

  it("explains a refused request", async () => {
    fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/deletion-requests": { requests: [] },
      "POST /api/v1/purposes/privacy_compliance/identity-lookup": { rows: [LOOKUP_ROW], columns: {} },
      "POST /api/v1/privacy/deletion-requests": reply(409, { error: "conflict", code: "active_request_exists" }),
    });
    at("/privacy/requests");
    fireEvent.change(await screen.findByLabelText(/Find a person/), { target: { value: "sofia" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Request deletion" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm request deletion" }));
    expect(await screen.findByText("This person already has an open deletion request.")).toBeTruthy();
  });

  it("lists requests and filters by status", async () => {
    const { calls } = fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/deletion-requests": { requests: [REQUEST, { ...REQUEST, id: "req-2", status: "completed" }] },
      "GET /api/v1/privacy/deletion-requests?status=failed": { requests: [REQUEST] },
    });
    at("/privacy/requests");
    expect(await screen.findByRole("link", { name: "req-2" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
    await waitFor(() => expect(screen.queryByRole("link", { name: "req-2" })).toBeNull());
    expect(calls.map((c) => c.url)).toContain("/api/v1/privacy/deletion-requests?status=failed");
  });

  it("shows per-asset results and residuals, the receipt with its audit hash, and retries a failed request", async () => {
    let status = "failed";
    const { calls } = fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/deletion-requests/req-1": () => ({
        request: { ...REQUEST, status },
        assets: [{ asset_id: "src.r2.exports", category: "source_exports", applicability: "present", rows_before: 12, rows_erased: 12, references_scrubbed: 0, action_status: "erased", verify_status: "residue", verify_matches: 1, verified_at: null }],
        residuals: [{ id: "res-1", asset_id: "wh.bq.core", kind: "bq_time_travel", state: "pending", evidence: "observed", expected_clear_at: "2026-10-13T08:00:00Z", cleared_at: null }],
      }),
      "GET /api/v1/privacy/deletion-requests/req-1/receipt": { receipt: { request_id: "req-1", coverage: 1 }, audit: { seq: 4321, hash: "ab".repeat(32) } },
      "POST /api/v1/privacy/deletion-requests/req-1/retry": () => {
        status = "received";
        return reply(202, { requestId: "req-1", instanceId: "req-1-r1", status: "received" });
      },
    });
    at("/privacy/requests/req-1");
    expect(await screen.findByText("src.r2.exports")).toBeTruthy();
    expect(screen.getByText("bq time travel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show receipt" }));
    expect(await screen.findByText(`Audit event 4321, hash ${"ab".repeat(32)}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Retry started as req-1-r1.")).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith("/retry"))!.headers["X-PV-Requested-With"]).toBe("peoplevault");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  });
});

describe("legal holds", () => {
  const HOLD = { id: "h1", matterId: "LH-2026-001", subjectRef: SUBJECT, placedBy: "privacy-01", placedAt: "2026-10-11T08:00:00Z", releasedAt: null, releasedBy: null };

  it("places a hold by employee_ref with a matter id, and refuses a malformed matter id before calling", async () => {
    const { calls } = fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/legal-holds": { holds: [] },
      "POST /api/v1/purposes/legal_hold_management/identity-lookup": { rows: [{ ...LOOKUP_ROW, employee_ref: REF2 }], columns: {} },
      "POST /api/v1/privacy/legal-holds": reply(201, { hold: HOLD }),
    });
    at("/privacy/holds");
    fireEvent.change(await screen.findByLabelText(/Find a person/), { target: { value: "sofia" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Place hold" }));
    fireEvent.change(screen.getByLabelText(/Matter id/), { target: { value: "lh-26-1" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "litigation" } });
    fireEvent.submit(screen.getByRole("button", { name: "Confirm place hold" }).closest("form")!);
    expect(await screen.findByText("The matter id must look like LH-2026-001.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/privacy/legal-holds")).toBe(false);
    fireEvent.change(screen.getByLabelText(/Matter id/), { target: { value: "lh-2026-001" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm place hold" }));
    expect(await screen.findByText("Hold LH-2026-001 placed.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/privacy/legal-holds")!.body).toEqual({ matter_id: "LH-2026-001", employee_ref: REF2, reason: "litigation" });
  });

  it("releases a hold and reports resubmitted and deferred requests", async () => {
    const { calls } = fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/legal-holds": { holds: [HOLD, { ...HOLD, id: "h0", matterId: "LH-2026-002", releasedAt: "2026-10-10T00:00:00Z" }] },
      "POST /api/v1/privacy/legal-holds/h1/release": { hold: { ...HOLD, releasedAt: "2026-10-11T09:00:00Z" }, resubmitted: ["req-3"], deferred: ["req-4"], remainingHolds: 0 },
    });
    at("/privacy/holds");
    const buttons = await screen.findAllByRole("button", { name: "Release" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(await screen.findByText(/1 held request\(s\) resubmitted, 1 deferred to the daily reconcile/)).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/v1/privacy/legal-holds/h1/release")).toMatchObject({ method: "POST" });
  });
});

describe("coverage report", () => {
  const cov = (clean: number, applicable: number) => (applicable ? { value: clean / applicable, display: `${((100 * clean) / applicable).toFixed(1)}%`, applicablePairs: applicable, cleanPairs: clean } : { value: null, display: "n/a", applicablePairs: 0, cleanPairs: 0 });
  const report = (failures: { requestId: string; assetId: string; findings: unknown }[], cursor: string | null) => ({
    window: { from: null, to: null },
    requests: { total: 3, byStatus: { completed: 2, failed: 1 } },
    coverage: cov(25, 26),
    byCategory: { source_exports: { ...cov(5, 6), notPresent: 0, aggregateRecompute: 0 }, derived_datasets: { ...cov(0, 0), notPresent: 3, aggregateRecompute: 3 } },
    held: { requests: 0, assetPairs: 0 },
    aggregateRecompute: { recomputed: 3, notRecomputed: 0 },
    residuals: [{ kind: "bq_time_travel", state: "pending", evidence: "observed", n: 2 }],
    failures,
    failuresCursor: cursor,
  });

  it("shows coverage with its denominator, n/a for a category without applicable pairs, and pages failures", async () => {
    const { calls } = fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/reports/deletion": report([{ requestId: "req-1", assetId: "src.r2.exports", findings: { matches: 1 } }], "CUR1"),
      "GET /api/v1/privacy/reports/deletion?cursor=CUR1": report([{ requestId: "req-1", assetId: "wh.bq.core", findings: { matches: 2 } }], null),
    });
    at("/privacy/report");
    expect(await screen.findByText("96.2%")).toBeTruthy();
    expect(screen.getByText(/25 of 26 applicable asset pairs/)).toBeTruthy();
    const row = screen.getByRole("row", { name: /derived datasets/ });
    expect(within(row).getByText("n/a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More failures" }));
    expect(await screen.findByText("wh.bq.core")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More failures" })).toBeNull();
    expect(calls.map((c) => c.url)).toContain("/api/v1/privacy/reports/deletion?cursor=CUR1");
  });

  it("a picked day covers the whole UTC day", () => {
    expect(windowOf({ from: "2026-10-01", to: "2026-10-11" })).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-11T23:59:59.999Z"]);
    expect(windowOf({ from: "", to: "" })).toEqual([null, null]);
  });
});

describe("audit log", () => {
  const EVENT = { seq: 1, ts: "2026-10-11T08:00:00Z", actor: "privacy-01", actor_kind: "human", persona: "privacy_officer", purpose: "privacy_compliance", action: "read_audit", route: "/api/v1/privacy/audit", subject_ref: null, request_id: null, decision: "allow", reason: "ok", row_count: 0, hash: "h1" };

  it("verifies the chain window by window and shows the result", async () => {
    const { calls } = fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/audit": { events: [EVENT], cursor: null },
      "GET /api/v1/privacy/audit/verify?after_seq=0&limit=100": { ok: true, afterSeq: 0, anchorHash: "0".repeat(64), from: 1, to: 100, lastHash: "h100", nextAfterSeq: 100, complete: false, checked: 100 },
      "GET /api/v1/privacy/audit/verify?after_seq=100&limit=100": { ok: true, afterSeq: 100, anchorHash: "h100", from: 101, to: 150, lastHash: "h150", nextAfterSeq: 150, complete: true, checked: 50 },
    });
    at("/privacy/audit");
    expect(await screen.findByText("read_audit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Verify the hash chain" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Chain intact: 150 events in 2 windows, last hash h150.");
    expect(calls.filter((c) => c.path === "/api/v1/privacy/audit/verify")).toHaveLength(2);
  });

  it("reports a broken chain", async () => {
    fakeApi({
      ...signedIn("privacy_officer"),
      "GET /api/v1/privacy/audit": { events: [EVENT], cursor: 1 },
      "GET /api/v1/privacy/audit/verify": { ok: false, afterSeq: 0, anchorHash: "0".repeat(64), from: 1, to: 7, lastHash: "h6", nextAfterSeq: 7, complete: true, checked: 6, brokenAtSeq: 7 },
    });
    at("/privacy/audit");
    fireEvent.click(await screen.findByRole("button", { name: "Verify the hash chain" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Chain broken at seq 7: an event's hash does not chain (6 events checked).");
    expect(screen.getByRole("button", { name: "Next events" })).toBeTruthy();
  });
});
