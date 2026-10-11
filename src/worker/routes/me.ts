import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { POLICY } from "../policy/compiled.ts";

export const me = new Hono<AppEnv>();

/** GET /api/v1/me: the caller's opaque principal id, persona and purposes (humans only). */
me.get("/api/v1/me", (c) => {
  const p = c.get("principal");
  if (p.kind !== "human" || !p.persona) return c.json({ error: "forbidden", code: "human_only" }, 403);
  return c.json({ principalId: p.id, persona: p.persona, purposes: POLICY.personas[p.persona].purposes });
});
