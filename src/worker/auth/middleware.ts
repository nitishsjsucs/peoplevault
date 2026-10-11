// Authentication, CSRF header and request context (SPEC.md sections 11.1, 11.2, 11.5).
import type { MiddlewareHandler } from "hono";
import type { JSONWebKeySet } from "jose";
import type { AppEnv } from "../app.ts";
import { loadConfig, type Config } from "../env.ts";
import { AuthError, createAccessVerifier, type AccessVerifier } from "./access-verifier.ts";
import { PrincipalError, resolvePrincipal } from "./principals.ts";
import { extractToken } from "./token.ts";

export const CSRF_HEADER = "X-PV-Requested-With";
export const CSRF_VALUE = "peoplevault";

let cachedVerifier: { key: string; verifier: AccessVerifier } | null = null;

export function verifierFor(cfg: Config, fetchImpl?: typeof fetch): AccessVerifier {
  if (cfg.authMode === "access" && cfg.access) {
    const key = `access|${cfg.access.teamDomain}|${cfg.access.aud}|${fetchImpl ? "injected" : "global"}`;
    if (cachedVerifier?.key !== key) {
      const opts = fetchImpl ? { fetchImpl } : {};
      cachedVerifier = { key, verifier: createAccessVerifier({ mode: "access", teamDomain: cfg.access.teamDomain, aud: cfg.access.aud }, opts) };
    }
    return cachedVerifier.verifier;
  }
  if (!cfg.dev) throw new Error("local-jwks mode without dev config");
  const key = `local|${cfg.dev.issuer}|${cfg.dev.aud}|${cfg.dev.jwks}`;
  if (cachedVerifier?.key !== key) {
    const jwks = JSON.parse(cfg.dev.jwks) as JSONWebKeySet;
    cachedVerifier = { key, verifier: createAccessVerifier({ mode: "local-jwks", issuer: cfg.dev.issuer, aud: cfg.dev.aud, jwks }) };
  }
  return cachedVerifier.verifier;
}

/** Loads and validates config once per request and stores it on the context. */
export const withConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("cfg", loadConfig(c.env));
  await next();
};

export function authenticate(fetchImpl?: typeof fetch): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfg = c.get("cfg");
    const token = extractToken(c, cfg.authMode);
    try {
      if (!token) throw new AuthError("missing_token");
      const identity = await verifierFor(cfg, fetchImpl).verify(token);
      const principal = await resolvePrincipal(c.env.DB, identity);
      c.set("identity", identity);
      c.set("principal", principal);
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: "unauthenticated", code: err.code }, 401);
      if (err instanceof PrincipalError) return c.json({ error: "forbidden", code: err.code }, 403);
      throw err;
    }
    await next();
  };
}

/** Mutating routes and the POST identity lookup require X-PV-Requested-With: peoplevault (forces a CORS preflight). */
export const requireCsrfHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
    return c.json({ error: "forbidden", code: "csrf" }, 403);
  }
  await next();
};
