// Workers AI rates and the per-call caps of the schema-drift triage (SPEC.md section 30.3.6). The dated rate table is
// src/shared/ai-rates.json (read by `pv eval drift` too). Every call is capped at 600 input tokens (the prompt is
// rejected above 2,400 characters) and 48 output tokens, so the worst case of one call on the production model is
// 600 x 26,668 / 1M + 48 x 204,805 / 1M = 25.83 neurons.
import rates from "../../shared/ai-rates.json";

export const PRODUCTION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const LOCAL_MODEL = "llama-server/Qwen3-1.7B-Q4_0";
export const STUB_MODEL = "stub";

export const MAX_INPUT_TOKENS = 600;
export const MAX_PROMPT_CHARS = 2400;
export const MAX_OUTPUT_TOKENS = 48;

export interface Rate {
  input: number;
  output: number;
  billed: boolean;
}

export const RATES: Readonly<Record<string, Rate>> = rates.models;
export const RATES_CHECKED = rates.checked;
export const RATES_SOURCE = rates.source;

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** true when the model reported no usage and the tokens were estimated (characters / 4, max_tokens) */
  estimated: boolean;
}

function rate(model: string): Rate {
  const r = RATES[model];
  if (!r) throw new Error(`no rate for model ${model}`);
  return r;
}

export function neuronsFor(model: string, u: Pick<Usage, "promptTokens" | "completionTokens">): number {
  const r = rate(model);
  return (u.promptTokens * r.input + u.completionTokens * r.output) / 1_000_000;
}

/** The most one call can cost under the caps: what the meter reserves before calling. */
export function worstCaseNeurons(model: string): number {
  return neuronsFor(model, { promptTokens: MAX_INPUT_TOKENS, completionTokens: MAX_OUTPUT_TOKENS });
}
