// Hash-chained D1 audit log (SPEC.md section 9.2). hash = hex(sha256(prev_hash + "\n" + canonicalJson(event))),
// genesis prev_hash = 64 zeros. The insert carries a guard on the current chain head, so concurrent appends retry
// instead of forking the chain. Fields never hold an employee identifier token: actor is an opaque principal id,
// subjects appear only as subject_ref, route is a template and detail holds counts and enums.
import { AUDIT_VERIFY_WINDOW } from "../../shared/limits.ts";

export const GENESIS = "0".repeat(64);

export interface AuditEventInput {
  actor: string;
  actorKind: "human" | "system" | "anonymous";
  persona?: string | null;
  purpose?: string | null;
  action: string;
  route?: string | null;
  subjectRef?: string | null;
  requestId?: string | null;
  decision: "allow" | "deny" | "info";
  reason: string;
  rowCount?: number | null;
  detail?: Record<string, number | string | boolean | null> | null;
}

export interface AuditRow {
  seq: number;
  id: string;
  ts: string;
  actor: string;
  actor_kind: string;
  persona: string | null;
  purpose: string | null;
  action: string;
  route: string | null;
  subject_ref: string | null;
  request_id: string | null;
  decision: string;
  reason: string;
  row_count: number | null;
  detail_json: string | null;
  prev_hash: string;
  hash: string;
}

/** One verified window of the chain (SPEC.md section 30.3.2). */
export interface VerifyWindow {
  ok: boolean;
  /** seq the window continues after (0 = genesis) and the hash it was anchored on */
  afterSeq: number;
  anchorHash: string;
  /** first and last seq checked, null for an empty window */
  from: number | null;
  to: number | null;
  /** hash of the last row checked (the anchor for an empty window) */
  lastHash: string;
  /** after_seq for the next window */
  nextAfterSeq: number;
  /** true when no row follows this window */
  complete: boolean;
  checked: number;
  brokenAtSeq?: number;
}

/** Workers Free: a request verifies at most AUDIT_VERIFY_WINDOW (50) events; see `npm run bench:cpu`. */
export const VERIFY_WINDOW_MAX = AUDIT_VERIFY_WINDOW;

export interface AuditLog {
  /** Appends one event; returns the stored row. */
  append(e: AuditEventInput): Promise<{ seq: number; hash: string; id: string; row: AuditRow }>;
  /** The whole chain in one pass (tests and local tools; production routes use verifyWindow). */
  verify(): Promise<{ ok: boolean; length: number; brokenAtSeq?: number }>;
  /** Verifies the rows after `afterSeq`, at most `limit` of them, anchored on row `afterSeq`'s hash. */
  verifyWindow(afterSeq: number, limit: number): Promise<VerifyWindow>;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hashed content of an event: every stored field except seq, prev_hash and hash. */
export function hashedFields(r: Omit<AuditRow, "seq" | "prev_hash" | "hash">): Record<string, unknown> {
  return {
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    actor_kind: r.actor_kind,
    persona: r.persona,
    purpose: r.purpose,
    action: r.action,
    route: r.route,
    subject_ref: r.subject_ref,
    request_id: r.request_id,
    decision: r.decision,
    reason: r.reason,
    row_count: r.row_count,
    detail_json: r.detail_json,
  };
}

export async function chainHash(prev: string, fields: Record<string, unknown>): Promise<string> {
  return sha256Hex(`${prev}\n${canonicalJson(fields)}`);
}

// Workers Free allows 50 D1 queries per invocation: an append tries at most 8 times (16 statements), then throws (a
// Workflow step retries; a request answers 500) instead of spending the invocation's queries (SPEC.md 30.3.1).
export const MAX_APPEND_ATTEMPTS = 8;

export class AuditContention extends Error {
  override name = "AuditContention";
}

export function createAuditLog(db: D1Database, now: () => Date = () => new Date()): AuditLog {
  return {
    async append(e) {
      const id = crypto.randomUUID();
      const row = {
        id,
        ts: now().toISOString(),
        actor: e.actor,
        actor_kind: e.actorKind,
        persona: e.persona ?? null,
        purpose: e.purpose ?? null,
        action: e.action,
        route: e.route ?? null,
        subject_ref: e.subjectRef ?? null,
        request_id: e.requestId ?? null,
        decision: e.decision,
        reason: e.reason,
        row_count: e.rowCount ?? null,
        detail_json: e.detail ? canonicalJson(e.detail) : null,
      };
      for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
        const head = await db.prepare("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1").first<{ hash: string }>();
        const prev = head?.hash ?? GENESIS;
        const hash = await chainHash(prev, hashedFields(row));
        const res = await db
          .prepare(
            `INSERT INTO audit_events (id, ts, actor, actor_kind, persona, purpose, action, route, subject_ref, request_id, decision, reason, row_count, detail_json, prev_hash, hash)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
             WHERE COALESCE((SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1), ?17) = ?15`,
          )
          .bind(row.id, row.ts, row.actor, row.actor_kind, row.persona, row.purpose, row.action, row.route, row.subject_ref, row.request_id, row.decision, row.reason, row.row_count, row.detail_json, prev, hash, GENESIS)
          .run();
        if (res.meta.changes === 1) {
          const seq = Number(res.meta.last_row_id);
          return { seq, hash, id, row: { seq, ...row, prev_hash: prev, hash } };
        }
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20) + 1));
      }
      throw new AuditContention("audit append contention");
    },

    async verify() {
      let prev = GENESIS;
      let length = 0;
      let after = 0;
      for (;;) {
        const { results } = await db.prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq LIMIT 500").bind(after).all<AuditRow>();
        if (results.length === 0) break;
        for (const r of results) {
          const expected = await chainHash(prev, hashedFields(r));
          if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, length, brokenAtSeq: r.seq };
          prev = r.hash;
          length++;
          after = r.seq;
        }
      }
      return { ok: true, length };
    },

    async verifyWindow(afterSeq, limit) {
      const n = Math.max(1, Math.min(VERIFY_WINDOW_MAX, Math.floor(limit)));
      let anchor = GENESIS;
      if (afterSeq > 0) {
        const row = await db.prepare("SELECT hash FROM audit_events WHERE seq = ?").bind(afterSeq).first<{ hash: string }>();
        if (!row) return { ok: false, afterSeq, anchorHash: "", from: null, to: null, lastHash: "", nextAfterSeq: afterSeq, complete: true, checked: 0, brokenAtSeq: afterSeq };
        anchor = row.hash;
      }
      const { results } = await db.prepare("SELECT * FROM audit_events WHERE seq > ? ORDER BY seq LIMIT ?").bind(afterSeq, n + 1).all<AuditRow>();
      const rows = results.slice(0, n);
      let prev = anchor;
      for (const r of rows) {
        const expected = await chainHash(prev, hashedFields(r));
        if (r.prev_hash !== prev || r.hash !== expected) {
          return { ok: false, afterSeq, anchorHash: anchor, from: rows[0]!.seq, to: r.seq, lastHash: prev, nextAfterSeq: r.seq, complete: true, checked: rows.indexOf(r), brokenAtSeq: r.seq };
        }
        prev = r.hash;
      }
      const last = rows[rows.length - 1];
      return {
        ok: true,
        afterSeq,
        anchorHash: anchor,
        from: rows[0]?.seq ?? null,
        to: last?.seq ?? null,
        lastHash: prev,
        nextAfterSeq: last?.seq ?? afterSeq,
        complete: results.length <= n,
        checked: rows.length,
      };
    },
  };
}
