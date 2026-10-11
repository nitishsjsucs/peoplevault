// Schema-drift triage (SPEC.md sections 16.3 and 30.3.6): rule classes, the prompt and output caps, the neuron meter
// that keeps a day within AI_DAILY_NEURONS, max_severity(rule, model), the Workers AI call through the gateway with
// no stored logs, llama-server's request, and the routes (which never return or audit a sample value).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { reserve, settle, usageOn } from "../../src/worker/ai/meter.ts";
import { llamaServerModel, ModelUnavailable, stubModel, workersAiModel, type TriageModel } from "../../src/worker/ai/models.ts";
import { ANSWER_SCHEMA, buildMessages, MAX_SAMPLE_CHARS, PromptTooLong } from "../../src/worker/ai/prompt.ts";
import { LOCAL_MODEL, MAX_OUTPUT_TOKENS, MAX_PROMPT_CHARS, neuronsFor, PRODUCTION_MODEL, RATES, worstCaseNeurons } from "../../src/worker/ai/rates.ts";
import { DATA_CLASSES, isSensitive, maxSeverity, ruleClass } from "../../src/worker/ai/rules.ts";
import { keyFromQuarantineId, sampleValues } from "../../src/worker/ai/samples.ts";
import { triage } from "../../src/worker/ai/triage.ts";
import { BASE, CSRF, seedWorld, tokenFor, worldApp } from "../fixtures/seed.ts";

beforeAll(seedWorld);

describe("rule classes and max_severity", () => {
  it.each([
    ["personal_mobile", [], "direct_identifier"],
    ["home_address_line1", [], "direct_identifier"],
    ["fld_17", ["ana.lima@example.test", "joao.reis@example.test", "x"], "direct_identifier"],
    ["contact", ["+1-555-0150", "+44 20 7946 0958"], "direct_identifier"],
    ["sick_days_ytd", [], "health_leave"],
    ["religion", [], "protected_attribute"],
    ["dob", [], "date_of_birth"],
    ["equity_grant_usd", [], "compensation"],
    ["manager_feedback", [], "performance"],
    ["tenure_band", [], "coarsened"],
    ["badge_hash", [], "direct_identifier"],
    ["vendor_key", [], "pseudonym"],
    ["cost_center", [], "job"],
    ["notes_2", ["2026-10-11", "2026-01-05"], null],
  ] as const)("%s -> %s", (column, samples, expected) => {
    expect(ruleClass(column, [...samples])).toBe(expected);
  });

  it("an ISO date is not a phone number", () => {
    expect(ruleClass("x", ["2026-10-11", "2025-01-01", "2024-12-31"])).toBeNull();
  });

  it("max_severity keeps the more sensitive class and ignores a missing one", () => {
    expect(maxSeverity("job", "health_leave")).toBe("health_leave");
    expect(maxSeverity("direct_identifier", "pseudonym")).toBe("direct_identifier");
    expect(maxSeverity(null, "coarsened")).toBe("coarsened");
    expect(maxSeverity(null, null)).toBeNull();
    expect(DATA_CLASSES).toHaveLength(9);
    expect(DATA_CLASSES.filter(isSensitive)).toEqual(["direct_identifier", "date_of_birth", "compensation", "performance", "health_leave", "protected_attribute"]);
  });
});

describe("caps and rates", () => {
  it("the worst case of one call on the production model is 25.8 neurons (600 input, 48 output tokens)", () => {
    expect(worstCaseNeurons(PRODUCTION_MODEL)).toBeCloseTo(25.83, 2);
    expect(neuronsFor(PRODUCTION_MODEL, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(RATES[PRODUCTION_MODEL]!.input);
    expect(worstCaseNeurons(LOCAL_MODEL)).toBe(0);
    expect(MAX_OUTPUT_TOKENS).toBe(48);
  });

  it("the largest legal input fits in 2,400 characters; a longer prompt is refused", () => {
    const longest = buildMessages("c".repeat(64), Array.from({ length: 9 }, () => "v".repeat(500)));
    expect(longest.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(longest[1]!.content).toContain(`"${"v".repeat(MAX_SAMPLE_CHARS)}"`);
    expect(longest[1]!.content).not.toContain("v".repeat(MAX_SAMPLE_CHARS + 1));
    expect(() => buildMessages("c", [], "x".repeat(MAX_PROMPT_CHARS))).toThrow(PromptTooLong);
  });
});

describe("neuron meter", () => {
  it("reservations never take a day past the cap, even when many race", async () => {
    const day = "2031-01-01";
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(env.DB, day, PRODUCTION_MODEL, 25.83, 100)));
    expect(results.filter(Boolean)).toHaveLength(3);
    const u = await usageOn(env.DB, day);
    expect(u.neurons).toBeLessThanOrEqual(100);
    expect(u.calls).toBe(3);
    await settle(env.DB, day, PRODUCTION_MODEL, -3 * 20);
    expect((await usageOn(env.DB, day)).neurons).toBeCloseTo(3 * 5.83, 2);
    expect(await reserve(env.DB, day, PRODUCTION_MODEL, 25.83, 100)).toBe(true);
    expect(await reserve(env.DB, "2031-01-02", PRODUCTION_MODEL, 25.83, null)).toBe(true);
  });
});

function fakeModel(answer: unknown, usage: { promptTokens: number; completionTokens: number } | null = { promptTokens: 300, completionTokens: 8 }, id = PRODUCTION_MODEL): TriageModel & { calls: number } {
  const m = {
    id,
    calls: 0,
    async complete() {
      m.calls++;
      if (answer instanceof Error) throw answer;
      return { content: answer, usage };
    },
  };
  return m;
}

describe("triage", () => {
  const at = (d: string) => new Date(`${d}T12:00:00Z`);

  it("the model can raise a column's class above the rule, never lower it", async () => {
    const up = await triage(env.DB, fakeModel('{"class":"health_leave"}'), null, "notes_2", ["recovering from surgery", "follow-up visit"], at("2031-02-01"));
    expect(up).toMatchObject({ ruleClass: null, modelClass: "health_leave", suggestedClass: "health_leave", sensitive: true, ai: { status: "ok" } });
    const down = await triage(env.DB, fakeModel({ class: "job" }), null, "personal_mobile", [], at("2031-02-01"));
    expect(down).toMatchObject({ ruleClass: "direct_identifier", modelClass: "job", suggestedClass: "direct_identifier", sensitive: true });
    expect(up.ai.neurons).toBeCloseTo(neuronsFor(PRODUCTION_MODEL, { promptTokens: 300, completionTokens: 8 }), 6);
  });

  it("an answer outside the schema is ignored, and its measured neurons still count", async () => {
    const r = await triage(env.DB, fakeModel("I think this is salary data", null), null, "cost_center", [], at("2031-02-02"));
    expect(r).toMatchObject({ modelClass: null, suggestedClass: "job", ai: { status: "invalid_output" } });
    expect(r.ai.usage!.estimated).toBe(true);
    expect((await usageOn(env.DB, "2031-02-02")).neurons).toBeCloseTo(r.ai.neurons, 6);
  });

  it("a failed call keeps its worst-case reservation; an unreachable local model says so", async () => {
    const r = await triage(env.DB, fakeModel(new Error("boom")), null, "cost_center", [], at("2031-02-03"));
    expect(r).toMatchObject({ suggestedClass: "job", ai: { status: "error" } });
    expect((await usageOn(env.DB, "2031-02-03")).neurons).toBeCloseTo(worstCaseNeurons(PRODUCTION_MODEL), 6);
    const u = await triage(env.DB, fakeModel(new ModelUnavailable("down"), null, LOCAL_MODEL), null, "cost_center", [], at("2031-02-03"));
    expect(u.ai.status).toBe("unavailable");
  });

  it("over the daily cap the model is not called and the suggestion is the rule class", async () => {
    const m = fakeModel('{"class":"performance"}');
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await triage(env.DB, m, 60, "manager_feedback", [], at("2031-02-04"))).ai.status);
    // 25.83 reserved per call, 9.64 measured: 4 calls fit under 60, the fifth would pass it
    expect(statuses).toEqual(["ok", "ok", "ok", "ok", "budget_exhausted", "budget_exhausted"]);
    expect(m.calls).toBe(4);
    expect((await usageOn(env.DB, "2031-02-04")).neurons).toBeLessThanOrEqual(60);
    const r = await triage(env.DB, m, 60, "manager_feedback", [], at("2031-02-04"));
    expect(r).toMatchObject({ modelClass: null, suggestedClass: "performance", ai: { status: "budget_exhausted", neurons: 0 } });
  });
});

describe("models", () => {
  it("Workers AI: the production model through the gateway with no stored logs and no cache, JSON schema, 48 tokens", async () => {
    const calls: unknown[][] = [];
    const ai = { run: async (...args: unknown[]) => (calls.push(args), { response: { class: "compensation" }, usage: { prompt_tokens: 310, completion_tokens: 9, total_tokens: 319 } }) } as unknown as Ai;
    const reply = await workersAiModel(ai, "peoplevault").complete(buildMessages("equity_grant_usd", ["12000"]));
    expect(reply).toEqual({ content: { class: "compensation" }, usage: { promptTokens: 310, completionTokens: 9 } });
    const [model, inputs, options] = calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(inputs).toMatchObject({ max_tokens: 48, temperature: 0, response_format: { type: "json_schema", json_schema: ANSWER_SCHEMA } });
    expect(options).toEqual({ gateway: { id: "peoplevault", collectLog: false, skipCache: true } });
    const asString = { run: async () => ({ response: '{"class":"job"}' }) } as unknown as Ai;
    expect(await workersAiModel(asString, "peoplevault").complete(buildMessages("x", []))).toEqual({ content: '{"class":"job"}', usage: null });
  });

  it("llama-server: the OpenAI-compatible route with the schema, 48 tokens and thinking off; unreachable is ModelUnavailable", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ choices: [{ message: { content: '{"class":"performance"}' } }], usage: { prompt_tokens: 280, completion_tokens: 7 } });
    }) as unknown as typeof fetch;
    const m = llamaServerModel("http://127.0.0.1:8170/", fetchImpl);
    expect(m.id).toBe(LOCAL_MODEL);
    expect(await m.complete(buildMessages("x", [], m.systemSuffix))).toEqual({ content: '{"class":"performance"}', usage: { promptTokens: 280, completionTokens: 7 } });
    expect(seen[0]!.url).toBe("http://127.0.0.1:8170/v1/chat/completions");
    expect(seen[0]!.body).toMatchObject({ max_tokens: 48, temperature: 0, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: { schema: ANSWER_SCHEMA } } });
    const down = llamaServerModel("http://127.0.0.1:8170", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(down.complete(buildMessages("x", []))).rejects.toBeInstanceOf(ModelUnavailable);
  });

  it("the stub is deterministic and fail-closed", async () => {
    expect(await stubModel().complete(buildMessages("anything", ["a"]))).toMatchObject({ content: '{"class":"direct_identifier"}' });
  });
});

describe("quarantined export samples", () => {
  it("maps a loader report id to its export key, and refuses anything else", () => {
    expect(keyFromQuarantineId("exports__hris__employees__dt=2026-09-28__employees.jsonl")).toBe("exports/hris/employees/dt=2026-09-28/employees.jsonl");
    expect(keyFromQuarantineId("exports__payroll__compensation__period=2026-09__compensation.csv")).toBe("exports/payroll/compensation/period=2026-09/compensation.csv");
    for (const bad of ["extracts__x__y__m=1__a.jsonl", "exports__..__x__a=1__b.jsonl", "exports/hris/employees/dt=2026-09-28/employees.jsonl"]) expect(keyFromQuarantineId(bad)).toBeNull();
  });

  it("takes at most 5 distinct non-empty values, from whole lines only, for JSONL and CSV", () => {
    const jsonl = [1, 2, 2, 3, 4, 5, 6, 7].map((i) => JSON.stringify({ employee_id: `E${i}`, shoe_size: i === 4 ? "" : String(i) })).join("\n");
    expect(sampleValues("a.jsonl", jsonl, true, "shoe_size")).toEqual(["1", "2", "3", "5", "6"]);
    expect(sampleValues("a.jsonl", jsonl, true, "missing")).toBeNull();
    expect(sampleValues("a.jsonl", '{"x":"1"}\n{"x":"2"}\n{"x":"3', false, "x")).toEqual(["1", "2"]);
    const csv = 'employee_id,note\nE1,"a, b"\nE2,"say ""hi"""\n';
    expect(sampleValues("a.csv", csv, true, "note")).toEqual(["a, b", 'say "hi"']);
  });
});

describe("routes", () => {
  const headers = async (principal: string) => ({ "Cf-Access-Jwt-Assertion": await tokenFor(principal), ...CSRF, "content-type": "application/json" });

  async function post(e: object, principal: string, path: string, body: unknown) {
    const { app } = worldApp();
    return app.request(`${BASE}${path}`, { method: "POST", headers: await headers(principal), body: JSON.stringify(body) }, e);
  }

  it("classify (stub locally): classes only in the response and the audit, never a sample value", async () => {
    const sample = "zq-sample-value-77";
    const res = await post(env, "privacy-01", "/api/v1/privacy/schema-drift/classify", { column: "fld_9", samples: [sample, "x"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ column: "fld_9", ruleClass: null, modelClass: "direct_identifier", suggestedClass: "direct_identifier", model: "stub", ai: { status: "ok" } });
    expect(JSON.stringify(body)).not.toContain(sample);
    const ev = await env.DB.prepare("SELECT * FROM audit_events WHERE action = 'triage_schema_drift' ORDER BY seq DESC LIMIT 1").first<Record<string, unknown>>();
    expect(ev).toMatchObject({ decision: "allow", reason: "ok", purpose: "privacy_compliance", route: "/api/v1/privacy/schema-drift/classify" });
    expect(JSON.stringify(ev)).not.toContain(sample);
  });

  it("only the privacy officer may triage; bodies are validated; the CSRF header is required", async () => {
    expect((await post(env, "hrbp-01", "/api/v1/privacy/schema-drift/classify", { column: "x", samples: [] })).status).toBe(403);
    expect((await post(env, "privacy-01", "/api/v1/privacy/schema-drift/classify", { column: "x", samples: ["1", "2", "3", "4", "5", "6"] })).status).toBe(400);
    expect((await post(env, "privacy-01", "/api/v1/privacy/schema-drift/classify", { column: "bad name!", samples: [] })).status).toBe(400);
    const { app } = worldApp();
    const res = await app.request(`${BASE}/api/v1/privacy/schema-drift/classify`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor("privacy-01"), "content-type": "application/json" }, body: "{}" }, env);
    expect(res.status).toBe(403);
  });

  it("production mode: Workers AI with the daily cap; over it the rule class alone, and the usage route reports the day", async () => {
    let calls = 0;
    const ai = { run: async () => (calls++, { response: '{"class":"performance"}', usage: { prompt_tokens: 300, completion_tokens: 8 } }) } as unknown as Ai;
    const prod = { ...env, AI: ai, AI_MODE: "workers-ai", AI_GATEWAY_ID: "peoplevault", AI_DAILY_NEURONS: "60" };
    await env.DB.prepare("DELETE FROM ai_usage").run();
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = (await (await post(prod, "privacy-01", "/api/v1/privacy/schema-drift/classify", { column: "manager_feedback", samples: [] })).json()) as { ai: { status: string }; suggestedClass: string; model: string };
      statuses.push(r.ai.status);
      expect(r).toMatchObject({ suggestedClass: "performance", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    }
    expect(statuses).toEqual(["ok", "ok", "ok", "ok", "budget_exhausted"]);
    expect(calls).toBe(4);
    const { app } = worldApp();
    const usage = (await (await app.request(`${BASE}/api/v1/privacy/schema-drift/usage`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("privacy-01") } }, prod)).json()) as Record<string, unknown>;
    expect(usage).toMatchObject({ calls: 4, cap: 60, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    expect(usage.neurons as number).toBeLessThanOrEqual(60);
    expect(usage.worstCasePerCall as number).toBeCloseTo(25.83, 2);
    // without the binding the route answers 503 instead of guessing
    expect((await post({ ...prod, AI: undefined }, "privacy-01", "/api/v1/privacy/schema-drift/classify", { column: "x", samples: [] })).status).toBe(503);
  });

  it("suggest: samples come from the quarantined export itself and stay out of the response", async () => {
    const key = "exports/hris/employees/dt=2026-10-04/employees.jsonl";
    const secret = "zq-shoe-77";
    await env.EXPORTS.put(key, [JSON.stringify({ employee_id: "E1", full_name: "A B", shoe_size: secret }), JSON.stringify({ employee_id: "E2", full_name: "C D", shoe_size: "41" })].join("\n") + "\n");
    const id = "exports__hris__employees__dt=2026-10-04__employees.jsonl";
    const ok = await post(env, "privacy-01", `/api/v1/privacy/schema-drift/${id}/suggest`, { column: "shoe_size" });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(JSON.parse(text)).toMatchObject({ column: "shoe_size", suggestedClass: "direct_identifier", model: "stub" });
    expect(text).not.toContain(secret);
    const known = await post(env, "privacy-01", `/api/v1/privacy/schema-drift/${id}/suggest`, { column: "full_name" });
    expect(known.status).toBe(409);
    expect(await known.json()).toMatchObject({ code: "column_already_classified", class: "direct_identifier" });
    expect((await post(env, "privacy-01", `/api/v1/privacy/schema-drift/${id}/suggest`, { column: "hat_size" })).status).toBe(404);
    expect((await post(env, "privacy-01", "/api/v1/privacy/schema-drift/exports__hris__employees__dt=2026-10-05__employees.jsonl/suggest", { column: "shoe_size" })).status).toBe(404);
    expect((await post(env, "privacy-01", "/api/v1/privacy/schema-drift/not-a-report/suggest", { column: "shoe_size" })).status).toBe(404);
    await env.EXPORTS.delete(key);
  });
});
