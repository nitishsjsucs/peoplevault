import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import tokenResponse from "../fixtures/contracts/google.token.json";
import gatResponse from "../fixtures/contracts/iamcredentials.generateAccessToken.json";
import { PURPOSE_TOKEN_CACHE_MS, SCOPE, TOKEN_URL, clearTokenCaches, createGcpTokenSource } from "../../src/worker/warehouse/gcp-auth.ts";

const json = (f: { status: number; body: unknown }) => new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": "application/json" } });

async function gatewayKey() {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return JSON.stringify({ type: "service_account", client_email: "peoplevault-gateway@pv-test.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey), private_key_id: "kid-1", token_uri: TOKEN_URL });
}

describe("Google token contract (recorded responses)", () => {
  beforeEach(() => clearTokenCaches());

  it("signs a JWT bearer assertion for peoplevault-gateway, then generateAccessToken for the purpose SA with lifetime 300s", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let now = 1_790_000_000_000;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return String(url) === TOKEN_URL ? json(tokenResponse) : json(gatResponse);
    }) as typeof fetch;
    const src = createGcpTokenSource(await gatewayKey(), fetchImpl, () => now);
    const sa = "peoplevault-tm-reader@pv-test.iam.gserviceaccount.com";
    expect(await src.purposeToken(sa)).toBe("purpose-access-token-contract");
    expect(calls).toHaveLength(2);
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion")!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: "RS256", kid: "kid-1" });
    const claims = decodeJwt(assertion);
    expect(claims).toMatchObject({ iss: "peoplevault-gateway@pv-test.iam.gserviceaccount.com", aud: TOKEN_URL, scope: SCOPE });
    expect(claims.exp! - claims.iat!).toBe(3600);
    expect(calls[1]!.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateAccessToken`);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ scope: [SCOPE], lifetime: "300s" });
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer gateway-access-token-contract");

    // cached for 4 minutes: no new calls
    now += PURPOSE_TOKEN_CACHE_MS - 1000;
    await src.purposeToken(sa);
    expect(calls).toHaveLength(2);
    // after 4 minutes the purpose token is refreshed (gateway token still valid)
    now += 2000;
    await src.purposeToken(sa);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url).toContain(":generateAccessToken");
  });

  it("maps a 403 from generateAccessToken to impersonation_denied", async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url) === TOKEN_URL ? json(tokenResponse) : new Response("{}", { status: 403 })) as typeof fetch;
    const src = createGcpTokenSource(await gatewayKey(), fetchImpl);
    await expect(src.purposeToken("peoplevault-er-reader@pv-test.iam.gserviceaccount.com")).rejects.toMatchObject({ code: "impersonation_denied" });
  });
});
