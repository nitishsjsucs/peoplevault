import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AuditContention, GENESIS, MAX_APPEND_ATTEMPTS, VERIFY_WINDOW_MAX, canonicalJson, createAuditLog, type VerifyWindow } from "../../src/worker/audit/audit-log.ts";

describe("audit hash chain", () => {
  it("appends and verifies; genesis prev_hash is 64 zeros", async () => {
    const log = createAuditLog(env.DB);
    const a = await log.append({ actor: "privacy-01", actorKind: "human", action: "read_report", decision: "allow", reason: "ok" });
    await log.append({ actor: "privacy-01", actorKind: "human", action: "read_audit", decision: "allow", reason: "ok", detail: { n: 2 } });
    const first = await env.DB.prepare("SELECT prev_hash FROM audit_events WHERE seq = ?").bind(a.seq).first<{ prev_hash: string }>();
    expect(first?.prev_hash).toBe(GENESIS);
    expect(await log.verify()).toEqual({ ok: true, length: 2 });
  });

  it("detects tampering at the right seq", async () => {
    const log = createAuditLog(env.DB);
    const before = (await log.verify()).length;
    const seqs = [];
    for (let i = 0; i < 4; i++) seqs.push((await log.append({ actor: "mgr-001", actorKind: "human", action: "list_employees", decision: "allow", reason: "ok", rowCount: i })).seq);
    expect((await log.verify()).length).toBe(before + 4);
    await env.DB.prepare("UPDATE audit_events SET row_count = 999 WHERE seq = ?").bind(seqs[2]).run();
    expect(await log.verify()).toEqual({ ok: false, length: before + 2, brokenAtSeq: seqs[2] });
    await env.DB.prepare("UPDATE audit_events SET row_count = 2 WHERE seq = ?").bind(seqs[2]).run();
    expect((await log.verify()).ok).toBe(true);
  });

  it("concurrent appends never fork the chain", async () => {
    const log = createAuditLog(env.DB);
    const before = (await log.verify()).length;
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append({ actor: "pv-executor-local", actorKind: "system", action: "executor_complete", decision: "info", reason: "ok", rowCount: i })));
    const v = await log.verify();
    expect(v).toEqual({ ok: true, length: before + 20 });
    const dup = await env.DB.prepare("SELECT prev_hash, COUNT(*) AS n FROM audit_events GROUP BY prev_hash HAVING n > 1").all();
    expect(dup.results).toHaveLength(0);
  });

  it("canonical JSON sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: undefined } })).toBe('{"a":{"d":[2,{"y":null,"z":1}]},"b":1}');
  });

  it("an append gives up after 8 attempts (16 D1 statements) when the chain head keeps moving", async () => {
    let statements = 0;
    const db = new Proxy(env.DB, {
      get(t, prop) {
        if (prop !== "prepare") return Reflect.get(t, prop).bind(t);
        return (sql: string) => {
          const stmt = t.prepare(sql);
          const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(st, {
              get(s2, p2) {
                if (p2 === "bind") return (...a: unknown[]) => wrap(s2.bind(...a));
                if (p2 === "first") return (...a: unknown[]) => (statements++, (s2.first as (...x: unknown[]) => unknown)(...a));
                // the guarded insert never wins: another writer always moved the head first
                if (p2 === "run") return async () => (statements++, { meta: { changes: 0 } });
                return Reflect.get(s2, p2).bind(s2);
              },
            });
          return wrap(stmt);
        };
      },
    });
    await expect(createAuditLog(db).append({ actor: "t", actorKind: "system", action: "x", decision: "info", reason: "y" })).rejects.toBeInstanceOf(AuditContention);
    expect(MAX_APPEND_ATTEMPTS).toBe(8);
    expect(statements).toBe(2 * MAX_APPEND_ATTEMPTS);
  });

  it("windowed verification: 100 events per window, each anchored on the previous window's last hash", async () => {
    const log = createAuditLog(env.DB);
    for (let i = 0; i < 230; i++) await log.append({ actor: "t", actorKind: "system", action: "w", decision: "info", reason: `r${i}` });
    const length = (await log.verify()).length;
    const windows: VerifyWindow[] = [];
    let after = 0;
    for (;;) {
      const w = await log.verifyWindow(after, 100);
      windows.push(w);
      expect(w.ok).toBe(true);
      if (windows.length > 1) expect(w.anchorHash).toBe(windows[windows.length - 2]!.lastHash);
      if (w.complete) break;
      after = w.nextAfterSeq;
    }
    expect(windows.reduce((n, w) => n + w.checked, 0)).toBe(length);
    expect(windows.every((w) => w.checked <= VERIFY_WINDOW_MAX)).toBe(true);
    expect(windows.length).toBe(Math.ceil(length / 100));
    expect((await log.verifyWindow(0, 1000)).checked).toBe(VERIFY_WINDOW_MAX);
  });

  it("windowed verification finds tampering inside a window and across a window boundary", async () => {
    const log = createAuditLog(env.DB);
    for (let i = 0; i < 20; i++) await log.append({ actor: "t", actorKind: "system", action: "x", decision: "info", reason: `b${i}` });
    const { results } = await env.DB.prepare("SELECT seq FROM audit_events ORDER BY seq DESC LIMIT 20").all<{ seq: number }>();
    const seqs = results.map((r) => r.seq).reverse();
    // inside a window: a changed field
    await env.DB.prepare("UPDATE audit_events SET reason = 'tampered' WHERE seq = ?").bind(seqs[5]).run();
    const inside = await log.verifyWindow(seqs[0]!, 10);
    expect([inside.ok, inside.brokenAtSeq]).toEqual([false, seqs[5]]);
    // across the boundary: window [seqs[10]..] anchors on row seqs[9]; a rewritten anchor row breaks the next window
    await env.DB.prepare("UPDATE audit_events SET hash = ? WHERE seq = ?").bind("f".repeat(64), seqs[9]).run();
    const next = await log.verifyWindow(seqs[9]!, 10);
    expect([next.ok, next.brokenAtSeq]).toEqual([false, seqs[10]]);
    const missingAnchor = await log.verifyWindow(10_000_000, 10);
    expect([missingAnchor.ok, missingAnchor.brokenAtSeq]).toEqual([false, 10_000_000]);
    await env.DB.prepare("DELETE FROM audit_events WHERE seq >= ?").bind(seqs[0]).run();
  });
});
