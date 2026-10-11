// Schema-drift triage routes (SPEC.md sections 16.3 and 30.3.6), privacy_officer under privacy_compliance:
//   POST /api/v1/privacy/schema-drift/:id/suggest { column }  a column of a quarantined export (the loader's report id)
//   POST /api/v1/privacy/schema-drift/classify { column, samples }  a labeled column (`pv eval drift`)
//   GET  /api/v1/privacy/schema-drift/usage  today's neurons against AI_DAILY_NEURONS
// A suggestion is max_severity(rule_class, model_class) and never changes policy. Sample values go to the model only:
// responses and audit events carry classes, the model id and neurons, never a sample value.
import { Hono, type Context } from "hono";
import { DriftClassifyBody, DriftSuggestBody } from "../../shared/api-schemas.ts";
import type { AppEnv } from "../app.ts";
import { usageOn, utcDay } from "../ai/meter.ts";
import { modelFor, ModelUnavailable, type TriageModel } from "../ai/models.ts";
import { PromptTooLong } from "../ai/prompt.ts";
import { worstCaseNeurons } from "../ai/rates.ts";
import { keyFromQuarantineId, readSamples } from "../ai/samples.ts";
import { triage, type TriageResult } from "../ai/triage.ts";
import { audit, errorJson } from "../context.ts";
import { POLICY } from "../policy/compiled.ts";
import { decide } from "../policy/pdp.ts";

export const drift = new Hono<AppEnv>();

const PURPOSE = "privacy_compliance";
const ACTION = "triage_schema_drift";
const R = {
  suggest: "/api/v1/privacy/schema-drift/:id/suggest",
  classify: "/api/v1/privacy/schema-drift/classify",
  usage: "/api/v1/privacy/schema-drift/usage",
} as const;

async function authorize(c: Context<AppEnv>, route: string): Promise<Response | null> {
  const d = decide({ principal: c.get("principal"), purpose: PURPOSE, action: ACTION });
  if (d.allow) return null;
  await audit(c, { purpose: PURPOSE, action: ACTION, route, decision: "deny", reason: d.reason });
  return c.json({ error: d.status === 404 ? "not_found" : "forbidden", code: d.reason }, d.status);
}

async function deny(c: Context<AppEnv>, route: string, status: 400 | 404 | 409, code: string): Promise<Response> {
  await audit(c, { purpose: PURPOSE, action: ACTION, route, decision: "deny", reason: code });
  return errorJson(c, status, code);
}

function model(c: Context<AppEnv>): TriageModel | null {
  try {
    return modelFor(c.get("cfg"), c.env);
  } catch (e) {
    if (e instanceof ModelUnavailable) return null;
    throw e;
  }
}

async function run(c: Context<AppEnv>, route: string, column: string, samples: string[]): Promise<Response> {
  const m = model(c);
  if (!m) {
    await audit(c, { purpose: PURPOSE, action: ACTION, route, decision: "deny", reason: "ai_unavailable" });
    return c.json({ error: "unavailable", code: "ai_unavailable" }, 503);
  }
  let r: TriageResult;
  try {
    r = await triage(c.env.DB, m, c.get("cfg").ai.dailyNeurons, column, samples);
  } catch (e) {
    if (e instanceof PromptTooLong) return deny(c, route, 400, "prompt_too_long");
    throw e;
  }
  await audit(c, {
    purpose: PURPOSE,
    action: ACTION,
    route,
    decision: "allow",
    reason: r.ai.status,
    detail: { model: r.model, rule_class: r.ruleClass, model_class: r.modelClass, suggested_class: r.suggestedClass, neurons: Math.round(r.ai.neurons * 100) / 100 },
  });
  return c.json(r);
}

drift.post(R.classify, async (c) => {
  const denied = await authorize(c, R.classify);
  if (denied) return denied;
  const body = DriftClassifyBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return deny(c, R.classify, 400, "invalid_body");
  return run(c, R.classify, body.data.column, body.data.samples);
});

drift.post(R.suggest, async (c) => {
  const denied = await authorize(c, R.suggest);
  if (denied) return denied;
  const body = DriftSuggestBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return deny(c, R.suggest, 400, "invalid_body");
  const key = keyFromQuarantineId(c.req.param("id"));
  if (!key) return deny(c, R.suggest, 404, "not_found");
  const known = POLICY.columnClass[body.data.column];
  if (known) {
    await audit(c, { purpose: PURPOSE, action: ACTION, route: R.suggest, decision: "deny", reason: "column_already_classified" });
    return c.json({ error: "conflict", code: "column_already_classified", class: known }, 409);
  }
  const samples = await readSamples(c.env.EXPORTS, key, body.data.column);
  if (samples === "missing_object") return deny(c, R.suggest, 404, "not_found");
  if (samples === null) return deny(c, R.suggest, 404, "column_not_in_object");
  return run(c, R.suggest, body.data.column, samples);
});

drift.get(R.usage, async (c) => {
  const denied = await authorize(c, R.usage);
  if (denied) return denied;
  const m = model(c);
  const u = await usageOn(c.env.DB, utcDay());
  await audit(c, { purpose: PURPOSE, action: ACTION, route: R.usage, decision: "allow", reason: "ok" });
  return c.json({ ...u, cap: c.get("cfg").ai.dailyNeurons, model: m?.id ?? null, worstCasePerCall: m ? worstCaseNeurons(m.id) : null });
});
