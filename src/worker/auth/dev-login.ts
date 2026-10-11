// Local-only routes: /dev/login, /dev/logout, /dev/principals (SPEC.md sections 6.4 and 11.5).
// They answer only when AUTH_MODE=local-jwks and only for loopback hostnames; otherwise 404.
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { SignJWT, importJWK, type JWK } from "jose";
import type { AppEnv } from "../app.ts";
import { loadConfig } from "../env.ts";
import { ACCESS_COOKIE } from "./token.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEV_TOKEN_TTL_SECONDS = 3600;

export const devRoutes = new Hono<AppEnv>();

devRoutes.use("/dev/*", async (c, next) => {
  const cfg = loadConfig(c.env);
  const host = new URL(c.req.url).hostname;
  if (cfg.authMode !== "local-jwks" || !LOOPBACK.has(host)) return c.json({ error: "not_found" }, 404);
  await next();
});

interface DevPrincipalRow {
  id: string;
  kind: "human" | "system";
  persona: string | null;
  email: string | null;
  service_client_id: string | null;
  status: string;
}

export async function mintDevToken(privateJwkJson: string, issuer: string, aud: string, p: { email?: string | null; serviceClientId?: string | null; subject: string }, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const jwk = JSON.parse(privateJwkJson) as JWK;
  const key = await importJWK(jwk, "RS256");
  const claims: Record<string, unknown> = p.serviceClientId ? { common_name: p.serviceClientId } : { email: p.email, type: "app" };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? "dev", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience([aud])
    .setSubject(p.serviceClientId ? "" : p.subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + DEV_TOKEN_TTL_SECONDS)
    .sign(key);
}

devRoutes.get("/dev/principals", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, kind, persona, status FROM principals ORDER BY id").all<{ id: string; kind: string; persona: string | null; status: string }>();
  return c.json({ principals: results });
});

devRoutes.get("/dev/login", async (c) => {
  const cfg = loadConfig(c.env);
  const id = c.req.query("principal") ?? "";
  if (!cfg.dev?.privateJwk) return c.json({ error: "dev_key_missing", fix: "npm run dev:keys" }, 503);
  const row = await c.env.DB.prepare("SELECT id, kind, persona, email, service_client_id, status FROM principals WHERE id = ?").bind(id).first<DevPrincipalRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const token = await mintDevToken(cfg.dev.privateJwk, cfg.dev.issuer, cfg.dev.aud, {
    email: row.email,
    serviceClientId: row.kind === "system" ? row.service_client_id : null,
    subject: `dev-${row.id}`,
  });
  setCookie(c, ACCESS_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: DEV_TOKEN_TTL_SECONDS });
  return c.json({ ok: true, principalId: row.id, persona: row.persona });
});

devRoutes.get("/dev/logout", (c) => {
  deleteCookie(c, ACCESS_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
