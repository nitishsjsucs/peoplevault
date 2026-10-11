// Per-request services (pseudonymizer, warehouse client, audit log) and the audit helper used by every route.
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, BuildAppOptions } from "./app.ts";
import { createAuditLog, type AuditEventInput } from "./audit/audit-log.ts";
import { auditStreamFor, withAuditStream } from "./audit/audit-stream.ts";
import { createPseudonymizer, type Pseudonymizer } from "./pseudo/hmac.ts";
import { createWarehouseClient } from "./warehouse/client.ts";

let pseudoCache: { key: string; p: Pseudonymizer } | null = null;

export function pseudonymizerFor(masterKeyB64: string): Pseudonymizer {
  if (pseudoCache?.key !== masterKeyB64) pseudoCache = { key: masterKeyB64, p: createPseudonymizer(masterKeyB64) };
  return pseudoCache.p;
}

export function services(opts: BuildAppOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfg = c.get("cfg");
    c.set("pseudo", pseudonymizerFor(cfg.masterKeyB64));
    c.set("warehouse", opts.warehouseFactory ? opts.warehouseFactory(c.env, cfg) : createWarehouseClient(c.env, cfg));
    c.set("audit", withAuditStream(createAuditLog(c.env.DB), auditStreamFor(c.env), backgroundOf(c)));
    await next();
  };
}

/** ctx.waitUntil when the request has an execution context (always in the runtime; some tests call fetch without one). */
function backgroundOf(c: Context<AppEnv>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined;
  }
}

export type AuditFields = Omit<AuditEventInput, "actor" | "actorKind" | "persona">;

/** Appends one audit event for the authenticated principal (opaque id; never an employee identifier). */
export async function audit(c: Context<AppEnv>, e: AuditFields): Promise<void> {
  const p = c.get("principal");
  await c.get("audit").append({ ...e, actor: p.id, actorKind: p.kind, persona: p.persona ?? null });
}

export function errorJson(c: Context<AppEnv>, status: 400 | 403 | 404 | 409 | 502, code: string) {
  return c.json({ error: status === 404 ? "not_found" : status === 400 ? "bad_request" : status === 409 ? "conflict" : status === 502 ? "warehouse_unavailable" : "forbidden", code }, status);
}
