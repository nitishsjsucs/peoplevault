// Audit stream (P1, SPEC.md sections 14.7 and 16.1): in production every audit event appended to the D1 hash chain is
// also sent to the Basin Pipelines stream `pv_audit_events`, whose sink writes the Basin Catalog Iceberg table
// `governance.audit_events`. D1 stays the source of truth: a send never blocks or fails the append, and failures are
// logged as counts only. Locally the stream is disabled (Miniflare's pipeline binding is a no-op, so binding it would
// pretend to stream) and the binding is never touched.
//
// Records follow infra/cloudflare/audit-stream.schema.json exactly. Events that do not match a stream's schema are
// accepted at ingestion and dropped later (Pipelines docs, "Manage streams"), so every record is checked against the
// schema before it is sent and a mismatch is counted as dropped instead of disappearing silently. detail_json is not
// streamed: it holds counts and enums that only the D1 receipt and report need.
import schemaJson from "../../../infra/cloudflare/audit-stream.schema.json";
import type { AuditLog, AuditRow } from "./audit-log.ts";

export type StreamFieldType = "string" | "int64" | "timestamp";
export interface StreamField {
  name: string;
  type: StreamFieldType;
  required: boolean;
}
export const AUDIT_STREAM_SCHEMA = schemaJson as { fields: StreamField[] };

export type AuditStreamRecord = Omit<AuditRow, "detail_json">;

export interface AuditStream {
  mode: "pipelines" | "disabled";
  send(records: AuditStreamRecord[]): Promise<void>;
}

export const DISABLED_STREAM: AuditStream = { mode: "disabled", send: async () => {} };

/** The stream copy of one stored event: every schema field, in schema order, nothing else. */
export function toStreamRecord(row: AuditRow): AuditStreamRecord {
  const out: Record<string, unknown> = {};
  for (const f of AUDIT_STREAM_SCHEMA.fields) out[f.name] = (row as unknown as Record<string, unknown>)[f.name] ?? null;
  return out as AuditStreamRecord;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Problems with a record against the stream schema (empty when it matches). */
export function schemaProblems(record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const names = new Set(AUDIT_STREAM_SCHEMA.fields.map((f) => f.name));
  for (const k of Object.keys(record)) if (!names.has(k)) problems.push(`${k}: not in schema`);
  for (const f of AUDIT_STREAM_SCHEMA.fields) {
    const v = record[f.name];
    if (v === null || v === undefined) {
      if (f.required) problems.push(`${f.name}: required`);
      continue;
    }
    const ok =
      f.type === "string" ? typeof v === "string" : f.type === "int64" ? Number.isSafeInteger(v) : typeof v === "string" && RFC3339.test(v) && !Number.isNaN(Date.parse(v));
    if (!ok) problems.push(`${f.name}: not ${f.type}`);
  }
  return problems;
}

/** The stream for this environment: the Pipelines binding only when AUDIT_STREAM_MODE=pipelines (validated by
 * loadConfig, which refuses that mode without the binding). */
export function auditStreamFor(env: Env): AuditStream {
  const binding = env.AUDIT_STREAM;
  if (env.AUDIT_STREAM_MODE !== "pipelines" || !binding) return DISABLED_STREAM;
  return { mode: "pipelines", send: (records) => binding.send(records) };
}

/** Sends one appended event; never throws. Logs counts only (never field values). */
export async function streamEvent(stream: AuditStream, row: AuditRow): Promise<"sent" | "disabled" | "dropped" | "failed"> {
  if (stream.mode === "disabled") return "disabled";
  const record = toStreamRecord(row);
  if (schemaProblems(record as unknown as Record<string, unknown>).length) {
    console.warn("audit_stream_dropped", 1);
    return "dropped";
  }
  try {
    await stream.send([record]);
    return "sent";
  } catch {
    console.warn("audit_stream_failed", 1);
    return "failed";
  }
}

/** An AuditLog that also streams each appended event. `schedule` keeps the send off the request's critical path
 * (ctx.waitUntil); without it (inside Workflow steps) the send is awaited, still without ever failing the append. */
export function withAuditStream(log: AuditLog, stream: AuditStream, schedule?: (p: Promise<unknown>) => void): AuditLog {
  if (stream.mode === "disabled") return log;
  return {
    async append(e) {
      const out = await log.append(e);
      const p = streamEvent(stream, out.row);
      if (schedule) schedule(p);
      else await p;
      return out;
    },
    verify: () => log.verify(),
  };
}
