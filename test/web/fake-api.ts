// A fake Worker API for console tests: routes keyed "METHOD /path" (or "METHOD /path?query" for an exact URL), every
// call recorded with its headers and parsed body. Unknown routes answer 404 like the Worker.
import { vi } from "vitest";
import type { Me, Persona, Purpose } from "../../src/web/api.ts";

export interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status: number;
  body: unknown;
}

export const reply = (status: number, body: unknown): Reply & { reply: true } => ({ reply: true, status, body });
const isReply = (v: unknown): v is Reply => typeof v === "object" && v !== null && "reply" in v;

type Handler = unknown | ((call: Call) => unknown);

export function fakeApi(routes: Record<string, Handler>): { calls: Call[] } {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const path = url.split("?")[0]!;
    const call: Call = { method, url, path, headers, body };
    calls.push(call);
    const key = [`${method} ${url}`, `${method} ${path}`].find((k) => k in routes);
    const handler = key ? routes[key] : reply(404, { error: "not_found" });
    const out = typeof handler === "function" ? (handler as (c: Call) => unknown)(call) : handler;
    const { status, body: resBody } = isReply(out) ? out : { status: 200, body: out };
    return new Response(JSON.stringify(resBody), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const PURPOSES: Record<Persona, Purpose[]> = {
  hr_partner: ["employee_relations"],
  manager: ["team_management"],
  people_analyst: ["workforce_analytics"],
  privacy_officer: ["privacy_compliance", "legal_hold_management"],
};

/** The routes of a signed-in local session as `persona`. */
export function signedIn(persona: Persona, id = "privacy-01"): Record<string, Handler> {
  const me: Me = { principalId: id, persona, purposes: PURPOSES[persona] };
  return {
    "GET /api/v1/me": me,
    "GET /dev/principals": { principals: [{ id, kind: "human", persona, status: "active" }] },
  };
}

export const REF = `er_${"a".repeat(26)}`;
export const REF2 = `er_${"b".repeat(26)}`;
export const SUBJECT = `sr_${"c".repeat(26)}`;
