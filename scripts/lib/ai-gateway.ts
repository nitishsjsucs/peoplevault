// The AI Gateway of the schema-drift triage (SPEC.md sections 16.3 and 30.3.6): `peoplevault`, one of the account's
// 10 gateways (F18), storing no logs and caching nothing (quarantined sample values may hold identifiers), with a
// rate limit of 10 requests a minute. setup:prod creates it (PV_CF_API_TOKEN needs AI Gateway Edit, which the API
// reference calls AI Gateway Write) and the doctor checks these settings.
import type { AiGateway } from "./cf-api.ts";

export const AI_GATEWAY_ID = "peoplevault";

/** The body of POST /accounts/{account_id}/ai-gateway/gateways (and of the PUT that repairs a drifted gateway). */
export const AI_GATEWAY_SETTINGS = {
  id: AI_GATEWAY_ID,
  cache_ttl: 0,
  cache_invalidate_on_update: false,
  collect_logs: false,
  rate_limiting_interval: 60,
  rate_limiting_limit: 10,
  rate_limiting_technique: "fixed",
} as const;

/** Settings of an existing gateway that differ from the design; empty when it matches. */
export function gatewayDrift(g: AiGateway): string[] {
  const out: string[] = [];
  if (g.collect_logs !== false) out.push("collect_logs is on (the gateway would store prompts and answers)");
  if ((g.cache_ttl ?? 0) !== 0) out.push(`cache_ttl is ${g.cache_ttl} (answers would be cached)`);
  if (g.rate_limiting_limit !== AI_GATEWAY_SETTINGS.rate_limiting_limit || g.rate_limiting_interval !== AI_GATEWAY_SETTINGS.rate_limiting_interval)
    out.push(`rate limit is ${g.rate_limiting_limit ?? "none"} per ${g.rate_limiting_interval ?? "-"} s (want 10 per 60 s)`);
  return out;
}
