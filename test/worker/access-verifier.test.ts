import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/worker/app.ts";
import { AuthError, createAccessVerifier } from "../../src/worker/auth/access-verifier.ts";
import {
  ACCESS_AUD,
  ACCESS_TEAM_DOMAIN,
  DEV_AUD,
  DEV_ISSUER,
  TEST_JWKS,
  algNoneToken,
  hs256ConfusionToken,
  jwksResponse,
  serviceToken,
  userToken,
} from "../fixtures/tokens.ts";

const local = createAccessVerifier({ mode: "local-jwks", issuer: DEV_ISSUER, aud: DEV_AUD, jwks: TEST_JWKS });
const t = () => Math.floor(Date.now() / 1000);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AuthError ? e.code : `unexpected:${String(e)}`;
  }
}

describe("local JWKS verification (every error code)", () => {
  it("accepts a valid user token", async () => {
    const id = await local.verify(await userToken("a@peoplevault.test"));
    expect(id).toMatchObject({ kind: "user", email: "a@peoplevault.test", iss: DEV_ISSUER });
  });
  it("accepts a service token (empty sub, common_name)", async () => {
    const id = await local.verify(await serviceToken("svc-client.access"));
    expect(id).toMatchObject({ kind: "service", sub: "", commonName: "svc-client.access" });
  });
  it.each([
    ["missing_token", async () => ""],
    ["expired", async () => userToken("a@peoplevault.test", { exp: t() - 120, iat: t() - 600, nbf: t() - 600 })],
    ["not_yet_valid", async () => userToken("a@peoplevault.test", { nbf: t() + 600, exp: t() + 1200 })],
    ["bad_audience", async () => userToken("a@peoplevault.test", { aud: ["someone-else"] })],
    ["bad_issuer", async () => userToken("a@peoplevault.test", { iss: "https://evil.example" })],
    ["bad_signature", async () => userToken("a@peoplevault.test", { key: "other", kid: "test-primary" })],
    ["unknown_kid", async () => userToken("a@peoplevault.test", { key: "other" })],
    ["bad_algorithm", async () => algNoneToken("a@peoplevault.test")],
    ["bad_algorithm", async () => hs256ConfusionToken("a@peoplevault.test")],
    ["malformed", async () => "not.a.jwt"],
    ["malformed", async () => "onlyonepart"],
  ])("rejects with %s", async (code, make) => {
    expect(await codeOf(local.verify(await make()))).toBe(code);
  });
  it("tolerates 30 seconds of clock skew, not more", async () => {
    expect(await codeOf(local.verify(await userToken("a@peoplevault.test", { exp: t() - 10, iat: t() - 600, nbf: t() - 600 })))).toBe("ok");
    expect(await codeOf(local.verify(await userToken("a@peoplevault.test", { exp: t() - 60, iat: t() - 600, nbf: t() - 600 })))).toBe("expired");
  });
  it("rejects a token that is neither a user nor a service identity", async () => {
    expect(await codeOf(local.verify(await serviceToken("")))).toBe("malformed");
  });
});

describe("remote JWKS (production mode)", () => {
  it("verifies against the team certs URL and fetches the JWKS once", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return jwksResponse();
    }) as typeof fetch;
    const remote = createAccessVerifier({ mode: "access", teamDomain: ACCESS_TEAM_DOMAIN, aud: ACCESS_AUD }, { fetchImpl });
    const tok = await userToken("a@peoplevault.test", { iss: ACCESS_TEAM_DOMAIN, aud: [ACCESS_AUD] });
    await remote.verify(tok);
    await remote.verify(tok);
    expect(urls).toEqual([`${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`]);
    expect(await codeOf(remote.verify(await userToken("a@peoplevault.test", { iss: DEV_ISSUER, aud: [ACCESS_AUD] })))).toBe("bad_issuer");
    expect(await codeOf(remote.verify(await userToken("a@peoplevault.test", { iss: ACCESS_TEAM_DOMAIN, aud: [DEV_AUD] })))).toBe("bad_audience");
  });
});

describe("through the app", () => {
  const seedPrincipal = async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, persona, email, org_units, status, created_at) VALUES ('privacy-01', 'human', 'privacy_officer', 'po@peoplevault.test', '[]', 'active', 'x')",
    ).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, persona, email, org_units, status, created_at) VALUES ('mgr-099', 'human', 'manager', 'off@peoplevault.test', '[]', 'disabled', 'x')",
    ).run();
  };

  it("local mode: header and the dev cookie both work; /api/v1/me returns the opaque id", async () => {
    await seedPrincipal();
    const app = buildApp();
    const tok = await userToken("po@peoplevault.test");
    const viaHeader = await app.request("http://127.0.0.1/api/v1/me", { headers: { "Cf-Access-Jwt-Assertion": tok } }, env);
    expect(await viaHeader.json()).toEqual({ principalId: "privacy-01", persona: "privacy_officer", purposes: ["privacy_compliance", "legal_hold_management"] });
    const viaCookie = await app.request("http://127.0.0.1/api/v1/me", { headers: { cookie: `CF_Authorization=${tok}` } }, env);
    expect(viaCookie.status).toBe(200);
  });

  it("unknown email is 403 unknown_principal; disabled principal is 403 principal_disabled; no token is 401", async () => {
    await seedPrincipal();
    const app = buildApp();
    const unknown = await app.request("http://127.0.0.1/api/v1/me", { headers: { "Cf-Access-Jwt-Assertion": await userToken("nobody@peoplevault.test") } }, env);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({ error: "forbidden", code: "unknown_principal" });
    const disabled = await app.request("http://127.0.0.1/api/v1/me", { headers: { "Cf-Access-Jwt-Assertion": await userToken("off@peoplevault.test") } }, env);
    expect(await disabled.json()).toEqual({ error: "forbidden", code: "principal_disabled" });
    const none = await app.request("http://127.0.0.1/api/v1/me", {}, env);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthenticated", code: "missing_token" });
  });

  it("access mode ignores the cookie and verifies against the team JWKS", async () => {
    await seedPrincipal();
    const fetchImpl = (async () => jwksResponse()) as typeof fetch;
    const app = buildApp({ accessFetch: fetchImpl });
    const prodEnv = { ...env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN, ACCESS_AUD, DEV_ACCESS_PRIVATE_JWK: "" };
    const tok = await userToken("po@peoplevault.test", { iss: ACCESS_TEAM_DOMAIN, aud: [ACCESS_AUD] });
    const viaCookie = await app.request("https://peoplevault.example.workers.dev/api/v1/me", { headers: { cookie: `CF_Authorization=${tok}` } }, prodEnv);
    expect(viaCookie.status).toBe(401);
    const viaHeader = await app.request("https://peoplevault.example.workers.dev/api/v1/me", { headers: { "Cf-Access-Jwt-Assertion": tok } }, prodEnv);
    expect(viaHeader.status).toBe(200);
    const devTok = await userToken("po@peoplevault.test");
    const wrongIssuer = await app.request("https://peoplevault.example.workers.dev/api/v1/me", { headers: { "Cf-Access-Jwt-Assertion": devTok } }, prodEnv);
    expect(await wrongIssuer.json()).toEqual({ error: "unauthenticated", code: "bad_issuer" });
  });
});
