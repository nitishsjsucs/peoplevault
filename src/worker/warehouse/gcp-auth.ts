// Google credentials for the Worker (SPEC.md section 11.4). The Worker holds only the peoplevault-gateway key, whose sole
// permission is Token Creator on the five purpose service accounts: it signs an RS256 JWT bearer assertion for an
// access token, then calls iamcredentials generateAccessToken for the purpose SA (lifetime 300 s) and caches that
// purpose token for 4 minutes in module memory.
import { SignJWT, importPKCS8 } from "jose";
import { WarehouseError } from "./client.ts";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const PURPOSE_TOKEN_CACHE_MS = 4 * 60 * 1000;

interface GatewayKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

export interface GcpTokenSource {
  gatewayToken(): Promise<string>;
  purposeToken(serviceAccountEmail: string): Promise<string>;
}

const purposeCache = new Map<string, { token: string; until: number }>();

export function clearTokenCaches(): void {
  purposeCache.clear();
}

export async function signGatewayAssertion(key: GatewayKey, nowSeconds: number): Promise<string> {
  const pk = await importPKCS8(key.private_key, "RS256");
  return new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) })
    .setIssuer(key.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(pk);
}

export function createGcpTokenSource(gatewayKeyJson: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): GcpTokenSource {
  let key: GatewayKey;
  try {
    key = JSON.parse(gatewayKeyJson) as GatewayKey;
  } catch {
    throw new WarehouseError("gateway_key_invalid");
  }
  let gateway: { token: string; until: number } | null = null;

  async function gatewayToken(): Promise<string> {
    if (gateway && gateway.until > now()) return gateway.token;
    const assertion = await signGatewayAssertion(key, Math.floor(now() / 1000));
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!res.ok) throw new WarehouseError("gateway_token_failed", res.status >= 500);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    gateway = { token: body.access_token, until: now() + Math.max(0, body.expires_in - 60) * 1000 };
    return gateway.token;
  }

  async function purposeToken(sa: string): Promise<string> {
    const hit = purposeCache.get(sa);
    if (hit && hit.until > now()) return hit.token;
    const gt = await gatewayToken();
    const res = await fetchImpl(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateAccessToken`, {
      method: "POST",
      headers: { authorization: `Bearer ${gt}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: [SCOPE], lifetime: "300s" }),
    });
    if (!res.ok) throw new WarehouseError(res.status === 403 ? "impersonation_denied" : "purpose_token_failed", res.status >= 500);
    const body = (await res.json()) as { accessToken: string; expireTime: string };
    purposeCache.set(sa, { token: body.accessToken, until: now() + PURPOSE_TOKEN_CACHE_MS });
    return body.accessToken;
  }

  return { gatewayToken, purposeToken };
}
