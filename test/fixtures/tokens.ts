// Test RS256 keys and a token factory for every verification branch (SPEC.md 11.1, authz category A).
import { SignJWT, base64url, importJWK, type JWK } from "jose";
import keys from "./test-keys.json";

export const DEV_ISSUER = "https://dev.peoplevault.test";
export const DEV_AUD = "peoplevault-local";
export const ACCESS_TEAM_DOMAIN = "https://pvtest.cloudflareaccess.com";
export const ACCESS_AUD = "test-access-aud-tag";

export const PRIMARY_PUBLIC_JWK = keys.primary.public as JWK;
export const PRIMARY_PRIVATE_JWK = keys.primary.private as JWK;
export const OTHER_PRIVATE_JWK = keys.other.private as JWK;
export const TEST_JWKS = { keys: [PRIMARY_PUBLIC_JWK] };

export interface TokenOptions {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  key?: "primary" | "other";
  kid?: string;
  sub?: string;
  claims?: Record<string, unknown>;
}

const now = () => Math.floor(Date.now() / 1000);

async function sign(claims: Record<string, unknown>, o: TokenOptions): Promise<string> {
  const jwk = o.key === "other" ? OTHER_PRIVATE_JWK : PRIMARY_PRIVATE_JWK;
  const key = await importJWK(jwk, "RS256");
  const t = now();
  return new SignJWT({ ...claims, ...o.claims })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? (o.key === "other" ? keys.other.kid : keys.primary.kid) })
    .setIssuer(o.iss ?? DEV_ISSUER)
    .setAudience(o.aud ?? [DEV_AUD])
    .setSubject(o.sub ?? "")
    .setIssuedAt(o.iat ?? t)
    .setNotBefore(o.nbf ?? t)
    .setExpirationTime(o.exp ?? t + 600)
    .sign(key);
}

export function userToken(email: string, o: TokenOptions = {}): Promise<string> {
  return sign({ email, type: "app" }, { sub: "user-" + email.length, ...o });
}

export function serviceToken(commonName: string, o: TokenOptions = {}): Promise<string> {
  return sign({ common_name: commonName }, { ...o, sub: "" });
}

export function algNoneToken(email: string): string {
  const header = base64url.encode(JSON.stringify({ alg: "none", typ: "JWT", kid: keys.primary.kid }));
  const t = now();
  const payload = base64url.encode(JSON.stringify({ iss: DEV_ISSUER, aud: [DEV_AUD], sub: "x", email, iat: t, nbf: t, exp: t + 600 }));
  return `${header}.${payload}.`;
}

/** HS256 token signed with the RSA public key bytes (algorithm confusion attack). */
export async function hs256ConfusionToken(email: string): Promise<string> {
  const secret = new TextEncoder().encode(JSON.stringify(PRIMARY_PUBLIC_JWK));
  const t = now();
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256", kid: keys.primary.kid })
    .setIssuer(DEV_ISSUER)
    .setAudience([DEV_AUD])
    .setSubject("x")
    .setIssuedAt(t)
    .setNotBefore(t)
    .setExpirationTime(t + 600)
    .sign(secret);
}

export const jwksResponse = () =>
  new Response(JSON.stringify({ keys: [PRIMARY_PUBLIC_JWK], public_cert: { kid: keys.primary.kid, cert: "recorded-fixture" } }), {
    headers: { "content-type": "application/json" },
  });
