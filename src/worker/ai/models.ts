// The three triage models (SPEC.md sections 16.3 and 30.3.6). Production: Workers AI through the AI binding and the
// AI Gateway `peoplevault` with `collectLog: false` and `skipCache: true`, so the gateway stores no prompt or answer
// (sample values come from quarantined exports and may hold identifiers). Local: llama-server (Qwen3-1.7B) on 8170
// through its OpenAI-compatible API, or a deterministic stub. Every call asks for at most 48 output tokens.
import type { Config } from "../env.ts";
import { ANSWER_SCHEMA, type Message } from "./prompt.ts";
import { LOCAL_MODEL, MAX_OUTPUT_TOKENS, PRODUCTION_MODEL, STUB_MODEL } from "./rates.ts";

export interface ModelReply {
  /** the answer: a JSON string, or an object when the runtime already parsed it */
  content: unknown;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface TriageModel {
  id: string;
  complete(messages: Message[]): Promise<ModelReply>;
  /** appended to the system prompt (Qwen3's switch that turns its thinking mode off) */
  systemSuffix?: string;
}

export class ModelUnavailable extends Error {
  override name = "ModelUnavailable";
}

function usageOf(u: unknown): ModelReply["usage"] {
  if (!u || typeof u !== "object") return null;
  const { prompt_tokens: p, completion_tokens: c } = u as { prompt_tokens?: unknown; completion_tokens?: unknown };
  return typeof p === "number" && typeof c === "number" ? { promptTokens: p, completionTokens: c } : null;
}

export function workersAiModel(ai: Ai, gatewayId: string): TriageModel {
  return {
    id: PRODUCTION_MODEL,
    async complete(messages) {
      const out = (await ai.run(
        PRODUCTION_MODEL,
        { messages, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0, response_format: { type: "json_schema", json_schema: ANSWER_SCHEMA } },
        { gateway: { id: gatewayId, collectLog: false, skipCache: true } },
      )) as unknown;
      if (typeof out === "string") return { content: out, usage: null };
      const o = (out ?? {}) as { response?: unknown; usage?: unknown };
      return { content: o.response ?? null, usage: usageOf(o.usage) };
    },
  };
}

export function llamaServerModel(url: string, fetchImpl: typeof fetch = fetch): TriageModel {
  return {
    id: LOCAL_MODEL,
    systemSuffix: "\n/no_think",
    async complete(messages) {
      let res: Response;
      try {
        res = await fetchImpl(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3",
            messages,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0,
            response_format: { type: "json_schema", json_schema: { name: "drift_class", schema: ANSWER_SCHEMA } },
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new ModelUnavailable("llama-server is not reachable (npm run llm:serve)");
      }
      if (!res.ok) throw new ModelUnavailable(`llama-server answered ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: unknown };
      return { content: body.choices?.[0]?.message?.content ?? null, usage: usageOf(body.usage) };
    },
  };
}

/** Deterministic and fail-closed: always the most sensitive class. It produces no reported eval number. */
export function stubModel(): TriageModel {
  return {
    id: STUB_MODEL,
    async complete(messages) {
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      return { content: '{"class":"direct_identifier"}', usage: { promptTokens: Math.ceil(chars / 4), completionTokens: 8 } };
    },
  };
}

export function modelFor(cfg: Config, env: { AI?: Ai }, fetchImpl?: typeof fetch): TriageModel {
  switch (cfg.ai.mode) {
    case "workers-ai":
      if (!env.AI || !cfg.ai.gatewayId) throw new ModelUnavailable("the AI binding or AI_GATEWAY_ID is missing");
      return workersAiModel(env.AI, cfg.ai.gatewayId);
    case "llama-server":
      return llamaServerModel(cfg.ai.llmUrl!, fetchImpl);
    case "stub":
      return stubModel();
  }
}
