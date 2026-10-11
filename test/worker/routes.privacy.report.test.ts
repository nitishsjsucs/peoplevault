// The deletion report computed in SQL (SPEC.md sections 18.5 and 30.3.2) equals the revision 2 JavaScript report (kept
// verbatim below as the reference) over a seeded multi-request state with every applicability, verdict, status and
// residual kind, for the whole window and for a date window; failures are paged at 100 with a cursor.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { isApplicable, perCategory, type AssetResultRow } from "../../src/worker/audit/receipts.ts";
import { POLICY } from "../../src/worker/policy/compiled.ts";
import { coverage, deletionReport } from "../../src/worker/reports/deletion-report.ts";
import { call, seedWorld, worldApp } from "../fixtures/seed.ts";

// ---- revision 2 report (commit 38), the reference ------------------------------------------------------------------
async function deletionReportRev2(db: D1Database, from: string | null, to: string | null) {
  const where = "WHERE (?1 IS NULL OR r.created_at >= ?1) AND (?2 IS NULL OR r.created_at <= ?2)";
  const { results: requests } = await db.prepare(`SELECT r.id, r.kind, r.status FROM deletion_requests r ${where} ORDER BY r.created_at`).bind(from, to).all<{ id: string; kind: string; status: string }>();
  const { results: rows } = await db
    .prepare(`SELECT a.*, r.status AS request_status FROM deletion_asset_results a JOIN deletion_requests r ON r.id = a.request_id ${where}`)
    .bind(from, to)
    .all<AssetResultRow & { request_id: string; request_status: string }>();
  const scored = rows.filter((r) => r.request_status !== "held" && r.applicability !== "held");
  const cats = perCategory(scored);
  const applicable = scored.filter(isApplicable);
  const clean = applicable.filter((r) => r.verify_status === "clean").length;
  const byStatus: Record<string, number> = {};
  for (const r of requests) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const { results: residuals } = await db
    .prepare(`SELECT s.kind, s.state, s.evidence, COUNT(*) AS n FROM residuals s JOIN deletion_requests r ON r.id = s.request_id ${where} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)
    .bind(from, to)
    .all<{ kind: string; state: string; evidence: string; n: number }>();
  const failures = rows
    .filter((r) => r.request_status === "failed" && r.finding_json)
    .map((r) => ({ requestId: r.request_id, assetId: r.asset_id, findings: JSON.parse(r.finding_json!) as unknown }));
  return {
    window: { from, to },
    requests: { total: requests.length, byStatus },
    coverage: coverage(clean, applicable.length),
    byCategory: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, { ...coverage(c.clean, c.applicable), notPresent: c.notPresent, aggregateRecompute: c.aggregateRecompute }])),
    held: { requests: byStatus.held ?? 0, assetPairs: rows.filter((r) => r.applicability === "held").length },
    aggregateRecompute: {
      recomputed: rows.filter((r) => r.applicability === "aggregate_recompute" && r.action_status === "recomputed").length,
      notRecomputed: rows.filter((r) => r.applicability === "aggregate_recompute" && r.action_status !== "recomputed").length,
    },
    residuals,
    failures,
  };
}
// ---------------------------------------------------------------------------------------------------------------------

function prng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const STATUSES = ["received", "held", "running", "completed", "completed_with_residuals", "failed"] as const;

beforeAll(async () => {
  await seedWorld();
  const rand = prng(20261010);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 160; i++) {
    const id = `rep-${String(i).padStart(3, "0")}`;
    const status = STATUSES[i % STATUSES.length]!;
    const created = new Date(Date.UTC(2026, 9, 1 + (i % 9), i % 24)).toISOString();
    stmts.push(env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, status, requested_by, created_at) VALUES (?, ?, ?, ?, 'privacy-01', ?)").bind(id, i % 3 ? "dsr" : "retention", `sr_rep${i}`, status, created));
    for (const a of POLICY.assets) {
      const applicability = status === "held" ? "held" : a.id === "drv.marts.headcount_monthly" ? "aggregate_recompute" : pick(["present", "present", "not_present"] as const);
      const verify = applicability === "held" ? "not_applicable" : applicability === "aggregate_recompute" ? "not_applicable" : pick(["clean", "clean", "clean", "residue", "error", "pending"] as const);
      const action = applicability === "aggregate_recompute" ? pick(["recomputed", "failed"] as const) : applicability === "held" ? "skipped_hold" : pick(["erased", "failed", "pending"] as const);
      const finding = rand() < 0.5 ? JSON.stringify({ findings: [{ store: "r2", location: `pv-source-exports/x/${i}`, matches: 1 }] }) : null;
      stmts.push(
        env.DB.prepare("INSERT INTO deletion_asset_results (request_id, asset_id, category, applicability, action_status, verify_status, finding_json) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, a.id, a.category, applicability, action, verify, finding),
      );
    }
    if (status === "failed" || i % 7 === 0) {
      const store = pick(["r2", "kv", "d1"] as const);
      stmts.push(
        env.DB.prepare("INSERT INTO deletion_asset_results (request_id, asset_id, category, applicability, action_status, verify_status, verify_matches, finding_json) VALUES (?, ?, ?, 'unregistered', 'failed', ?, 1, ?)").bind(
          id,
          `unregistered:${store}:loc-${i}`,
          pick(POLICY.categories),
          pick(["residue", "error"] as const),
          JSON.stringify([{ store, location: `loc-${i}`, matches: 1 }]),
        ),
      );
    }
    for (const kind of ["iceberg_snapshots", "bq_time_travel", "kv_propagation"] as const) {
      if (rand() < 0.6) stmts.push(env.DB.prepare("INSERT INTO residuals (id, request_id, asset_id, kind, state, evidence) VALUES (?, ?, 'wh.core', ?, ?, ?)").bind(`${id}:${kind}`, id, kind, pick(["pending", "cleared", "modeled", "error"] as const), pick(["observed", "modeled"] as const)));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
});

async function allPages(from: string | null, to: string | null) {
  const first = await deletionReport(env.DB, from, to, { limit: 100, cursor: null });
  const failures = [...first.failures];
  let cursor = first.failuresCursor;
  let pages = 1;
  while (cursor) {
    const next = await deletionReport(env.DB, from, to, { limit: 100, cursor });
    expect(next.failures.length).toBeLessThanOrEqual(100);
    failures.push(...next.failures);
    cursor = next.failuresCursor;
    pages++;
  }
  return { report: first, failures, pages };
}

const byKey = (a: { requestId: string; assetId: string }, b: { requestId: string; assetId: string }) => (a.requestId === b.requestId ? (a.assetId < b.assetId ? -1 : 1) : a.requestId < b.requestId ? -1 : 1);

describe("deletion report in SQL", () => {
  for (const [label, from, to] of [["every request", null, null], ["a date window", "2026-10-03T00:00:00.000Z", "2026-10-06T23:59:59.999Z"]] as const) {
    it(`equals the revision 2 JavaScript report over ${label}`, async () => {
      const want = await deletionReportRev2(env.DB, from, to);
      const { report, failures, pages } = await allPages(from, to);
      const { failures: _f, failuresCursor: _c, ...got } = report;
      const { failures: wantFailures, ...wantRest } = want;
      expect(got).toEqual(wantRest);
      expect(failures).toEqual([...wantFailures].sort(byKey));
      expect(want.requests.total).toBeGreaterThan(0);
      if (from === null) {
        expect(wantFailures.length).toBeGreaterThan(100);
        expect(pages).toBe(Math.ceil(wantFailures.length / 100));
        for (const c of POLICY.categories) expect(want.byCategory[c]!.applicablePairs).toBeGreaterThan(0);
      }
    });
  }

  it("the route pages failures and refuses a bad query", async () => {
    const { app } = worldApp();
    const res = await call(app, "privacy-01", "GET", "/api/v1/privacy/reports/deletion?limit=10");
    const body = (await res.json()) as { failures: unknown[]; failuresCursor: string | null };
    expect(res.status).toBe(200);
    expect(body.failures).toHaveLength(10);
    expect(body.failuresCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const next = (await (await call(app, "privacy-01", "GET", `/api/v1/privacy/reports/deletion?limit=10&cursor=${body.failuresCursor}`)).json()) as { failures: { requestId: string }[] };
    expect(next.failures).toHaveLength(10);
    expect((await call(app, "privacy-01", "GET", "/api/v1/privacy/reports/deletion?limit=101")).status).toBe(400);
    expect((await call(app, "privacy-01", "GET", "/api/v1/privacy/audit/verify?limit=500")).status).toBe(400);
    const w = (await (await call(app, "privacy-01", "GET", "/api/v1/privacy/audit/verify?after_seq=0&limit=5")).json()) as { ok: boolean; checked: number; complete: boolean };
    expect(w.ok).toBe(true);
    expect(w.checked).toBeLessThanOrEqual(5);
  });
});
