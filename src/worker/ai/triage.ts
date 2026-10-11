// Schema-drift triage (SPEC.md sections 16.3 and 30.3.6): the rule class of a column, a model's class within the
// daily neuron budget, and the suggestion max_severity(rule_class, model_class). Over the budget, or when the model
// fails or answers outside the schema, the suggestion is the rule class alone; the policy never depends on the model.
import type { DataClass } from "../../shared/policy-types.ts";
import { reserve, settle, utcDay } from "./meter.ts";
import { ModelUnavailable, type TriageModel } from "./models.ts";
import { buildMessages, promptChars } from "./prompt.ts";
import { MAX_OUTPUT_TOKENS, neuronsFor, worstCaseNeurons, type Usage } from "./rates.ts";
import { isDataClass, isSensitive, maxSeverity, ruleClass } from "./rules.ts";

export type AiStatus = "ok" | "budget_exhausted" | "invalid_output" | "error" | "unavailable";

export interface TriageResult {
  column: string;
  ruleClass: DataClass | null;
  modelClass: DataClass | null;
  suggestedClass: DataClass | null;
  sensitive: boolean | null;
  model: string;
  ai: { status: AiStatus; neurons: number; usage: Usage | null };
}

function parseClass(content: unknown): DataClass | null {
  let v = content;
  if (typeof v === "string") {
    const m = /\{[\s\S]*\}/.exec(v);
    if (!m) return null;
    try {
      v = JSON.parse(m[0]) as unknown;
    } catch {
      return null;
    }
  }
  const cls = v && typeof v === "object" ? (v as { class?: unknown }).class : null;
  return isDataClass(cls) ? cls : null;
}

export async function triage(db: D1Database, model: TriageModel, dailyNeurons: number | null, column: string, samples: string[], now = new Date()): Promise<TriageResult> {
  const rule = ruleClass(column, samples);
  const messages = buildMessages(column, samples, model.systemSuffix ?? "");
  const result = (modelClass: DataClass | null, status: AiStatus, neurons: number, usage: Usage | null): TriageResult => {
    const suggested = maxSeverity(rule, modelClass);
    return { column, ruleClass: rule, modelClass, suggestedClass: suggested, sensitive: suggested ? isSensitive(suggested) : null, model: model.id, ai: { status, neurons, usage } };
  };
  const day = utcDay(now);
  const worst = worstCaseNeurons(model.id);
  if (!(await reserve(db, day, model.id, worst, dailyNeurons))) return result(null, "budget_exhausted", 0, null);
  let reply;
  try {
    reply = await model.complete(messages);
  } catch (e) {
    // the reservation stays: the call may have been billed
    return result(null, e instanceof ModelUnavailable ? "unavailable" : "error", worst, null);
  }
  const usage: Usage = reply.usage
    ? { promptTokens: reply.usage.promptTokens, completionTokens: reply.usage.completionTokens, estimated: false }
    : { promptTokens: Math.ceil(promptChars(messages) / 4), completionTokens: MAX_OUTPUT_TOKENS, estimated: true };
  const neurons = neuronsFor(model.id, usage);
  await settle(db, day, model.id, neurons - worst);
  const cls = parseClass(reply.content);
  return result(cls, cls ? "ok" : "invalid_output", neurons, usage);
}
